import { cleanup, repo, tempDir } from './repo';
import { config, executed, Memento, FakeUri, workspace } from './fake-vscode';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { PresentRequest } from '../ipc';
import { setLog } from '../log';
import { initComments, Node, WorktreeNode } from '../model';
import { WorktreeDiffsProvider } from '../provider';
import { setStorageRoot } from '../snapshots';

after(cleanup);

setLog({ info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);
config.showPrComments = false; // no gh calls from these tests

const view = { visible: true, selection: [] as Node[], reveal: async () => undefined } as unknown as vscodeTypes.TreeView<Node>;

/** A repo whose checked-out feature branch is two commits ahead of main, with one uncommitted edit. */
async function setup() {
  const r = repo();
  r.git('checkout', '-q', '-b', 'feature');
  r.commit('one', { 'src/a.ts': 'a\n' });
  r.commit('two', { 'src/b.ts': 'b\n' });
  r.write('README.md', 'edited\n');
  setStorageRoot(tempDir());
  const state = new Memento();
  initComments(state as unknown as vscodeTypes.Memento, { createCommentThread: () => ({ dispose() {} }), dispose() {} } as unknown as vscodeTypes.CommentController);
  workspace.workspaceFolders = [{ uri: FakeUri.file(r.root), name: 'r', index: 0 }];
  const provider = new WorktreeDiffsProvider(state as unknown as vscodeTypes.Memento);
  await provider.refresh();
  const req = (extra: Partial<PresentRequest> = {}): PresentRequest => ({ cmd: 'present', commonDir: path.join(r.root, '.git'), worktree: r.root, ...extra });
  const opened = () => (provider as unknown as { opened: Map<string, { branches: WorktreeNode[] }> }).opened.get(path.join(r.root, '.git'))?.branches ?? [];
  const multiDiffTitles = () => executed.filter((e) => e.command === '_workbench.openMultiDiffEditor').map((e) => (e.args[0] as { title: string }).title);
  return { r, state, provider, req, opened, multiDiffTitles };
}

beforeEach(() => {
  executed.length = 0;
});

describe('present', () => {
  test("opens the worktree row's changes under its own comparison", async () => {
    const { provider, req, multiDiffTitles, opened } = await setup();
    const res = await provider.present(req(), view);
    assert.deepEqual(res, { ok: true, message: 'opened 3 files, vs main' });
    assert.deepEqual(multiDiffTitles(), ['feature (vs main)']);
    assert.equal(opened().length, 0);
  });

  test('a different comparison opens its own row and leaves the worktree row alone', async () => {
    const { r, state, provider, req, multiDiffTitles, opened } = await setup();
    await provider.present(req(), view);
    const res = await provider.present(req({ mode: 'uncommitted' }), view);
    assert.deepEqual(res, { ok: true, message: 'opened 1 file, uncommitted' });
    assert.equal(state.get(`mode:${r.root}`), undefined, "the worktree row's comparison is untouched");
    assert.equal(opened().length, 1);
    assert.equal(opened()[0].presentOf?.wt.path, r.root);
    assert.deepEqual(multiDiffTitles(), ['feature (vs main)', 'feature (uncommitted)']);
    assert.deepEqual(await provider.present(req(), view), { ok: true, message: 'opened 3 files, vs main' }, 'the row still shows its own comparison');
  });

  test('presenting the same comparison again reuses its row, refreshed', async () => {
    const { r, provider, req, opened } = await setup();
    await provider.present(req({ mode: 'uncommitted' }), view);
    r.write('src/new.ts', 'new\n');
    const res = await provider.present(req({ mode: 'uncommitted' }), view);
    assert.deepEqual(res, { ok: true, message: 'opened 2 files, uncommitted' });
    assert.equal(opened().length, 1);
  });

  test("a comparison matching the row's is shown on the row itself", async () => {
    const { provider, req, opened } = await setup();
    await provider.present(req({ mode: 'branch' }), view);
    assert.equal(opened().length, 0);
  });

  test("a presented row reads the worktree's working tree and commits", async () => {
    const { r, provider, req } = await setup();
    const res = await provider.present(req({ mode: `commit:${r.head('HEAD~1')}` }), view);
    assert.deepEqual(res, { ok: true, message: 'opened 2 files, last 1 commit' });
    const merged = await provider.present(req({ mode: 'base:refs/heads/main' }), view);
    assert.deepEqual(merged, { ok: true, message: 'opened 3 files, vs main' });
  });

  test('a branch row presented under another comparison gets its own row too', async () => {
    const { r, state, provider, req, opened } = await setup();
    r.git('branch', 'other', 'HEAD~1');
    await provider.refresh();
    const res = await provider.present(req({ ref: 'refs/heads/other', mode: `commit:${r.head('main')}` }), view);
    assert.deepEqual(res, { ok: true, message: 'opened 1 file, last 1 commit' });
    assert.equal(state.get('mode:ref:refs/heads/other'), undefined);
    assert.equal(opened().length, 1);
  });

  test('refuses an unknown row, uncommitted on a branch, and specs outside the comparison', async () => {
    const { r, provider, req } = await setup();
    assert.deepEqual(await provider.present(req({ worktree: '/nowhere' }), view), { ok: false, message: 'no row for /nowhere in the Crosscut tree' });
    assert.deepEqual(await provider.present(req({ ref: 'pr/9' }), view), {
      ok: false,
      message: '#9 is not under Open pull requests: it is not open, or its branch is not fetched',
    });
    r.git('branch', 'other');
    await provider.refresh();
    assert.deepEqual(await provider.present(req({ ref: 'refs/heads/other', mode: 'uncommitted' }), view), { ok: false, message: 'a branch has no uncommitted changes' });
    assert.deepEqual(await provider.present(req({ only: [{ path: 'nope.ts' }] }), view), { ok: false, message: 'not changed in vs main: nope.ts' });
  });

  test('narrows to files and folders, and opens one file with lines on its own', async () => {
    const { provider, req, multiDiffTitles } = await setup();
    assert.deepEqual(await provider.present(req({ only: [{ path: 'src' }] }), view), { ok: true, message: 'opened 2 files of 3, vs main' });
    assert.deepEqual(multiDiffTitles(), ['feature — 2 of 3 files (vs main)']);
    assert.deepEqual(await provider.present(req({ only: [{ path: 'src/a.ts', lines: [1, 1] }] }), view), { ok: true, message: 'opened src/a.ts, vs main' });
    assert.deepEqual(await provider.present(req({ open: { path: 'README.md' } }), view), { ok: true, message: 'opened README.md, vs main' });
    assert.ok(executed.filter((e) => e.command === 'vscode.diff').length >= 2);
    assert.deepEqual(await provider.present(req({ mark: [{ path: 'src/b.ts', lines: [1, 1] }] }), view), { ok: true, message: 'opened 3 files, vs main' });
  });

  test('opens a commit as its own row', async () => {
    const { r, provider, req, opened } = await setup();
    const [base, sha] = [r.head('HEAD~1'), r.head()];
    const commit = { id: `${base.slice(0, 10)}-${sha.slice(0, 10)}`, label: 'two', sha, base, when: 'now', author: 'Test Author' };
    assert.deepEqual(await provider.present(req({ commit }), view), { ok: true, message: 'opened 1 file, last 1 commit' });
    assert.equal(opened()[0].ref?.short, 'two');
  });
});

describe('presenting a repo the window does not show', () => {
  test('adds the repo to the tree, remembered, with a row of its own', async () => {
    const { state, provider, req } = await setup();
    const other = repo();
    other.write('README.md', 'other edit\n');
    const res = await provider.present(req({ commonDir: path.join(other.root, '.git'), worktree: other.root }), view);
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(state.get('addedRepos'), [other.root]);
    const rows = await provider.getChildren();
    assert.equal(rows.length, 2);
    const item = provider.getTreeItem(rows[1]) as vscodeTypes.TreeItem;
    assert.equal(item.contextValue, 'repo.added');
    assert.equal(item.description, 'added');
    assert.equal(provider.getTreeItem(rows[0]).contextValue, undefined, "the workspace's own repo cannot be removed");
  });

  test('keeps an added repo across a reload, and removes it on request', async () => {
    const { state, provider, req } = await setup();
    const other = repo();
    await provider.present(req({ commonDir: path.join(other.root, '.git'), worktree: other.root }), view);
    const reloaded = new WorktreeDiffsProvider(state as unknown as vscodeTypes.Memento);
    await reloaded.refresh();
    assert.equal((await reloaded.getChildren()).length, 2);
    await reloaded.removeRepo(path.join(other.root, '.git'));
    assert.deepEqual(state.get('addedRepos'), []);
    assert.ok(!reloaded.commonDirs().includes(path.join(other.root, '.git')));
  });

  test('a repo the workspace opens later stops counting as added', async () => {
    const { r, provider, req } = await setup();
    const other = repo();
    await provider.present(req({ commonDir: path.join(other.root, '.git'), worktree: other.root }), view);
    workspace.workspaceFolders = [{ uri: FakeUri.file(r.root), name: 'r', index: 0 }, { uri: FakeUri.file(other.root), name: 'o', index: 1 }];
    await provider.refresh();
    assert.equal(provider.isAdded(path.join(other.root, '.git')), false);
  });

  test('refuses a directory that is not a repository', async () => {
    const { provider, req } = await setup();
    const dir = tempDir();
    assert.deepEqual(await provider.present(req({ commonDir: path.join(dir, '.git'), worktree: dir }), view), { ok: false, message: `${dir} is not a git repository` });
  });
});

describe('presenting a folder with no git repo', () => {
  test("shows the folder's latest step as its own row, labeled by the folder", async () => {
    const { provider, req } = await setup();
    const dir = path.join(tempDir(), 'project');
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    process.env.XDG_CACHE_HOME = tempDir();
    const { snapshotFolder } = await import('../shadow');
    const snap = await snapshotFolder(dir);
    const commit = { id: 'shadow', label: 'project: all files', sha: snap.head, base: snap.base, when: 'just now', author: '', baseLabel: 'all files' };
    const shadowReq = req({ commonDir: snap.dir, worktree: dir, shadow: dir, commit });
    assert.deepEqual(await provider.present(shadowReq, view), { ok: true, message: 'opened 1 file, all files' });
    const rows = await provider.getChildren();
    const item = provider.getTreeItem(rows[1]) as vscodeTypes.TreeItem;
    assert.equal(item.label, 'project');
    assert.equal(item.description, 'no git repo');

    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    const next = await snapshotFolder(dir);
    const again = req({ commonDir: snap.dir, worktree: dir, shadow: dir, commit: { ...commit, sha: next.head, base: next.base, label: 'project: since the last present', baseLabel: 'since the last present' } });
    assert.deepEqual(await provider.present(again, view), { ok: true, message: 'opened 1 file, since the last present' });
    assert.deepEqual(await provider.present({ ...again, only: [{ path: 'b.txt' }] }, view), { ok: true, message: 'opened 1 file of 1, since the last present' });
  });
});
