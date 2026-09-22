import { cleanup, repo, Repo, tempDir } from './repo';
import { after, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import * as path from 'path';
import {
  allIgnored,
  catFileBatch,
  changedLineRanges,
  changesAgainst,
  commitsSince,
  countCommits,
  countFiles,
  deleteBranch,
  deleteRef,
  detectBaseBranch,
  fetchPullRef,
  git,
  hasRef,
  isAncestor,
  listBranches,
  listRefs,
  listWorktrees,
  loadDiff,
  loadRefDiff,
  mergeBase,
  previewRebase,
  repoCommonDir,
  showAtRef,
  stackCandidates,
} from '../git';

after(cleanup);

const summary = (changes: { status: string; path: string; oldPath?: string }[]) =>
  changes.map((c) => `${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`);

describe('git', () => {
  test('resolves stdout and rejects with the command and stderr', async () => {
    const r = repo();
    assert.equal((await git(r.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
    await assert.rejects(git(r.root, ['rev-parse', 'no-such-ref']), /git rev-parse no-such-ref: .*no-such-ref/s);
  });
});

describe('repoCommonDir', () => {
  test('is the shared .git, from the main checkout and from a worktree', async () => {
    const r = repo();
    const wt = path.join(tempDir(), 'wt');
    r.git('worktree', 'add', '-q', '-b', 'feature', wt);
    const expected = path.join(r.root, '.git');
    assert.equal(await repoCommonDir(r.root), expected);
    assert.equal(await repoCommonDir(wt), expected);
  });

  test('is undefined outside a repository', async () => {
    assert.equal(await repoCommonDir(tempDir()), undefined);
  });
});

describe('listWorktrees', () => {
  test('lists the main checkout first, then linked and detached worktrees', async () => {
    const r = repo();
    const base = tempDir();
    r.git('worktree', 'add', '-q', '-b', 'feature/x', path.join(base, 'a'));
    r.git('worktree', 'add', '-q', '--detach', path.join(base, 'b'));
    const wts = await listWorktrees(r.root);
    assert.deepEqual(
      wts.map((w) => [w.path, w.branch, w.isMain, w.bare]),
      [
        [r.root, 'main', true, false],
        [path.join(base, 'a'), 'feature/x', false, false],
        [path.join(base, 'b'), undefined, false, false],
      ],
    );
    assert.equal(wts[2].head, r.head());
  });
});

describe('detectBaseBranch', () => {
  test('prefers main, then master', async () => {
    const r = repo();
    assert.equal(await detectBaseBranch(r.root, ''), 'main');
    r.git('branch', '-m', 'main', 'master');
    assert.equal(await detectBaseBranch(r.root, ''), 'master');
  });

  test('uses a configured branch only when it exists', async () => {
    const r = repo();
    r.git('branch', 'develop');
    assert.equal(await detectBaseBranch(r.root, 'develop'), 'develop');
    assert.equal(await detectBaseBranch(r.root, 'missing'), undefined);
  });

  test("falls back to origin's HEAD, and to nothing", async () => {
    const r = repo();
    r.git('branch', '-m', 'main', 'trunk');
    assert.equal(await detectBaseBranch(r.root, ''), undefined);
    r.git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal(await detectBaseBranch(r.root, ''), 'origin/trunk');
  });
});

describe('commit history helpers', () => {
  test('commitsSince lists first-parent commits newest first, excluding the start', async () => {
    const r = repo();
    const start = r.head();
    r.commit('one');
    const two = r.commit('two');
    const commits = await commitsSince(r.root, start);
    assert.deepEqual(commits.map((c) => c.subject), ['two', 'one']);
    assert.equal(commits[0].sha, two);
    assert.equal(commits[0].short, two.slice(0, commits[0].short.length));
    assert.match(commits[0].when, /ago|now/);
    assert.deepEqual(await commitsSince(r.root, 'HEAD'), []);
  });

  test('countCommits counts, and is NaN for an unknown ref', async () => {
    const r = repo();
    const start = r.head();
    r.commit('one');
    r.commit('two');
    assert.equal(await countCommits(r.root, start), 2);
    assert.equal(await countCommits(r.root, start, 'HEAD~1'), 1);
    assert.ok(Number.isNaN(await countCommits(r.root, 'nope')));
  });

  test('isAncestor and hasRef', async () => {
    const r = repo();
    const first = r.head();
    r.git('checkout', '-q', '-b', 'side');
    const side = r.commit('side');
    assert.equal(await isAncestor(r.root, first, 'side'), true);
    assert.equal(await isAncestor(r.root, side, 'main'), false);
    assert.equal(await isAncestor(r.root, 'nope', 'main'), false);
    assert.equal(await hasRef(r.root, 'side'), true);
    assert.equal(await hasRef(r.root, side), true);
    assert.equal(await hasRef(r.root, 'nope'), false);
  });

  test('mergeBase finds the fork point, and is undefined without shared history', async () => {
    const r = repo();
    const fork = r.head();
    r.git('checkout', '-q', '-b', 'side');
    r.commit('side');
    r.git('checkout', '-q', 'main');
    r.commit('main moves');
    assert.equal(await mergeBase(r.root, 'main', 'side'), fork);
    r.git('checkout', '-q', '--orphan', 'lonely');
    r.commit('unrelated');
    assert.equal(await mergeBase(r.root, 'main', 'lonely'), undefined);
  });
});

describe('refs', () => {
  test('listRefs lists a prefix, deleteRef removes one', async () => {
    const r = repo();
    r.git('update-ref', 'refs/prs/1/head', 'HEAD');
    r.git('update-ref', 'refs/prs/2/head', 'HEAD');
    const refs = await listRefs(r.root, 'refs/prs/');
    assert.deepEqual(refs.map((x) => x.ref), ['refs/prs/1/head', 'refs/prs/2/head']);
    assert.equal(refs[0].sha, r.head());
    await deleteRef(r.root, 'refs/prs/1/head');
    assert.deepEqual((await listRefs(r.root, 'refs/prs/')).map((x) => x.ref), ['refs/prs/2/head']);
    assert.deepEqual(await listRefs(r.root, 'refs/none/'), []);
  });

  test('deleteBranch refuses an unmerged branch unless forced', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'side');
    r.commit('unmerged');
    r.git('checkout', '-q', 'main');
    await assert.rejects(deleteBranch(r.root, 'side', false), /not fully merged/);
    await deleteBranch(r.root, 'side', true);
    assert.equal(await hasRef(r.root, 'refs/heads/side'), false);
  });

  test('fetchPullRef fetches refs/pull/N/head into refs/prs/N/head', async () => {
    const origin = repo();
    origin.git('checkout', '-q', '-b', 'pr');
    const tip = origin.commit('pr work');
    origin.git('update-ref', 'refs/pull/7/head', tip);
    const clone = new Repo(path.join(tempDir(), 'clone'));
    origin.git('clone', '-q', origin.root, clone.root);
    assert.equal(await fetchPullRef(clone.root, 7), 'refs/prs/7/head');
    assert.equal(clone.head('refs/prs/7/head'), tip);
  });
});

describe('listBranches', () => {
  test('lists local and remote branches with upstream and tracking, skipping origin/HEAD', async () => {
    const origin = repo();
    origin.git('branch', 'gone-soon');
    const clone = new Repo(path.join(tempDir(), 'clone'));
    origin.git('clone', '-q', origin.root, clone.root);
    clone.git('checkout', '-q', '-b', 'ahead', '--track', 'origin/main');
    clone.commit('local work');
    clone.git('checkout', '-q', '-b', 'gone-soon', '--track', 'origin/gone-soon');
    clone.git('checkout', '-q', '-b', 'never-pushed');
    origin.git('branch', '-D', 'gone-soon');
    clone.git('fetch', '-q', '--prune');

    const byShort = new Map((await listBranches(clone.root)).map((b) => [b.short, b]));
    assert.ok(!byShort.has('origin/HEAD') && !byShort.has('origin'), 'symbolic origin/HEAD is skipped');
    assert.equal(byShort.get('origin/main')?.remote, true);
    assert.equal(byShort.get('ahead')?.upstream, 'origin/main');
    assert.equal(byShort.get('ahead')?.track, 'ahead 1');
    assert.equal(byShort.get('gone-soon')?.track, 'gone');
    assert.equal(byShort.get('never-pushed')?.upstream, undefined);
    assert.equal(byShort.get('main')?.track, undefined);
    assert.equal(byShort.get('main')?.author, 'Test Author');
  });
});

describe('stackCandidates', () => {
  test('finds the branches a tip is stacked on, nearest first', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'first');
    r.commit('a');
    r.git('checkout', '-q', '-b', 'second');
    r.commit('b');
    r.commit('c');
    r.git('checkout', '-q', '-b', 'third');
    r.commit('d');
    const stack = await stackCandidates(r.root, 'third', 'main', 'refs/heads/third');
    assert.deepEqual(stack.map((s) => [s.short, s.ahead]), [['second', 1], ['first', 3]]);
  });

  test('ignores the branch itself, the base, and branches at the tip', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    r.commit('a');
    r.git('branch', 'same-tip');
    assert.deepEqual(await stackCandidates(r.root, 'feature', 'main', 'refs/heads/feature'), []);
  });
});

