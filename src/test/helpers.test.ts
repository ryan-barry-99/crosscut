import './fake-vscode';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BranchRef } from '../git';
import { PrDetails } from '../gh';
import { lastGhError, setLastGhError } from '../log';
import { WorktreeNode } from '../model';
import { branchNameOf, clip, describe as describeRow, shortError, shortName } from '../helpers';

const ref = (over: Partial<BranchRef> = {}): BranchRef => ({ ref: 'refs/heads/feat', short: 'feat', sha: 'a'.repeat(40), when: '2 days ago', author: 'Ann', remote: false, ...over });
const row = () => new WorktreeNode({ path: '/r', head: 'b'.repeat(40), branch: 'feat', isMain: true } as never, true, {}, '/s');
const details = (over: Partial<PrDetails> = {}): PrDetails => ({
  number: 7, title: 'Add x', body: 'Why x.', author: 'bob', state: 'OPEN', draft: false, merged: false,
  baseRef: 'main', headRef: 'feat', additions: 3, deletions: 1, changedFiles: 2, url: 'https://gh/7', ...over,
});

describe('shortError', () => {
  test('keeps the first non-blank line without git and fatal prefixes', () => {
    assert.equal(shortError('\ngit merge-base main HEAD: fatal: not a valid ref\nmore'), 'not a valid ref');
    assert.equal(shortError('fatal: bad'), 'bad');
  });
  test('truncates past 60 characters', () => {
    const s = shortError('x'.repeat(80));
    assert.equal(s.length, 60);
    assert.ok(s.endsWith('…'));
  });
  test('falls back to the whole message when every line is blank', () => {
    assert.equal(shortError('  \n '), '  \n ');
  });
});

describe('clip', () => {
  test('returns short text untouched', () => {
    assert.equal(clip('a\nb'), 'a\nb');
  });
  test('cuts at the line limit and marks it', () => {
    assert.equal(clip('1\n2\n3\n4', 2), '1\n2\n\n…');
  });
  test('cuts at the character limit', () => {
    assert.equal(clip('abcdef', 12, 3), 'abc\n\n…');
  });
});

describe('shortName and branchNameOf', () => {
  test('shortName strips heads and one remote', () => {
    assert.equal(shortName('refs/heads/a/b'), 'a/b');
    assert.equal(shortName('refs/remotes/origin/a/b'), 'a/b');
    assert.equal(shortName('refs/tags/v1'), 'refs/tags/v1');
  });
  test('branchNameOf keeps slashed local names and drops the remote', () => {
    assert.equal(branchNameOf(ref({ ref: 'refs/heads/feature/x', short: 'feature/x' })), 'feature/x');
    assert.equal(branchNameOf(ref({ ref: 'refs/remotes/origin/feature/x', short: 'origin/feature/x' })), 'feature/x');
    assert.equal(branchNameOf(ref({ ref: 'adhoc/abc', short: 'label' })), 'label');
  });
});

describe('describe', () => {
  test('a pull request shows its header, size and clipped body', () => {
    const n = row();
    n.details = details();
    n.message = 'ignored for a PR';
    const v = describeRow(n).value;
    assert.match(v, /\*\*\[#7 Add x\]\(https:\/\/gh\/7\)\*\* · open/);
    assert.match(v, /\+3 −1 in 2 files/);
    assert.match(v, /Why x\./);
    assert.match(v, /Show Description/);
    assert.doesNotMatch(v, /ignored for a PR/);
  });
  test('merged and draft states win over the raw state', () => {
    const n = row();
    n.details = details({ merged: true, body: ' ' });
    assert.match(describeRow(n).value, /· merged/);
    assert.doesNotMatch(describeRow(n).value, /Show Description/);
    n.details = details({ draft: true });
    assert.match(describeRow(n).value, /· draft/);
  });
  test('a branch shows its tip, author and push state', () => {
    const n = row();
    assert.match(describeRow(n, ref()).value, /Never pushed/);
    assert.match(describeRow(n, ref({ upstream: 'origin/feat' })).value, /Upstream: `origin\/feat` \(in sync\)/);
    assert.match(describeRow(n, ref({ upstream: 'origin/feat', track: 'ahead 1' })).value, /\(ahead 1\)/);
    const remote = describeRow(n, ref({ remote: true, author: '' })).value;
    assert.match(remote, /\*\*feat\*\* at `aaaaaaaaaa`/);
    assert.doesNotMatch(remote, /by|Upstream|pushed/);
  });
  test('adds the commit message, reviews and error', () => {
    const n = row();
    n.message = 'l1\nl2\nl3\nl4';
    n.reviews = [{ author: 'cy', state: 'CHANGES_REQUESTED', body: 'fix it\nplease', when: '', url: '' }, { author: 'di', state: 'APPROVED', body: '', when: '', url: '' }];
    n.error = 'boom';
    const v = describeRow(n).value;
    assert.match(v, /l1\nl2/);
    assert.match(v, /\*\*cy\*\* changes requested: fix it\n/);
    assert.match(v, /\*\*di\*\* approved/);
    assert.match(v, /⚠ boom/);
    assert.match(v, /Show Description/);
  });
});

describe('setLastGhError', () => {
  test('remembers the last GitHub CLI failure', () => {
    setLastGhError('gh api: 401');
    assert.equal(lastGhError, 'gh api: 401');
    setLastGhError(undefined);
    assert.equal(lastGhError, undefined);
  });
});
