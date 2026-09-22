import { cleanup, repo, tempDir } from './repo';
import { config, FakeUri, Memento, window, workspace } from './fake-vscode';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { setLog } from '../log';
import { BranchGroupNode, buildFileTree, drafts, FileNode, FolderNode, initComments, Node, RepoNode, SubmoduleNode, WorktreeNode } from '../model';
import { itemUri, shortLocation, WorktreeDiffsProvider } from '../provider';
import { setStorageRoot } from '../snapshots';

after(cleanup);
setLog({ info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);
config.showPrComments = false;

const revealed: Node[] = [];
const view = { visible: true, selection: [], reveal: async (n: Node) => void revealed.push(n) } as unknown as vscodeTypes.TreeView<Node>;
type Item = vscodeTypes.TreeItem & { label: string; description: string; tooltip: { value: string } | string; iconPath: { id: string } };

beforeEach(() => {
  revealed.length = 0;
  delete config.defaultMode;
});

/**
 * The main checkout on `feature` (two commits ahead of main, one edit), a linked worktree on
 * `side`, a local branch with no worktree, one whose upstream is gone, and a remote branch.
 */
async function setup() {
  const r = repo();
  r.git('checkout', '-q', '-b', 'feature');
  r.commit('one', { 'src/deep/a.ts': 'a\n' });
  r.commit('two', { 'src/b.ts': 'b\n' });
  r.write('README.md', 'edited\n');
  const side = path.join(tempDir(), 'side');
  r.git('worktree', 'add', '-q', '-b', 'side', side, 'main');
  r.git('branch', 'lonely', 'main');
  r.git('remote', 'add', 'origin', path.join(tempDir(), 'none.git'));
  r.git('update-ref', 'refs/remotes/origin/rem', 'main');
  r.git('update-ref', 'refs/remotes/origin/tracked', 'main');
  r.git('branch', 'tracked', 'main');
  r.git('config', 'branch.tracked.remote', 'origin');
  r.git('config', 'branch.tracked.merge', 'refs/heads/tracked');
  r.git('branch', 'gone', 'main');
  r.git('config', 'branch.gone.remote', 'origin');
  r.git('config', 'branch.gone.merge', 'refs/heads/gone');
  setStorageRoot(tempDir());
  const state = new Memento();
  initComments(state as unknown as vscodeTypes.Memento, { createCommentThread: () => ({ dispose() {} }), dispose() {} } as unknown as vscodeTypes.CommentController);
  workspace.workspaceFolders = [{ uri: FakeUri.file(r.root), name: 'r', index: 0 }];
  const provider = new WorktreeDiffsProvider(state as unknown as vscodeTypes.Memento);
  await provider.refresh();
  const top = await provider.getChildren();
  await provider.getChildren(top[0]); // wait for the load the refresh started
  const rows = top.filter((n): n is WorktreeNode => n instanceof WorktreeNode);
  const groups = top.filter((n): n is BranchGroupNode => n instanceof BranchGroupNode);
  const group = (kind: string) => groups.find((g) => g.kind === kind)!;
  const branch = (short: string) => groups.flatMap((g) => g.branches).find((b) => b.ref!.short === short)!;
  const item = (n: Node) => provider.getTreeItem(n) as Item;
  return { r, side, state, provider, top, rows, group, branch, item };
}

describe('tree structure', () => {
  test('one repo lists its worktrees, then local and remote branch groups', async () => {
    const { r, side, top, rows, group } = await setup();
    assert.deepEqual(rows.map((n) => n.wt.path), [r.root, side]);
    assert.equal(top.length, 4);
    assert.deepEqual(group('local').branches.map((b) => b.ref!.short).sort(), ['gone', 'lonely', 'main', 'tracked']);
    assert.deepEqual(group('remote').branches.map((b) => b.ref!.short).sort(), ['origin/rem', 'origin/tracked']);
  });

  test('a worktree row lists folders and files, and each child knows its parent', async () => {
    const { provider, rows } = await setup();
    const kids = await provider.getChildren(rows[0]);
    assert.deepEqual(kids.map((k) => (k instanceof FolderNode ? `${k.label}/` : (k as FileNode).change.path)), ['src/', 'README.md']);
    const src = kids[0] as FolderNode;
    const inner = await provider.getChildren(src);
    assert.deepEqual(inner.map((k) => (k instanceof FolderNode ? k.label : (k as FileNode).change.path)), ['deep', 'src/b.ts']);
    assert.equal(provider.getParent(inner[0]), src);
    assert.equal(provider.getParent(src), rows[0]);
    assert.equal(provider.getParent(rows[0]), undefined);
    assert.equal(await provider.getChildren(inner[1]).then((c) => c.length), 0);
  });

  test('a branch row is diffed on first expand and belongs to its group', async () => {
    const { provider, branch, group } = await setup();
    const lonely = branch('lonely');
    assert.equal(provider.getParent(lonely), group('local'));
    assert.deepEqual(await provider.getChildren(group('local')), group('local').branches);
    assert.deepEqual(await provider.getChildren(lonely), []);
    assert.equal(lonely.baseLabel, 'vs main');
  });

  test('two repos are listed as repo rows', async () => {
    const a = repo();
    const b = repo();
    setStorageRoot(tempDir());
    workspace.workspaceFolders = [a.root, b.root].map((p, index) => ({ uri: FakeUri.file(p), name: String(index), index }));
    const provider = new WorktreeDiffsProvider(new Memento() as unknown as vscodeTypes.Memento);
    await provider.refresh();
    const top = await provider.getChildren();
    assert.ok(top.every((n) => n instanceof RepoNode));
    assert.equal(top.length, 2);
    const [rn] = top as RepoNode[];
    assert.equal((await provider.getChildren(rn))[0], rn.worktrees[0]);
    assert.equal(provider.getParent(rn.worktrees[0]), rn);
    assert.equal(provider.getParent(rn), undefined);
    const item = provider.getTreeItem(rn) as Item;
    assert.equal(item.label, path.basename(path.dirname(rn.commonDir)));
    assert.equal(item.iconPath.id, 'repo');
    assert.deepEqual(provider.repoPaths().sort(), [a.root, b.root].sort());
  });
});

describe('getTreeItem', () => {
  test('group rows', async () => {
    const { item, group } = await setup();
    const local = item(group('local'));
    assert.deepEqual([local.label, local.description, local.contextValue, local.iconPath.id], ['Local branches (no worktree)', '4', 'locals', 'git-branch']);
    const remote = item(group('remote'));
    assert.deepEqual([remote.label, remote.contextValue, remote.iconPath.id], ['Remote branches', 'remotes', 'cloud']);
    const prs = item(new BranchGroupNode('prs', '/c', '/m'));
    assert.deepEqual([prs.label, prs.contextValue, prs.iconPath.id, prs.collapsibleState], ['Open pull requests', 'prs', 'git-pull-request', 1]);
    assert.match(prs.tooltip as string, /merge-base with the branch it actually targets/);
    const opened = item(new BranchGroupNode('opened', '/c', '/m'));
    assert.deepEqual([opened.label, opened.contextValue, opened.iconPath.id, opened.collapsibleState, opened.id], ['Opened commits & PRs', 'opened', 'history', 2, 'g:/c:opened']);
  });

  test('worktree rows show branch, count, comparison and location', async () => {
    const { r, provider, rows, item } = await setup();
    const main = item(rows[0]);
    assert.equal(main.label, path.basename(r.root));
    assert.equal(main.description, '⎇ feature · 3 files · vs main · main checkout');
    assert.equal(main.iconPath.id, 'pass-filled');
    assert.equal(main.contextValue, 'worktree.web');
    assert.match((main.tooltip as { value: string }).value, /\*\*feature\*\* — open in this window — main checkout/);
    assert.match((main.tooltip as { value: string }).value, /Compared against: vs main \(`[0-9a-f]{10}`\)/);
    const side = item(rows[1]);
    assert.equal(side.description, `⎇ side · branch · next to repo`.replace('next to repo', shortLocation(rows[1].wt.path, r.root)));
    assert.equal(side.iconPath.id, 'git-branch');
    provider.onExpand(rows[1]);
    assert.equal(item(rows[1]).collapsibleState, 2);
    provider.onCollapse(rows[1]);
    assert.equal(item(rows[1]).collapsibleState, 1);
  });

  test('a detached worktree, an error, a PR and drafts change the row', async () => {
    const { r, state, provider, rows, item } = await setup();
    r.git('-C', rows[1].wt.path, 'checkout', '-q', '--detach');
    await provider.refresh();
    assert.match(item(rows[1]).description, /^⎇ \(detached [0-9a-f]{7}\) · /);
    assert.equal(item(rows[1]).contextValue, 'worktree');
    await state.update(`mode:${rows[1].key}`, 'base:refs/heads/nope');
    await provider.getChildren(rows[1]);
    await provider.setMode(rows[1], 'base:refs/heads/nope');
    assert.equal(rows[1].error, 'refs/heads/nope not found');
    const bad = item(rows[1]);
    assert.equal(bad.description, '⎇ (detached ' + rows[1].wt.head.slice(0, 7) + ') · ⚠ refs/heads/nope not found');
    assert.equal(bad.iconPath.id, 'warning');
    rows[0].prNumber = 8;
    await drafts.add(rows[0], { path: 'a', line: 1, side: 'RIGHT', body: 'x' });
    assert.equal(item(rows[0]).contextValue, 'worktree.pr.drafts');
  });

  test('branch rows show push state, reviews and menus', async () => {
    const { provider, branch, item } = await setup();
    const lonely = item(branch('lonely'));
    assert.match(lonely.description, /^branch · .* · Test Author · ⬆ unpushed$/);
    assert.deepEqual([lonely.iconPath.id, lonely.contextValue, lonely.id], ['git-branch', 'branch.local', 'b:ref:refs/heads/lonely']);
    assert.match(item(branch('tracked')).description, / · in sync$/);
    assert.equal(item(branch('tracked')).contextValue, 'branch.local.web');
    assert.equal(item(branch('tracked')).iconPath.id, 'git-merge');
    const gone = item(branch('gone'));
    assert.match(gone.description, / · ⚠ upstream gone$/);
    assert.equal(gone.contextValue, 'branch.gone');
    const rem = item(branch('origin/rem'));
    assert.doesNotMatch(rem.description, /unpushed|sync/);
    assert.deepEqual([rem.iconPath.id, rem.contextValue], ['cloud', 'branch.web']);

    const b = branch('lonely');
    b.ref = { ...b.ref!, upstream: 'origin/lonely', track: 'ahead 2, behind 1' };
    b.reviews = [{ author: 'a', state: 'APPROVED', body: '', when: '', url: '' }];
    b.commentCounts.set('x.ts', 2).set('y.ts', 1);
    b.prNumber = 4;
    await provider.getChildren(b);
    assert.match(item(b).description, /^0 files · vs main · .* · ↑2 ↓1 · ✓ approved · 💬 3 in 2 files$/);
    assert.equal(item(b).contextValue, 'branch.local.web.pr');
    b.reviews.push({ author: 'c', state: 'CHANGES_REQUESTED', body: '', when: '', url: '' });
    await drafts.add(b, { path: 'a', line: 1, side: 'RIGHT', body: 'x' });
    assert.match(item(b).description, /✗ changes requested · 💬 3 in 2 files · ✎ 1 draft$/);
    assert.doesNotMatch(item(b).description, /approved/);
    assert.equal(item(b).contextValue, 'branch.local.web.pr.drafts');
    b.error = 'fatal: boom';
    assert.equal(item(b).description, '⚠ boom');
    assert.equal(item(b).iconPath.id, 'warning');
  });

  test('folder, file, untracked folder and submodule rows', async () => {
    const { r, provider, rows, item } = await setup();
    const [src, readme] = (await provider.getChildren(rows[0])) as [FolderNode, FileNode];
    rows[0].commentCounts.set('src/b.ts', 2);
    const f = item(src);
    assert.deepEqual([f.label, f.description, f.contextValue, f.collapsibleState, f.tooltip], ['src', '💬 2', 'group', 2, 'src']);
    assert.equal(f.resourceUri!.toString(), itemUri(path.join(r.root, 'src')).toString());
    const file = item(readme);
    assert.deepEqual([file.label, file.description, file.contextValue, file.iconPath.id], ['README.md', 'M', 'file', 'diff-modified']);
    assert.equal(file.tooltip, `Modified: ${path.join(r.root, 'README.md')}`);
    assert.deepEqual(file.command, { command: 'crosscut.openDiff', title: 'Open Diff', arguments: [readme] });
    const b = (src.children.find((c) => c instanceof FileNode) as FileNode);
    assert.deepEqual([item(b).description, item(b).contextValue, item(b).iconPath.id], ['A  💬 2', 'file.commented', 'diff-added']);

    const n = rows[0];
    const built = buildFileTree(n, {
      root: r.root, baseRef: 'B', changes: [
        { status: '?', path: 'new', untrackedDir: true },
        { status: 'D', path: 'gone.ts' },
        { status: 'R', path: 'to.ts', oldPath: 'from.ts' },
        { status: '?', path: 'u.ts' },
        { status: 'M', path: 'lib', sub: { root: path.join(r.root, 'lib'), baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40), changes: [{ status: 'M', path: 'x' }] } },
      ],
    }, n);
    const byName = (name: string) => built.map(item).find((i) => i.label === name)!;
    assert.deepEqual([byName('new/').description, byName('new/').iconPath.id], ['untracked folder', 'folder']);
    assert.equal(byName('gone.ts').iconPath.id, 'diff-removed');
    assert.equal(byName('to.ts').description, 'R  ← from.ts');
    assert.deepEqual([byName('u.ts').description, byName('u.ts').tooltip], ['U', `Untracked: ${path.join(r.root, 'u.ts')}`]);
    const sub = built.find((c) => c instanceof SubmoduleNode)!;
    const s = item(sub);
    assert.deepEqual([s.label, s.description, s.contextValue], ['lib', 'submodule · 1 file', 'group']);
    assert.match(s.tooltip as string, /Compared against aaaaaaaaaa .* up to bbbbbbbbbb/);
    assert.deepEqual(await provider.getChildren(sub), sub.children);
    assert.equal(provider.getParent(sub.children[0]), sub);
  });

  test('a file in a rebase preview shows its conflict', async () => {
    const { provider, rows, item } = await setup();
    const [, readme] = (await provider.getChildren(rows[0])) as [FolderNode, FileNode];
    rows[0].rebaseConflicts = new Map([['README.md', { path: 'README.md', commits: ['abc one', 'def two'] }]]);
    const i = item(readme);
    assert.equal(i.description, 'conflict · 2 commits');
    assert.equal(i.iconPath.id, 'warning');
    assert.match(i.tooltip as string, /^Conflicts when rebased, in:\n {2}abc one\n {2}def two/);
  });
});