describe('changesAgainst', () => {
  test('reports modified, added, deleted, renamed and untracked files, sorted', async () => {
    const r = repo();
    r.commit('files', { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'old-name.txt': 'a long enough line to be detected as a rename\n' });
    r.write('keep.txt', 'changed\n').rm('gone.txt').write('staged.txt', 'new\n').write('untracked.txt', 'u\n');
    r.git('add', 'staged.txt');
    r.git('mv', 'old-name.txt', 'new-name.txt');
    assert.deepEqual(summary(await changesAgainst(r.root, 'HEAD')), [
      'D gone.txt',
      'M keep.txt',
      'R100 old-name.txt -> new-name.txt'.replace('R100', 'R'),
      'A staged.txt',
      '? untracked.txt',
    ]);
  });

  test('lists each file of a small new folder, but folds a large one into a single row', async () => {
    const r = repo();
    r.write('src/new/a.ts', 'a').write('src/new/b.ts', 'b');
    for (let i = 0; i < 201; i++) r.write(`build/out/${i}.o`, String(i));
    const changes = await changesAgainst(r.root, 'HEAD');
    assert.deepEqual(summary(changes), ['? build', '? src/new/a.ts', '? src/new/b.ts']);
    assert.equal(changes[0].untrackedDir, true);
  });

  test('leaves ignored files out', async () => {
    const r = repo();
    r.commit('ignore', { '.gitignore': '*.log\n' });
    r.write('debug.log', 'x');
    assert.deepEqual(await changesAgainst(r.root, 'HEAD'), []);
  });
});

