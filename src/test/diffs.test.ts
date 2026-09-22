import { cleanup, repo, tempDir } from './repo';
import { executed, FakeUri, window } from './fake-vscode';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { allChanges, compareWithCurrent, goToFileInAll, openAll, openInAll, updateAllChangesContext, collectFiles, descChanged, descriptions, diffSides, highlightPresented, openDiff, presentedDecoration, presentedLines, showDescription } from '../diffs';
import { loadDiff, loadRefDiff, RepoDiff } from '../git';
import { setLog } from '../log';
import { buildFileTree, FileNode, WorktreeNode } from '../model';
import { RefContentProvider, SCHEME, setStorageRoot, sideUri, snapshot, snapshotDir, snapshotsReady } from '../snapshots';

after(cleanup);
const errors: string[] = [];
setLog({ info() {}, warn() {}, error: (m: string) => errors.push(m), debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);

beforeEach(() => {
  executed.length = 0;
});

/** main has a, b, c; the branch modifies a, deletes b, adds d, renames c to e; the tree adds untracked u. */
async function setup(branch: boolean) {
  const r = repo();
  r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\nc\nc\nc\n' });
  const base = r.head();
  r.git('checkout', '-q', '-b', 'feat');
  r.write('a.txt', 'a2\n').rm('b.txt').write('d.txt', 'd\n');
  r.git('mv', 'c.txt', 'e.txt');
  r.commit('change');
  r.write('u.txt', 'u\n');
  const store = tempDir();
  setStorageRoot(path.dirname(store));
  const node = new WorktreeNode({ path: r.root, head: r.head(), branch: 'feat', isMain: true } as never, true, {}, store);
  const diff: RepoDiff = branch ? await loadRefDiff(r.root, base, r.head()) : await loadDiff(r.root, base);
  node.diff = diff;
  node.baseLabel = 'vs main';
  node.tree = buildFileTree(node, diff, node);
  const file = (p: string) => collectFiles(node.tree).find((f) => f.change.path === p)!;
  return { r, base, store, node, diff, file };
}

const settle = async (store: string, diff: RepoDiff) => {
  for (const ref of [diff.baseRef, diff.headRef].filter(Boolean) as string[]) await snapshotsReady.get(snapshotDir(store, diff, ref));
};

describe('snapshot', () => {
  test('writes the base side read-only, and the head side for a branch diff', async () => {
    const { store, diff, base, r } = await setup(true);
    snapshot(store, diff);
    await settle(store, diff);
    const left = snapshotDir(store, diff);
    assert.deepEqual(readdirSync(left).sort(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(readFileSync(path.join(left, 'a.txt'), 'utf8'), 'a\n');
    assert.equal(statSync(path.join(left, 'a.txt')).mode & 0o777, 0o444);
    assert.deepEqual(readdirSync(snapshotDir(store, diff, r.head())).sort(), ['a.txt', 'd.txt', 'e.txt']);
    assert.equal(path.basename(left), base);
  });
  test('prunes snapshots of older bases', async () => {
    const { store, diff } = await setup(false);
    const old = { ...diff, baseRef: 'HEAD~0' };
    snapshot(store, old);
    await settle(store, old);
    assert.ok(existsSync(snapshotDir(store, old)));
    snapshot(store, diff);
    await settle(store, diff);
    assert.equal(existsSync(snapshotDir(store, old)), false);
    assert.ok(existsSync(snapshotDir(store, diff)));
  });
});

describe('sideUri', () => {
  test('a written snapshot is a file, else a git document at the real path', async () => {
    const { store, diff, base, r } = await setup(false);
    const before = await sideUri(store, diff, base, 'a.txt');
    assert.equal(before.scheme, SCHEME);
    assert.equal(before.path, path.join(r.root, 'a.txt'));
    assert.deepEqual(JSON.parse(before.query), { cwd: r.root, ref: base, rel: 'a.txt' });
    snapshot(store, diff);
    const after = await sideUri(store, diff, base, 'a.txt');
    assert.equal(after.scheme, 'file');
    assert.equal(after.fsPath, path.join(snapshotDir(store, diff), 'a.txt'));
  });
});

describe('RefContentProvider', () => {
  test('reads a file at a ref, empty for an absent side or a bad query', async () => {
    const { base, r } = await setup(false);
    const p = new RefContentProvider();
    const uri = (q: string) => FakeUri.from({ scheme: SCHEME, path: '/x', query: q }) as never;
    assert.equal(await p.provideTextDocumentContent(uri(JSON.stringify({ cwd: r.root, ref: base, rel: 'b.txt' }))), 'b\n');
    assert.equal(await p.provideTextDocumentContent(uri(JSON.stringify({ cwd: r.root, ref: '', rel: 'b.txt' }))), '');
    assert.equal(await p.provideTextDocumentContent(uri('{nope')), '');
    assert.match(errors.at(-1)!, /bad content uri query/);
  });
});

describe('diffSides', () => {
  const q = (u: vscodeTypes.Uri) => JSON.parse(u.query);
  test('a worktree diff puts the real file on the right', async () => {
    const { file, base, r } = await setup(false);
    const m = await diffSides(file('a.txt'));
    assert.equal(q(m.left).ref, base);
    assert.equal(m.right.scheme, 'file');
    assert.equal(m.right.fsPath, path.join(r.root, 'a.txt'));
    const u = await diffSides(file('u.txt'));
    assert.equal(q(u.left).ref, '');
    assert.equal(u.right.fsPath, path.join(r.root, 'u.txt'));
    const d = await diffSides(file('b.txt'));
    assert.equal(q(d.left).rel, 'b.txt');
    assert.equal(q(d.right).ref, '');
  });
  test('a branch diff reads both sides from commits, a rename from its old path', async () => {
    const { file, base, r } = await setup(true);
    const a = await diffSides(file('d.txt'));
    assert.equal(q(a.left).ref, '');
    assert.equal(q(a.right).ref, r.head());
    const ren = await diffSides(file('e.txt'));
    assert.deepEqual([q(ren.left).rel, q(ren.left).ref], ['c.txt', base]);
    assert.equal(q(ren.right).rel, 'e.txt');
  });
  test('openDiff titles the editor by branch and comparison', async () => {
    const { file } = await setup(false);
    await openDiff(file('a.txt'), { preview: false });
    const [call] = executed;
    assert.equal(call.command, 'vscode.diff');
    assert.equal(call.args[2], 'a.txt [feat: vs main]');
    assert.deepEqual(call.args[3], { preview: false });
  });
});

describe('collectFiles', () => {
  test('flattens folders and submodules, skipping gitlinks and untracked folders', () => {
    const node = new WorktreeNode({ path: '/r' } as never, false, {}, '');
    const tree = buildFileTree(node, {
      root: '/r', baseRef: 'B', changes: [
        { status: 'M', path: 'd/x.ts' }, { status: 'M', path: 'g', gitlink: true }, { status: '?', path: 'new', untrackedDir: true },
        { status: 'M', path: 'lib', sub: { root: '/r/lib', baseRef: 'S', changes: [{ status: 'A', path: 'y.ts' }] } },
      ],
    }, node);
    assert.deepEqual(collectFiles(tree).map((f: FileNode) => f.absPath), ['/r/d/x.ts', '/r/lib/y.ts']);
  });
});

describe('highlightPresented', () => {
  test('decorates visible editors showing a presented file', () => {
    const set: unknown[][] = [];
    const ed = (uri: string) => ({ document: { uri: { toString: () => uri } }, setDecorations: (d: unknown, r: unknown) => set.push([uri, d, r]) });
    window.visibleTextEditors = [ed('file:///a'), ed('file:///b')];
    const ranges = [{ start: 1 }] as never;
    presentedLines.set('file:///a', ranges);
    highlightPresented();
    assert.equal(set.length, 1);
    assert.deepEqual(set[0], ['file:///a', presentedDecoration, ranges]);
    window.visibleTextEditors = [];
  });
});

describe('showDescription', () => {
  test('builds a PR document and opens it in the markdown preview', async () => {
    const r = repo();
    const node = new WorktreeNode({ path: r.root, head: '', branch: 'feat' } as never, false, {}, '');
    node.details = { number: 3, title: 'T', body: 'See #1', author: 'a', state: 'OPEN', draft: false, merged: false, baseRef: 'main', headRef: 'feat', additions: 1, deletions: 0, changedFiles: 1, url: 'u' };
    node.reviews = [{ author: 'rv', state: 'COMMENTED', body: '', when: '', url: '' }];
    await showDescription(node);
    assert.equal(executed[0].command, 'markdown.showPreview');
    const uri = String(executed[0].args[0]);
    assert.match(uri, /^crosscut-desc:\/\/\/PR-3\.md$/);
    const text = descriptions.get(uri)!;
    assert.match(text, /^# #3 T/);
    assert.match(text, /\*\*open\*\* · opened by a/);
    assert.match(text, /See #1/, 'no GitHub remote, so nothing is linkified');
    assert.match(text, /## rv — commented\n\n_\(no summary\)_/);
  });
  test('a branch and a worktree get their own documents', async () => {
    const r = repo();
    const b = new WorktreeNode({ path: r.root } as never, false, {}, '');
    b.ref = { ref: 'refs/heads/a/b', short: 'a/b', sha: 'abc', when: 'now', author: 'me', remote: false };
    b.message = 'subject';
    await showDescription(b);
    const w = new WorktreeNode({ path: r.root, branch: undefined } as never, false, {}, '');
    await showDescription(w);
    const [bu, wu] = executed.map((e) => String(e.args[0]));
    assert.match(bu, /a-b\.md$/);
    assert.match(descriptions.get(bu)!, /# a\/b\n\n`abc` · now · me[\s\S]*## Commit message\n\n```\n\nsubject\n\n```/);
    assert.match(wu, /worktree\.md$/);
    assert.match(descriptions.get(wu)!, new RegExp(`# ${path.basename(r.root)}`));
    assert.ok(descChanged);
  });
});

describe('openAll', () => {
  const multi = () => executed.filter((e) => e.command === '_workbench.openMultiDiffEditor').map((e) => e.args[0] as { title: string; resources: unknown[]; reveal?: { modifiedUri: vscodeTypes.Uri } });
  test('opens every file of a row, commented files first, and replaces its stale editor', async () => {
    const { node, file } = await setup(false);
    node.commentCounts.set('d.txt', 1);
    await openAll(node);
    const [first] = multi();
    assert.equal(first.title, 'feat (vs main)');
    assert.equal(first.resources.length, 5);
    const all = allChanges.get('feat (vs main)')!;
    assert.equal(all.files[0].rel, 'd.txt');
    const closed: unknown[] = [];
    window.tabGroups.all = [{ tabs: [{ label: 'feat (vs main)' }] }];
    window.tabGroups.close = (async (tabs: unknown[]) => (closed.push(...tabs), true)) as never;
    node.baseLabel = 'uncommitted';
    await openInAll(file('a.txt'));
    assert.equal(closed.length, 1);
    assert.equal(allChanges.has('feat (vs main)'), false);
    assert.equal(multi()[1].reveal!.modifiedUri.fsPath, file('a.txt').absPath);
    window.tabGroups.all = [];
  });
  test('a subset gets its own title, and nothing opens for no files', async () => {
    const { node, file } = await setup(false);
    await openAll(node, undefined, { only: [file('a.txt')] });
    assert.equal(multi()[0].title, 'feat — 1 of 5 files (vs main)');
    await openAll(node, undefined, { only: [] });
    assert.equal(multi().length, 1);
  });
  test('goToFileInAll reveals the picked file in the active editor', async () => {
    const { node, file } = await setup(false);
    await openAll(node);
    window.tabGroups.activeTabGroup.activeTab = { label: 'feat (vs main)' };
    updateAllChangesContext();
    assert.deepEqual(executed.at(-1), { command: 'setContext', args: ['crosscut.allChangesActive', true] });
    let offered: { label: string; description: string }[] = [];
    window.showQuickPick = (async (items: typeof offered) => ((offered = items), items.find((i) => i.label === 'a.txt'))) as never;
    await goToFileInAll();
    assert.ok(offered.some((i) => i.label === 'a.txt' && i.description.startsWith('M')));
    assert.equal(multi().at(-1)!.reveal!.modifiedUri.fsPath, file('a.txt').absPath);
    window.tabGroups.activeTabGroup.activeTab = undefined;
    window.showQuickPick = (async () => undefined) as never;
  });
});

describe('compareWithCurrent', () => {
  test('diffs the open worktree against the row, or warns without one', async () => {
    const { node, file, r } = await setup(true);
    const warned: string[] = [];
    window.showWarningMessage = (async (m: string) => void warned.push(m)) as never;
    await compareWithCurrent(file('a.txt'));
    assert.deepEqual(warned, ['No worktree of this repository is open in this window.']);
    node.repo.current = { path: '/other', head: '', branch: 'mine' } as never;
    await compareWithCurrent(file('a.txt'));
    const [mine, theirs, title] = executed.at(-1)!.args as [vscodeTypes.Uri, vscodeTypes.Uri, string];
    assert.equal(mine.fsPath, '/other/a.txt');
    assert.equal(JSON.parse(theirs.query).ref, r.head());
    assert.equal(title, 'a.txt (mine ↔ feat)');
  });
});
