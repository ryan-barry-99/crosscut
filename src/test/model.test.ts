import { cleanup, tempDir } from './repo';
import { FakeUri, Memento } from './fake-vscode';
import { after, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { ReviewComment } from '../gh';
import { Change, RepoDiff } from '../git';
import { setLog } from '../log';
import {
  BranchGroupNode, buildFileTree, drafts, Drafts, FileNode, FolderNode, initComments, nodeName, ownerOfDocument, RepoNode, storeOwners, SubmoduleNode, threadsFor, WorktreeNode,
} from '../model';
import { setStorageRoot, snapshotDir } from '../snapshots';

after(cleanup);
setLog({ info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);

interface FakeThread { uri: { fsPath: string }; range: { start: { line: number }; end: { line: number } }; comments: { author: { name: string }; label: string }[]; disposed?: boolean; label?: string; contextValue?: string; canReply?: boolean; dispose(): void }
const threads: FakeThread[] = [];
const controller = {
  createCommentThread: (uri: { fsPath: string }, range: FakeThread['range'], comments: FakeThread['comments']) => {
    const t: FakeThread = { uri, range, comments, dispose() { t.disposed = true; } };
    threads.push(t);
    return t;
  },
  dispose() {},
};
const state = new Memento();
initComments(state as unknown as vscodeTypes.Memento, controller as unknown as vscodeTypes.CommentController);

const row = (store = '/store') => new WorktreeNode({ path: '/r', head: 'h', branch: 'feat', isMain: true } as never, true, {}, store);
const change = (p: string, extra: Partial<Change> = {}): Change => ({ status: 'M', path: p, ...extra });
const comment = (over: Partial<ReviewComment>): ReviewComment => ({ id: 1, path: 'a.ts', line: 3, side: 'RIGHT', body: 'hm', author: 'ann', when: '2024-01-01T00:00:00Z', url: '', ...over });

describe('buildFileTree', () => {
  test('puts folders first, sorted, and compacts single-child chains', () => {
    const n = row();
    const diff: RepoDiff = { root: '/r', baseRef: 'B', changes: [change('z.ts'), change('a/b/c/d.ts'), change('a/b/c/e.ts'), change('m/x.ts'), change('m/n/y.ts'), change('b.ts')] };
    const tree = buildFileTree(n, diff, n);
    const shape = (c: typeof tree): unknown[] => c.map((x) => (x instanceof FolderNode ? { [x.label]: shape(x.children) } : x instanceof FileNode ? x.change.path : '?'));
    assert.deepEqual(shape(tree), [{ 'a/b/c': ['a/b/c/d.ts', 'a/b/c/e.ts'] }, { m: [{ n: ['m/n/y.ts'] }, 'm/x.ts'] }, 'b.ts', 'z.ts']);
    const m = tree[1] as FolderNode;
    assert.equal((m.children[0] as FolderNode).rel, 'm/n');
    assert.equal((m.children[0] as FolderNode).parent, m);
    assert.equal((tree[2] as FileNode).absPath, path.join('/r', 'b.ts'));
  });
  test('a submodule change becomes a node with its own tree', () => {
    const n = row();
    const sub: RepoDiff = { root: '/r/lib', baseRef: 'S', changes: [change('in.ts')] };
    const [s] = buildFileTree(n, { root: '/r', baseRef: 'B', changes: [change('lib', { sub })] }, n);
    assert.ok(s instanceof SubmoduleNode);
    assert.equal((s.children[0] as FileNode).absPath, path.join('/r/lib', 'in.ts'));
  });
});

describe('nodeName', () => {
  test('names every kind of node', () => {
    const n = row();
    const [folder, file] = buildFileTree(n, { root: '/r', baseRef: 'B', changes: [change('d/x.ts'), change('y.ts')] }, n);
    const [sub] = buildFileTree(n, { root: '/r', baseRef: 'B', changes: [change('lib', { sub: { root: '/r/lib', baseRef: 'S', changes: [] } })] }, n);
    const b = row();
    b.ref = { ref: 'refs/heads/x', short: 'x', sha: '', when: '', author: '', remote: false };
    const detached = new WorktreeNode({ path: '/w', head: 'h', isMain: false } as never, false, {}, '');
    assert.deepEqual(
      [undefined, new RepoNode('/r/.git', [], []), new BranchGroupNode('local', '/r/.git', '/r'), n, b, detached, folder, file, sub].map(nodeName),
      ['<root>', 'repo /r/.git', 'branches local', 'worktree feat', 'branch x', 'worktree /w', 'folder d', 'file y.ts', 'submodule lib'],
    );
  });
  test('RepoNode lists opened and PR groups first and skips empty groups', () => {
    const g = (kind: BranchGroupNode['kind'], n: number) => Object.assign(new BranchGroupNode(kind, '', ''), { branches: Array.from({ length: n }, () => row()) });
    const [local, remote, opened, prs] = [g('local', 1), g('remote', 0), g('opened', 1), g('prs', 1)];
    const wt = row();
    assert.deepEqual(new RepoNode('', [wt], [local, remote, opened, prs]).children, [opened, prs, wt, local]);
  });
});

describe('Drafts', () => {
  test('keeps drafts per PR row and removes by id', async () => {
    const d = new Drafts(new Memento() as unknown as vscodeTypes.Memento);
    const n = row();
    await d.add(n, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'x' });
    assert.deepEqual(d.get(n), [], 'a row without a PR has no drafts');
    n.prNumber = 5;
    await d.add(n, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'x' });
    await d.add(n, { path: 'b.ts', line: 2, side: 'LEFT', body: 'y' });
    const list = d.get(n);
    assert.deepEqual(list.map((x) => x.body), ['x', 'y']);
    assert.notEqual(list[0].id, list[1].id);
    await d.remove(n, list[0].id);
    assert.deepEqual(d.get(n).map((x) => x.body), ['y']);
    const other = row();
    other.prNumber = 6;
    assert.deepEqual(d.get(other), []);
  });
});