describe('loadDiff', () => {
  test('pins the base to a sha and diffs the working tree against it', async () => {
    const r = repo();
    const base = r.head();
    r.commit('edit', { 'README.md': 'changed\n' });
    r.write('extra.txt', 'x');
    const diff = await loadDiff(r.root, 'HEAD~1');
    assert.equal(diff.baseRef, base);
    assert.equal(diff.headRef, undefined);
    assert.deepEqual(summary(diff.changes), ['? extra.txt', 'M README.md']);
  });

  test('descends into a checked-out submodule, compared against the recorded commit', async () => {
    const sub = repo();
    sub.commit('lib', { 'lib.c': 'int x;\n' });
    const r = repo();
    r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.root, 'deps/sub');
    r.commit('add submodule');
    const inner = new Repo(path.join(r.root, 'deps/sub'));
    inner.write('lib.c', 'int y;\n');
    const diff = await loadDiff(r.root, 'HEAD');
    assert.equal(diff.changes.length, 1);
    const [c] = diff.changes;
    assert.equal(c.path, 'deps/sub');
    assert.equal(c.gitlink, true);
    assert.deepEqual(summary(c.sub!.changes), ['M lib.c']);
    assert.equal(countFiles(diff), 1);
  });

  test('marks an uninitialized submodule as a gitlink with no inner diff', async () => {
    const sub = repo();
    const r = repo();
    r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.root, 'deps/sub');
    r.commit('add submodule');
    const before = r.head();
    sub.commit('moved');
    r.git('-C', 'deps/sub', 'pull', '-q');
    r.commit('bump');
    r.git('submodule', 'deinit', '-q', '-f', 'deps/sub');
    const diff = await loadDiff(r.root, before);
    assert.deepEqual(diff.changes.map((c) => [c.path, c.gitlink, c.sub]), [['deps/sub', true, undefined]]);
  });

  test('rejects an unknown base', async () => {
    await assert.rejects(loadDiff(repo().root, 'nope'), /nope/);
  });
});

