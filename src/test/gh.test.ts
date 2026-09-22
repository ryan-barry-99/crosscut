// gh.ts against a fake `gh` on PATH: it records each call (arguments and stdin) and answers from a
// script of responses, so payloads and parsing are checked without touching GitHub.
import { cleanup, tempDir } from './repo';
import { after, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as gh from '../gh';

const bin = tempDir();
const calls = path.join(bin, 'calls.jsonl');
const responses = path.join(bin, 'responses.json');
writeFileSync(
  path.join(bin, 'gh'),
  `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
try { if (args.includes('--input')) input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + '\\n');
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
const hit = rules.find((r) => args.join(' ').includes(r.match));
if (!hit) { process.stderr.write('no fake response for ' + args.join(' ') + '\\n'); process.exit(1); }
process.stdout.write(hit.stdout || '');
process.stderr.write(hit.stderr || '');
process.exit(hit.code || 0);
`,
);
chmodSync(path.join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

after(cleanup);

let errors: string[] = [];
gh.setGhErrorHandler((m) => errors.push(m));

function respond(...rules: { match: string; stdout?: string; stderr?: string; code?: number }[]) {
  writeFileSync(responses, JSON.stringify(rules));
}
function recorded(): { args: string[]; input: string }[] {
  return existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const lines = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

beforeEach(() => {
  writeFileSync(calls, '');
  errors = [];
});

describe('stagePendingReview', () => {
  test('posts a pending review: no event, single lines and spans shaped for GitHub', async () => {
    respond({ match: 'reviews', stdout: '{"id": 4242, "state": "PENDING"}' });
    const res = await gh.stagePendingReview('/', 12, 'summary', [
      { path: 'a.ts', line: 5, side: 'RIGHT', body: 'one line' },
      { path: 'b.ts', line: 9, startLine: 7, side: 'LEFT', body: 'a span' },
      { path: 'c.ts', line: 3, startLine: 3, side: 'RIGHT', body: 'span of one' },
    ]);
    assert.deepEqual(res, { ok: true, message: 'pending review 4242' });
    const [call] = recorded();
    assert.deepEqual(call.args, ['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/12/reviews', '--input', '-']);
    const payload = JSON.parse(call.input);
    assert.ok(!('event' in payload), 'a pending review must never carry an event');
    assert.deepEqual(payload, {
      body: 'summary',
      comments: [
        { path: 'a.ts', body: 'one line', side: 'RIGHT', line: 5 },
        { path: 'b.ts', body: 'a span', side: 'LEFT', line: 9, start_line: 7, start_side: 'LEFT' },
        { path: 'c.ts', body: 'span of one', side: 'RIGHT', line: 3 },
      ],
    });
  });

  test('sends the event only when submitting directly', async () => {
    respond({ match: 'reviews', stdout: '{}' });
    const res = await gh.stagePendingReview('/', 12, '', [], 'APPROVE');
    assert.deepEqual(res, { ok: true, message: 'pending review created' });
    assert.equal(JSON.parse(recorded()[0].input).event, 'APPROVE');
  });

  test("reports GitHub's refusal", async () => {
    respond({ match: 'reviews', stderr: 'HTTP 422: one pending review per user\nmore\nand more', code: 1 });
    assert.deepEqual(await gh.stagePendingReview('/', 12, '', []), { ok: false, message: 'HTTP 422: one pending review per user more' });
    respond({ match: 'reviews', code: 3 });
    assert.deepEqual(await gh.stagePendingReview('/', 12, '', []), { ok: false, message: 'gh exited 3' });
  });
});

describe('prsByBranch', () => {
  test('keeps the newest PR per branch, preferring a merged one', async () => {
    respond({
      match: 'pulls?state=all',
      stdout: lines(
        { number: 3, state: 'OPEN', headRefName: 'feat', url: 'u3', title: 'reopened', baseRef: 'main' },
        { number: 2, state: 'MERGED', headRefName: 'feat', url: 'u2', title: 'merged', baseRef: 'main' },
        { number: 1, state: 'CLOSED', headRefName: 'other', url: 'u1', title: 'closed', baseRef: 'feat' },
      ),
    });
    const map = await gh.prsByBranch('/');
    assert.equal(map.get('feat')?.number, 2);
    assert.deepEqual(map.get('other'), { number: 1, state: 'CLOSED', url: 'u1', title: 'closed', baseRef: 'feat', headRef: 'other' });
    assert.ok(recorded()[0].args.includes('--paginate'));
  });

  test('is empty, and reports, when gh fails', async () => {
    respond({ match: 'pulls', stderr: 'gh: not logged in', code: 4 });
    assert.equal((await gh.prsByBranch('/')).size, 0);
    assert.deepEqual(errors, ['gh api pulls: gh: not logged in']);
  });

  test('is empty on output it cannot parse', async () => {
    respond({ match: 'pulls', stdout: 'not json\n' });
    assert.equal((await gh.prsByBranch('/')).size, 0);
  });
});

describe('single lookups', () => {
  test('prForCommit returns the PR, or undefined when there is none', async () => {
    respond({ match: 'commits/abc/pulls', stdout: '{"number": 5, "title": "t", "url": "u", "headSha": "h", "baseRef": "main"}' });
    assert.equal((await gh.prForCommit('/', 'abc'))?.number, 5);
    respond({ match: 'commits/abc/pulls', stdout: '{"number": null}' });
    assert.equal(await gh.prForCommit('/', 'abc'), undefined);
    respond({ match: 'commits/abc/pulls', stdout: '' });
    assert.equal(await gh.prForCommit('/', 'abc'), undefined);
    respond({ match: 'commits/abc/pulls', stdout: '{broken' });
    assert.equal(await gh.prForCommit('/', 'abc'), undefined);
    respond({ match: '', code: 1 });
    assert.equal(await gh.prForCommit('/', 'abc'), undefined);
    assert.equal(errors.length, 1);
  });

  test('repoUrl', async () => {
    respond({ match: 'repos/{owner}/{repo} --jq .html_url', stdout: 'https://github.com/o/r\n' });
    assert.equal(await gh.repoUrl('/'), 'https://github.com/o/r');
    respond({ match: '', code: 1 });
    assert.equal(await gh.repoUrl('/'), undefined);
  });

  test('prDetails', async () => {
    respond({ match: 'pulls/9 ', stdout: '{"number": 9, "title": "t", "body": "", "draft": false}' });
    assert.equal((await gh.prDetails('/', 9))?.title, 't');
    respond({ match: 'pulls/9', stdout: 'nope' });
    assert.equal(await gh.prDetails('/', 9), undefined);
    respond({ match: '', code: 1 });
    assert.equal(await gh.prDetails('/', 9), undefined);
  });

  test('commitAuthorLogin', async () => {
    respond({ match: 'commits/abc ', stdout: 'octocat\n' });
    assert.equal(await gh.commitAuthorLogin('/', 'abc'), 'octocat');
    respond({ match: 'commits/abc ', stdout: '\n' });
    assert.equal(await gh.commitAuthorLogin('/', 'abc'), undefined);
  });

  test('refTitles looks up at most 20 numbers and drops failures', async () => {
    respond(
      { match: 'issues/1 ', stdout: '{"number": 1, "title": "one", "kind": "pull", "state": "open", "url": "u"}' },
      { match: 'issues/2 ', stdout: 'broken' },
    );
    const titles = await gh.refTitles('/', Array.from({ length: 25 }, (_, i) => i + 1), 'o/r');
    assert.deepEqual([...titles.keys()], [1]);
    assert.equal(recorded().length, 20);
    assert.ok(recorded()[0].args[1].startsWith('repos/o/r/issues/'));
  });
});

describe('review lists', () => {
  test('prComments and prReviews parse one JSON object per line, skipping partial lines', async () => {
    respond(
      { match: 'pulls/4/comments', stdout: lines({ id: 1, path: 'a', line: 2, side: 'RIGHT', body: 'b' }) + '{"partial":\n' },
      { match: 'pulls/4/reviews', stdout: lines({ author: 'x', state: 'APPROVED', body: '', when: 't', url: 'u' }) },
    );
    assert.deepEqual((await gh.prComments('/', 4)).map((c) => c.id), [1]);
    assert.deepEqual((await gh.prReviews('/', 4)).map((r) => r.state), ['APPROVED']);
    assert.ok(recorded().every((c) => c.args.includes('--paginate')));
  });

  test('are empty, and report, when gh fails', async () => {
    respond({ match: '', code: 1, stderr: 'boom' });
    assert.deepEqual(await gh.prComments('/', 4), []);
    assert.match(errors[0], /^gh api --paginate repos\/\{owner\}\/\{repo\}\/pulls\/4\/comments.*: boom$/);
  });

  test('pendingReviewId finds your pending review', async () => {
    respond({ match: 'pulls/4/reviews', stdout: '77\n' });
    assert.equal(await gh.pendingReviewId('/', 4), 77);
    respond({ match: 'pulls/4/reviews', stdout: '' });
    assert.equal(await gh.pendingReviewId('/', 4), undefined);
  });

  test('pendingReviewComments sums the paginated counts', async () => {
    respond({ match: 'reviews/77/comments', stdout: '100\n3\n' });
    assert.equal(await gh.pendingReviewComments('/', 4, 77), 103);
    respond({ match: '', code: 1 });
    assert.equal(await gh.pendingReviewComments('/', 4, 77), 0);
  });

  test('deletePendingReview', async () => {
    respond({ match: '--method DELETE', stdout: '{}' });
    assert.deepEqual(await gh.deletePendingReview('/', 4, 77), { ok: true, message: 'deleted' });
    assert.deepEqual(recorded()[0].args, ['api', '--method', 'DELETE', 'repos/{owner}/{repo}/pulls/4/reviews/77']);
    respond({ match: '', code: 1, stderr: 'HTTP 404\nmore' });
    assert.deepEqual(await gh.deletePendingReview('/', 4, 77), { ok: false, message: 'HTTP 404' });
  });
});

describe('pendingComments', () => {
  test('reads your pending comments over GraphQL, caching for a minute unless fresh', async () => {
    respond(
      { match: 'repo view', stdout: 'octo repo\n' },
      { match: 'graphql', stdout: lines({ id: 5, path: 'a.ts', line: 3, side: 'RIGHT', body: 'b', pending: true }) },
    );
    const cwd = tempDir();
    assert.deepEqual((await gh.pendingComments(cwd, 8)).map((c) => c.id), [5]);
    await gh.pendingComments(cwd, 8);
    const graphql = () => recorded().filter((c) => c.args[1] === 'graphql');
    assert.equal(graphql().length, 1, 'the second ask is served from the cache');
    const args = graphql()[0].args;
    assert.ok(args.includes('owner=octo') && args.includes('repo=repo') && args.includes('n=8'));
    await gh.pendingComments(cwd, 8, true);
    assert.equal(graphql().length, 2);
    assert.equal(recorded().filter((c) => c.args[0] === 'repo').length, 1, 'owner/repo is looked up once per cwd');
  });

  test('is empty when the repo cannot be named, and retries next time', async () => {
    respond({ match: 'repo view', code: 1, stderr: 'no remote' });
    const cwd = tempDir();
    assert.deepEqual(await gh.pendingComments(cwd, 8), []);
    respond({ match: 'repo view', stdout: 'o r\n' }, { match: 'graphql', stdout: '' });
    assert.deepEqual(await gh.pendingComments(cwd, 8, true), []);
    assert.equal(recorded().filter((c) => c.args[0] === 'repo').length, 2);
  });
});