describe('comparison modes', () => {
  test('modeFor honours the stored mode, the default setting, and branch rows', async () => {
    const { state, provider, rows, branch } = await setup();
    assert.equal(provider.modeFor(rows[0]), 'branch');
    config.defaultMode = 'uncommitted';
    assert.equal(provider.modeFor(rows[0]), 'uncommitted');
    assert.equal(provider.modeFor(branch('lonely')), 'branch');
    await state.update(`mode:${branch('lonely').key}`, 'uncommitted');
    assert.equal(provider.modeFor(branch('lonely')), 'branch', 'a branch has no working tree');
  });

  test('toggleMode flips a worktree between branch and uncommitted, and leaves branch rows alone', async () => {
    const { state, provider, rows, branch } = await setup();
    await provider.toggleMode(rows[0]);
    assert.equal(state.get(`mode:${rows[0].key}`), 'uncommitted');
    assert.equal(rows[0].baseLabel, 'uncommitted');
    assert.equal(rows[0].tree.length, 1);
    await provider.toggleMode(rows[0]);
    assert.equal(state.get(`mode:${rows[0].key}`), 'branch');
    await provider.toggleMode(branch('lonely'));
    assert.equal(state.get(`mode:${branch('lonely').key}`), undefined);
  });

  test('setMode to the last commits relabels the row', async () => {
    const { r, provider, rows } = await setup();
    await provider.setMode(rows[0], `commit:${r.head('HEAD~1')}`);
    assert.equal(rows[0].baseLabel, 'last 1 commit');
  });

  test('pickBase offers the comparisons and applies the one picked', async () => {
    const { state, provider, rows } = await setup();
    let offered: { label: string; mode: string }[] = [];
    window.showQuickPick = (async (items: typeof offered) => {
      offered = items;
      return items.find((i) => i.mode === 'uncommitted');
    }) as never;
    await provider.pickBase(rows[0]);
    assert.deepEqual(offered.map((i) => i.label.replace(/\$\([^)]+\) /, '')), [
      'Rebase preview onto…', 'Whole branch  $(check)', 'Uncommitted changes', 'Last 1 commit', 'Last 2 commits',
    ]);
    assert.equal(state.get(`mode:${rows[0].key}`), 'uncommitted');
    window.showQuickPick = (async () => undefined) as never;
    await provider.pickBase(rows[0]);
    assert.equal(state.get(`mode:${rows[0].key}`), 'uncommitted', 'dismissing changes nothing');
  });

  test('pickBase with a rebase preview asks for the target branch', async () => {
    const { state, provider, rows } = await setup();
    const calls: { label: string; ref?: string; mode?: string }[][] = [];
    window.showQuickPick = (async (items: { label: string; ref?: string; mode?: string }[]) => {
      calls.push(items);
      return calls.length === 1 ? items[0] : undefined;
    }) as never;
    await provider.pickBase(rows[0]);
    assert.equal(calls[1][0].label, 'Branches');
    assert.ok(calls[1].some((i) => i.ref === 'refs/heads/lonely'));
    assert.ok(calls[1].some((i) => i.ref === 'refs/remotes/origin/rem' && i.label.startsWith('$(cloud)')));
    assert.ok(!calls[1].some((i) => i.ref === 'refs/heads/feature'), 'the branch itself is not a target');
    assert.equal(state.get(`mode:${rows[0].key}`), undefined, 'dismissing the target changes nothing');
    window.showQuickPick = (async () => undefined) as never;
  });
});