describe('loadRefDiff', () => {
  test('compares two commits and pins both', async () => {
    const r = repo();
    const a = r.head();
    r.commit('b', { 'README.md': 'b\n', 'z.txt': 'z' });
    const diff = await loadRefDiff(r.root, 'HEAD~1', 'HEAD');
    assert.equal(diff.baseRef, a);
    assert.equal(diff.headRef, r.head());
    assert.deepEqual(summary(diff.changes), ['M README.md', 'A z.txt']);
  });

  test('follows a submodule pointer bump into the submodule', async () => {
    const sub = repo();
    const r = repo();
    r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.root, 'deps/sub');
    r.commit('add submodule');
    sub.commit('lib', { 'lib.c': 'int x;\n' });
    r.git('-C', 'deps/sub', 'pull', '-q');
    r.commit('bump');
    const diff = await loadRefDiff(r.root, 'HEAD~1', 'HEAD');
    assert.equal(diff.changes[0].gitlink, true);
    assert.deepEqual(summary(diff.changes[0].sub!.changes), ['A lib.c']);
  });
});

describe('changedLineRanges', () => {
  test('gives the touched line ranges on each side', async () => {
    const r = repo();
    r.commit('lines', { 'f.txt': 'one\ntwo\nthree\nfour\nfive\n' });
    r.commit('edit', { 'f.txt': 'one\nTWO\nthree\nfive\nsix\nseven\n' });
    const ranges = await changedLineRanges(r.root, 'HEAD~1', 'HEAD', 'f.txt');
    assert.deepEqual(ranges.left, [[2, 2], [4, 4]]);
    assert.deepEqual(ranges.right, [[2, 2], [5, 6]]);
  });

  test('compares against the working tree without a head, and is empty on error', async () => {
    const r = repo();
    r.write('README.md', 'hello\nworld\n');
    assert.deepEqual(await changedLineRanges(r.root, 'HEAD', undefined, 'README.md'), { left: [], right: [[2, 2]] });
    assert.deepEqual(await changedLineRanges(r.root, 'nope', undefined, 'README.md'), { left: [], right: [] });
  });
});

describe('catFileBatch and showAtRef', () => {
  test('reads many blobs in one process, omitting missing ones and trees', async () => {
    const r = repo();
    r.commit('two', { 'a.txt': 'alpha\n', 'dir/b.txt': 'beta\n' });
    const got = await catFileBatch(r.root, ['HEAD:a.txt', 'HEAD:missing.txt', 'HEAD:dir', 'HEAD:dir/b.txt', 'HEAD:bad\nname']);
    assert.deepEqual([...got.keys()], ['HEAD:a.txt', 'HEAD:dir/b.txt']);
    assert.equal(got.get('HEAD:a.txt')!.toString(), 'alpha\n');
    assert.equal(got.get('HEAD:dir/b.txt')!.toString(), 'beta\n');
  });

  test('rejects outside a repository', async () => {
    await assert.rejects(catFileBatch(tempDir(), ['HEAD:a']), /exited/);
  });

  test('showAtRef reads a file at a ref, and is empty when it does not exist', async () => {
    const r = repo();
    r.commit('edit', { 'README.md': 'new\n' });
    assert.equal(await showAtRef(r.root, 'HEAD~1', 'README.md'), 'hello\n');
    assert.equal(await showAtRef(r.root, 'HEAD', `dir${path.sep}none`), '');
  });
});