describe('ownerOfDocument', () => {
  test('maps a snapshot file to its row, path and side', () => {
    const store = tempDir();
    setStorageRoot(path.dirname(store));
    const n = row(store);
    n.diff = { root: '/r', baseRef: 'base1', headRef: 'head1', changes: [] };
    storeOwners.set(store, n);
    const left = FakeUri.file(path.join(snapshotDir(store, n.diff, 'base1'), 'src/a.ts'));
    const right = FakeUri.file(path.join(snapshotDir(store, n.diff, 'head1'), 'src/a.ts'));
    assert.deepEqual(ownerOfDocument(left as never), { node: n, rel: 'src/a.ts', side: 'LEFT' });
    assert.deepEqual(ownerOfDocument(right as never), { node: n, rel: 'src/a.ts', side: 'RIGHT' });
    assert.equal(ownerOfDocument(FakeUri.file('/elsewhere/a.ts') as never), undefined);
    assert.equal(ownerOfDocument(FakeUri.from({ scheme: 'crosscut-ref', path: left.fsPath }) as never), undefined);
    assert.equal(ownerOfDocument(FakeUri.file(path.join(store, 'base')) as never), undefined);
    storeOwners.delete(store);
  });
});

describe('threadsFor', () => {
  test('groups replies under their root, counts per file, and keeps outdated apart', async () => {
    threads.length = 0;
    const n = row('/store');
    n.prNumber = 3;
    n.diff = { root: '/r', baseRef: 'base1', headRef: 'head1', changes: [] };
    const all = [
      comment({ id: 1, line: 3, startLine: 1 }),
      comment({ id: 2, inReplyTo: 1, line: 3, pending: true, author: 'me' }),
      comment({ id: 3, path: 'b.ts', line: 1, side: 'LEFT', pending: true }),
      comment({ id: 4, path: 'b.ts', line: undefined }),
    ];
    await drafts.add(n, { path: 'a.ts', line: 5, startLine: 4, side: 'LEFT', body: 'draft' });
    threadsFor(n, all);
    assert.deepEqual(n.outdated.map((c) => c.id), [4]);
    assert.deepEqual([...n.commentCounts], [['a.ts', 2], ['b.ts', 2]]);
    assert.equal(threads.length, 3);
    const [a, b, d] = threads;
    assert.equal(a.uri.fsPath, path.join(snapshotDir('/store', n.diff, 'head1'), 'a.ts'));
    assert.deepEqual([a.range.start.line, a.range.end.line], [0, 2]);
    assert.deepEqual(a.comments.map((c) => c.author.name), ['ann', 'me (pending)']);
    assert.equal(a.label, 'Review comment on a.ts');
    assert.equal(b.uri.fsPath, path.join(snapshotDir('/store', n.diff, 'base1'), 'b.ts'));
    assert.equal(b.label, 'Pending review comment on b.ts');
    assert.equal(d.contextValue, 'draft');
    assert.equal(d.canReply, true);
    assert.deepEqual([d.range.start.line, d.range.end.line], [3, 4]);

    threadsFor(n, all);
    assert.equal(threads.length, 3, 'unchanged input keeps the rendered threads');
    threadsFor(n, all.slice(0, 1));
    assert.ok(a.disposed && b.disposed && d.disposed);
    assert.equal(n.threads.length, 2);
  });
  test('without a head ref only counts outdated comments', () => {
    threads.length = 0;
    const n = row();
    n.prNumber = 9;
    n.diff = { root: '/r', baseRef: 'b', changes: [] };
    threadsFor(n, [comment({ id: 1 }), comment({ id: 2, line: undefined })]);
    assert.equal(threads.length, 0);
    assert.equal(n.commentCounts.size, 0);
    assert.equal(n.outdated.length, 1);
  });
});
