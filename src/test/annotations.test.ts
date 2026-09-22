import { cleanup, repo, tempDir } from './repo';
import { env, executed, FakeUri, window } from './fake-vscode';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import {
  blamed, blameDecoration, blameHover, blameTarget, collapseThreadsOfClosedTabs, commentDecoration, commentFileDecorations, decorateComments, openAuthor, repoMainPath, traceThroughPr, repoRootOf, showCommit, toggleBlame, urisOfTab,
} from '../annotations';
import { BlameLine } from '../blame';
import { ReviewComment } from '../gh';
import { setLog } from '../log';
import { storeOwners, WorktreeNode } from '../model';
import { setStorageRoot, snapshotDir } from '../snapshots';

after(cleanup);
setLog({ info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);

const storage = tempDir();
setStorageRoot(storage);
const infos: string[] = [];
window.showInformationMessage = (async (m: string) => void infos.push(m)) as never;

beforeEach(() => {
  executed.length = 0;
  infos.length = 0;
});

const line = (over: Partial<BlameLine> = {}): BlameLine => ({
  sha: 'c'.repeat(40), author: 'Ann', email: 'a@x', when: '2 days ago', date: '2026-01-01 10:00', summary: 'Fix it', uncommitted: false, origLine: 4, origPath: 'a.ts', ...over,
});

/** A PR row whose snapshots live under the storage root. */
function prRow(comments: Partial<ReviewComment>[] = []) {
  const store = path.join(storage, 'wt' + Math.random().toString(36).slice(2));
  const n = new WorktreeNode({ path: '/r' } as never, false, {}, store);
  n.prNumber = 1;
  n.diff = { root: '/r', baseRef: 'base1', headRef: 'head1', changes: [] };
  n.inlineComments = comments.map((c, i) => ({ id: i, path: 'a.ts', line: 1, side: 'RIGHT', body: 'b', author: 'ann', when: '2024-01-01T00:00:00Z', url: '', ...c }));
  storeOwners.set(store, n);
  const uri = (ref: string, rel = 'a.ts') => FakeUri.file(path.join(snapshotDir(store, n.diff!, ref), rel));
  return { n, store, uri };
}

function editor(uri: unknown, lines: string[]) {
  const set: { type: unknown; decorations: { range: { start: { line: number; character: number } }; renderOptions: { after: { contentText: string } }; hoverMessage: { value: string } }[] }[] = [];
  return {
    set,
    document: { uri, version: 1, lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] }) },
    setDecorations: (type: unknown, decorations: never) => set.push({ type, decorations }),
  };
}

describe('blameTarget', () => {
  test('a snapshot maps to its repo, commit and path', async () => {
    const { uri } = prRow();
    assert.deepEqual(await blameTarget(uri('head1', 'src/a.ts') as never), { root: '/r', ref: 'head1', rel: 'src/a.ts' });
  });
  test('a snapshot from an unknown session and a non-file side have none', async () => {
    assert.equal(await blameTarget(FakeUri.file(path.join(storage, 'gone', 'x.ts')) as never), undefined);
    assert.equal(await blameTarget(FakeUri.from({ scheme: 'crosscut-ref', path: '/x' }) as never), undefined);
  });
  test('a real file blames the working tree of its repo', async () => {
    const r = repo();
    r.write('d/x.ts', 'x\n');
    assert.deepEqual(await blameTarget(FakeUri.file(path.join(r.root, 'd/x.ts')) as never), { root: r.root, rel: 'd/x.ts' });
    assert.equal(await repoRootOf(tempDir()), undefined);
    assert.equal(await repoMainPath(r.root), r.root);
  });
});