describe('allIgnored', () => {
  test('is true only when every path is ignored', async () => {
    const r = repo();
    r.commit('ignore', { '.gitignore': 'build/\n' });
    assert.equal(await allIgnored(r.root, ['build/a.o', 'build/b.o']), true);
    assert.equal(await allIgnored(r.root, ['build/a.o', 'src/a.c']), false);
    assert.equal(await allIgnored(r.root, ['src/a.c']), false);
  });
});

describe('countFiles', () => {
  test('counts submodule changes by their files', () => {
    const sub = { root: '/s', baseRef: 'x', changes: [{ status: 'M' as const, path: 'a' }, { status: 'A' as const, path: 'b' }] };
    assert.equal(countFiles({ root: '/r', baseRef: 'y', changes: [{ status: 'M', path: 'x' }, { status: 'M', path: 's', gitlink: true, sub }] }), 3);
  });
});

describe('previewRebase', () => {
  const setup = () => {
    const r = repo();
    r.commit('base', { 'shared.txt': 'line\n', 'other.txt': 'o\n' });
    r.git('checkout', '-q', '-b', 'feature');
    r.commit('feature edits shared', { 'shared.txt': 'feature\n' });
    r.commit('feature adds file', { 'new.txt': 'n\n' });
    r.git('checkout', '-q', 'main');
    return r;
  };

  test('replays cleanly when nothing overlaps, touching no refs', async () => {
    const r = setup();
    r.commit('main edits other', { 'other.txt': 'changed\n' });
    const refsBefore = r.git('for-each-ref');
    const p = await previewRebase(r.root, 'main', 'feature');
    assert.equal(p.replayed, 2);
    assert.equal(p.conflictedCommits, 0);
    assert.deepEqual(p.conflicts, []);
    assert.deepEqual(summary(p.diff.changes), ['A new.txt', 'M shared.txt']);
    assert.equal(r.git('for-each-ref'), refsBefore);
    assert.equal(r.git('status', '--porcelain'), '');
  });

  test('reports conflicted files with the commits responsible, markers in the result', async () => {
    const r = setup();
    r.commit('main edits shared', { 'shared.txt': 'main\n' });
    const p = await previewRebase(r.root, 'main', 'feature');
    assert.equal(p.conflictedCommits, 1);
    assert.equal(p.conflicts.length, 1);
    assert.equal(p.conflicts[0].path, 'shared.txt');
    assert.match(p.conflicts[0].commits[0], /^[0-9a-f]+ feature edits shared$/);
    assert.deepEqual(summary(p.diff.changes), ['A new.txt', 'U shared.txt']);
    const text = await showAtRef(r.root, p.diff.headRef!, 'shared.txt');
    assert.match(text, /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/);
  });

  test('gives the same result twice, and skips commits already upstream', async () => {
    const r = setup();
    r.git('cherry-pick', 'feature~1');
    const first = await previewRebase(r.root, 'main', 'feature');
    const second = await previewRebase(r.root, 'main', 'feature');
    assert.equal(first.replayed, 1);
    assert.equal(first.diff.headRef, second.diff.headRef);
    assert.deepEqual(summary(first.diff.changes), ['A new.txt']);
  });

  test('rejects an unknown ref', async () => {
    await assert.rejects(previewRebase(setup().root, 'main', 'nope'), /nope/);
  });
});