describe('ad-hoc rows', () => {
  test('openAdHoc adds a commit row under Opened, reuses it, and closeAdHoc removes it', async () => {
    const { r, state, provider, top } = await setup();
    const sha = r.head();
    const entry = { id: 'pr-12', label: '#12 thing', sha, base: r.head('main'), when: 'now', author: 'me' };
    await provider.openAdHoc(r.root, entry, view, 'https://gh/12');
    const now = await provider.getChildren();
    const opened = now[0] as BranchGroupNode;
    assert.equal(opened.kind, 'opened');
    assert.equal(now.length, top.length + 1);
    const node = opened.branches[0];
    assert.deepEqual([node.prNumber, node.webUrl, revealed[0]], [12, 'https://gh/12', node]);
    assert.equal(state.get(`mode:${node.key}`), `commit:${r.head('main')}`);
    const i = provider.getTreeItem(node) as Item;
    assert.deepEqual([i.iconPath.id, i.contextValue, i.collapsibleState], ['git-pull-request', 'branch.adhoc.web.pr', 2]);
    await provider.openAdHoc(r.root, { ...entry, id: 'c1', label: 'commit' }, view);
    assert.equal(opened.branches.length, 2);
    assert.equal((provider.getTreeItem(opened.branches[0]) as Item).iconPath.id, 'git-commit');
    await provider.openAdHoc(r.root, entry, view);
    assert.equal(opened.branches.length, 2);
    await provider.refresh();
    assert.equal(((await provider.getChildren())[0] as BranchGroupNode).branches.length, 2, 'a refresh keeps opened rows');
    provider.closeAdHoc(node);
    assert.deepEqual(opened.branches.map((b) => b.ref!.short), ['commit']);
    await provider.getChildren(opened.branches[0]);
    assert.equal(opened.branches[0].baseLabel, 'last 2 commits');
    provider.dispose();
  });
});