describe('blameHover', () => {
  const target = { root: '/r', ref: 'h', rel: 'a.ts' };
  test('an uncommitted line says so', () => {
    assert.equal(blameHover(line({ uncommitted: true }), target).value, '$(git-commit) Uncommitted change');
  });
  test('links the author, the file change and the commit', () => {
    const v = blameHover(line(), target).value;
    assert.match(v, /^\*\*Fix it\*\*/);
    assert.match(v, /\[Ann\]\(command:crosscut\.openAuthor\?/);
    assert.match(v, /`cccccccccc` · \[This file's change\]/);
    assert.doesNotMatch(v, /PR #|was `/);
    const args = decodeURIComponent(/openCommitTree\?([^)]+)\)/.exec(v)![1]);
    assert.deepEqual(JSON.parse(args), [{ root: '/r', sha: 'c'.repeat(40), rel: 'a.ts' }]);
  });
  test('a PR number in the subject adds PR links and a trace', () => {
    for (const summary of ['Fix it (#12)', 'Merge pull request #12 from x/y']) {
      const v = blameHover(line({ summary, origPath: 'old.ts' }), target).value;
      assert.match(v, /Open PR #12 here/);
      assert.match(v, /PR #12 on GitHub/);
      assert.match(v, /was `old\.ts`/);
      const trace = JSON.parse(decodeURIComponent(/traceThroughPr\?([^)]+)\)/.exec(v)![1]));
      assert.deepEqual(trace, [{ root: '/r', sha: 'c'.repeat(40), rel: 'old.ts', line: 4 }]);
    }
  });
});

describe('decorateComments', () => {
  test('previews each commented line on its side, collapsing extras', () => {
    const { uri } = prRow([
      { line: 2, body: 'first  comment\nwith lines' },
      { line: 2, body: 'second' },
      { line: 9, startLine: 7, body: 'x'.repeat(100) },
      { line: 1, side: 'LEFT' },
      { line: 3, path: 'b.ts' },
    ]);
    const ed = editor(uri('head1'), ['one', 'two', 'three']);
    decorateComments(ed as never);
    const [{ type, decorations }] = ed.set;
    assert.equal(type, commentDecoration);
    assert.deepEqual(decorations.map((d) => [d.range.start.line, d.range.start.character]), [[1, 3], [2, 5]]);
    assert.equal(decorations[0].renderOptions.after.contentText, '💬 ann: first comment with lines (+1 more)');
    assert.match(decorations[1].renderOptions.after.contentText, /^💬 ann \(lines 7–9\): x{80}…$/);
    assert.match(decorations[0].hoverMessage.value, /second/);
  });
  test('clears decorations outside a PR row', () => {
    const ed = editor(FakeUri.file('/elsewhere.ts'), ['a']);
    decorateComments(ed as never);
    assert.deepEqual(ed.set[0].decorations, []);
  });
});

describe('comment badges and threads', () => {
  test('a snapshot file with comments gets a count badge', () => {
    const { n, uri } = prRow();
    n.commentCounts.set('a.ts', 3).set('b.ts', 12);
    const badge = (u: unknown) => commentFileDecorations.provideFileDecoration!(u as never, undefined as never) as { badge: string; tooltip: string } | undefined;
    assert.deepEqual([badge(uri('head1'))?.badge, badge(uri('head1'))?.tooltip], ['3', '3 review comments']);
    assert.equal(badge(uri('head1', 'b.ts'))?.badge, '9+');
    assert.equal(badge(uri('head1', 'c.ts')), undefined);
    assert.equal(badge(FakeUri.file('/r/a.ts')), undefined);
  });
  test('urisOfTab covers text, diff and multi-diff tabs', () => {
    const u = (s: string) => FakeUri.parse(s);
    assert.deepEqual(urisOfTab({ input: { uri: u('file:///a') } } as never), ['file:///a']);
    assert.deepEqual(urisOfTab({ input: { original: u('file:///a'), modified: u('file:///b'), textDiffs: [{ original: u('file:///c') }] } } as never), ['file:///a', 'file:///b', 'file:///c']);
    assert.deepEqual(urisOfTab({ input: undefined } as never), []);
  });
  test('closing the last tab of a file collapses its threads, drafts excepted', () => {
    const { n } = prRow();
    const t = (uri: string, contextValue?: string) => ({ uri: FakeUri.parse(uri), contextValue, collapsibleState: 1 });
    const [a, b, draft] = [t('file:///a'), t('file:///b'), t('file:///a', 'draft')];
    n.threads = [a, b, draft] as never;
    window.tabGroups.all = [{ tabs: [{ input: { uri: FakeUri.parse('file:///b') } }] }];
    collapseThreadsOfClosedTabs([]);
    collapseThreadsOfClosedTabs([{ input: { uri: FakeUri.parse('file:///a') } }, { input: { uri: FakeUri.parse('file:///b') } }] as never);
    assert.deepEqual([a, b, draft].map((x) => x.collapsibleState), [0, 1, 1]);
    window.tabGroups.all = [];
  });
});

describe('toggleBlame', () => {
  test('annotates every line, then clears on the second toggle', async () => {
    const r = repo();
    r.commit('add', { 'x.ts': 'one\ntwo\n' });
    const ed = editor(FakeUri.file(path.join(r.root, 'x.ts')), ['one', 'two']);
    window.activeTextEditor = ed;
    await toggleBlame();
    const [{ type, decorations }] = ed.set;
    assert.equal(type, blameDecoration);
    assert.deepEqual(decorations.map((d) => d.renderOptions.after.contentText.replace(/, .* ·/, ',·')), ['Test Author,· add', 'Test Author,· add']);
    assert.equal(blamed.size, 1);
    await toggleBlame();
    assert.deepEqual(ed.set[1].decorations, []);
    assert.equal(blamed.size, 0);
  });
  test('says when a side has no blame', async () => {
    window.activeTextEditor = editor(FakeUri.from({ scheme: 'crosscut-ref', path: '/x' }), []);
    await toggleBlame();
    assert.deepEqual(infos, ['No blame available for this side of the diff.']);
    window.activeTextEditor = undefined;
    await toggleBlame();
  });
});

describe('showCommit', () => {
  test('diffs a modified file against its parent', async () => {
    const r = repo();
    r.commit('add', { 'a.ts': 'a\n' });
    const sha = r.commit('edit', { 'a.ts': 'b\n' });
    await showCommit({ root: r.root, sha, rel: 'a.ts' });
    const [left, right, title] = executed[0].args as [vscodeTypes.Uri, vscodeTypes.Uri, string];
    assert.deepEqual(JSON.parse(left.query), { cwd: r.root, ref: `${sha}^`, rel: 'a.ts' });
    assert.deepEqual(JSON.parse(right.query), { cwd: r.root, ref: sha, rel: 'a.ts' });
    assert.equal(title, `a.ts @ ${sha.slice(0, 8)}`);
  });
  test('an added file has an empty left side', async () => {
    const r = repo();
    const sha = r.commit('add', { 'n.ts': 'n\n' });
    await showCommit({ root: r.root, sha, rel: 'n.ts' });
    assert.equal(JSON.parse((executed[0].args[0] as vscodeTypes.Uri).query).ref, '');
  });
});

describe('openAuthor', () => {
  test('a noreply address names the login without asking GitHub', async () => {
    await openAuthor({ root: '/r', sha: 's', email: '123+octo@users.noreply.github.com', name: 'O' });
    assert.equal(env.opened.at(-1), 'https://github.com/octo');
  });
});

describe('traceThroughPr', () => {
  /** A squash commit naming PR #5 on main, and the PR's own commits under refs/prs/5/head. */
  function squashed() {
    const r = repo();
    const base = r.head();
    r.git('checkout', '-q', '-b', 'pr');
    const real = r.commit('the real change', { 'f.ts': 'x\ny\n' });
    r.git('update-ref', 'refs/prs/5/head', real);
    r.git('checkout', '-q', 'main');
    r.git('reset', '-q', '--hard', base);
    const squash = r.commit('Squash (#5)', { 'f.ts': 'x\ny\n' });
    return { r, real, squash };
  }
  test('offers the original commit and opens its file change', async () => {
    const { r, real, squash } = squashed();
    let title = '';
    window.showQuickPick = (async (items: { id: string }[], o: { title: string }) => ((title = o.title), items[0])) as never;
    await traceThroughPr({ root: r.root, sha: squash, rel: 'f.ts', line: 2 });
    assert.equal(title, `In PR #5: ${real.slice(0, 8)} — the real change`);
    assert.equal(executed.at(-1)!.command, 'vscode.diff');
    assert.equal(JSON.parse((executed.at(-1)!.args[1] as vscodeTypes.Uri).query).ref, real);
  });
  test('opens the commit tree or the PR on request', async () => {
    const { r, real, squash } = squashed();
    window.showQuickPick = (async (items: { id: string }[]) => items[1]) as never;
    await traceThroughPr({ root: r.root, sha: squash, rel: 'f.ts', line: 1 });
    assert.deepEqual(executed.at(-1), { command: 'crosscut.openCommitTree', args: [{ root: r.root, sha: real }] });
    window.showQuickPick = (async (items: { id: string }[]) => items[2]) as never;
    await traceThroughPr({ root: r.root, sha: squash, rel: 'f.ts', line: 1 });
    assert.deepEqual(executed.at(-1), { command: 'crosscut.openPrInBrowser', args: [{ root: r.root, sha: squash }] });
    window.showQuickPick = (async () => undefined) as never;
  });
  test('says when the line is not in the PR', async () => {
    const { r, squash } = squashed();
    await traceThroughPr({ root: r.root, sha: squash, rel: 'f.ts', line: 40 });
    assert.match(infos[0], /could not be located in PR #5/);
  });
});
