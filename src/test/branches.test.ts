import { cleanup, repo } from './repo';
import { config, window } from './fake-vscode';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as vscodeTypes from 'vscode';
import { classify, deleteBranches, doneMessage, fetchedAt, pruneFetchedPrRefs, recoveryLine, Verdict } from '../branches';
import { PrInfo } from '../gh';
import { BranchRef, listBranches } from '../git';
import { setLog } from '../log';
import { WorktreeNode } from '../model';

after(cleanup);

const logged: string[] = [];
let shown = 0;
setLog({ info: (m: string) => logged.push(m), warn() {}, error() {}, debug() {}, trace() {}, show: () => shown++ } as unknown as vscodeTypes.LogOutputChannel);

const messages: { kind: string; text: string }[] = [];
let answer: string | undefined;
window.showWarningMessage = (async (text: string) => void messages.push({ kind: 'warn', text })) as never;
window.showInformationMessage = (async (text: string) => (messages.push({ kind: 'info', text }), answer)) as never;

beforeEach(() => {
  messages.length = 0;
  logged.length = 0;
  answer = undefined;
  delete config.fetchedPrRefs;
});

const pr = (number: number, state: PrInfo['state']): PrInfo => ({ number, state, url: '', title: '', baseRef: 'main', headRef: 'x' });

async function branches() {
  const r = repo();
  r.git('branch', 'merged');
  r.git('checkout', '-q', '-b', 'ahead');
  r.commit('ahead', { 'a.txt': 'a\n' });
  r.git('checkout', '-q', 'main');
  const refs = await listBranches(r.root);
  const node = (short: string) => {
    const n = new WorktreeNode({ path: r.root } as never, false, {}, '');
    n.ref = refs.find((b) => b.short === short)!;
    return n;
  };
  return { r, node };
}

describe('classify', () => {
  test('an ancestor of the base is merged', async () => {
    const { r, node } = await branches();
    assert.deepEqual(await classify(r.root, node('merged'), 'main', new Map()), { b: node('merged').ref, merged: true, why: '$(check) merged into main' });
  });
  test('otherwise the PR state decides', async () => {
    const { r, node } = await branches();
    const why = async (state?: PrInfo['state']) => {
      const v = await classify(r.root, node('ahead'), 'main', new Map(state ? [['ahead', pr(4, state)]] : []));
      return [v.merged, v.why];
    };
    assert.deepEqual(await why('MERGED'), [true, '$(check) PR #4 merged (squashed)']);
    assert.deepEqual(await why('OPEN'), [false, '$(warning) PR #4 still open']);
    assert.deepEqual(await why('CLOSED'), [false, '$(warning) PR #4 closed without merging']);
    assert.deepEqual(await why(), [false, '$(warning) not in main, and no PR found']);
  });
});

describe('deleteBranches', () => {
  test('deletes, logs a recovery line, and reports failures', async () => {
    const { r, node } = await branches();
    const ahead = node('ahead').ref!;
    const verdicts: Verdict[] = [
      { b: node('merged').ref!, merged: true, why: '' },
      { b: ahead, merged: false, why: '' },
      { b: { ...ahead, short: 'nope' } as BranchRef, merged: true, why: '' },
    ];
    const failed = await deleteBranches(r.root, verdicts);
    assert.equal(failed.length, 1);
    assert.match(failed[0], /^nope: /);
    assert.deepEqual((await listBranches(r.root)).map((b) => b.short), ['main']);
    assert.ok(logged.includes(recoveryLine('ahead', ahead.sha)));
  });
  test('a merged-only delete refuses an unmerged branch', async () => {
    const { r, node } = await branches();
    const failed = await deleteBranches(r.root, [{ b: node('ahead').ref!, merged: true, why: '' }]);
    assert.equal(failed.length, 1);
  });
  test('recoveryLine names the restore command', () => {
    assert.equal(recoveryLine('x', 'abc'), 'deleted branch x at abc — restore with: git branch x abc');
  });
});

describe('doneMessage', () => {
  test('warns on failures', () => {
    doneMessage(2, ['a: no', 'b: no']);
    assert.deepEqual(messages, [{ kind: 'warn', text: 'Deleted 2; failed: a: no; b: no' }]);
  });
  test('counts deletions and opens the log on request', async () => {
    answer = 'Show recovery commands';
    doneMessage(1, []);
    doneMessage(3, []);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(messages.map((m) => m.text), ['Deleted 1 branch.', 'Deleted 3 branches.']);
    assert.equal(shown, 2);
  });
  test('says nothing when nothing was deleted', () => {
    doneMessage(0, []);
    assert.equal(messages.length, 0);
  });
});

describe('pruneFetchedPrRefs', () => {
  const setup = () => {
    const r = repo();
    r.git('update-ref', 'refs/prs/1/head', 'HEAD');
    r.git('update-ref', 'refs/prs/2/head', 'HEAD');
    fetchedAt.set(`${r.root}\0refs/prs/1/head`, Date.now());
    fetchedAt.set(`${r.root}\0refs/prs/2/head`, Date.now() - 8 * 86400_000);
    return { r, refs: () => r.git('for-each-ref', '--format=%(refname)', 'refs/prs').split('\n').filter(Boolean) };
  };
  test('drops every fetched ref by default', async () => {
    const { r, refs } = setup();
    await pruneFetchedPrRefs([r.root]);
    assert.deepEqual(refs(), []);
    assert.equal(fetchedAt.has(`${r.root}\0refs/prs/1/head`), false);
    assert.ok(logged.some((l) => l.startsWith('dropped fetched ref refs/prs/1/head')));
  });
  test('keep leaves them, week drops only the old ones', async () => {
    const { r, refs } = setup();
    config.fetchedPrRefs = 'keep';
    await pruneFetchedPrRefs([r.root]);
    assert.equal(refs().length, 2);
    config.fetchedPrRefs = 'week';
    await pruneFetchedPrRefs([r.root]);
    assert.deepEqual(refs(), ['refs/prs/1/head']);
  });
});
