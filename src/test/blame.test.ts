import { cleanup, repo } from './repo';
import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { blameFile } from '../blame';

after(cleanup);

test('blames each line to its commit, following a rename', async () => {
  const r = repo();
  const first = r.commit('add lines', { 'old.txt': 'one\ntwo\n' });
  r.git('mv', 'old.txt', 'new.txt');
  r.write('new.txt', 'one\ntwo\nthree\n');
  const second = r.commit('rename and extend');
  const lines = await blameFile(r.root, 'HEAD', 'new.txt');
  assert.deepEqual(lines.map((l) => [l.sha, l.summary, l.origPath, l.origLine]), [
    [first, 'add lines', 'old.txt', 1],
    [first, 'add lines', 'old.txt', 2],
    [second, 'rename and extend', 'new.txt', 3],
  ]);
  assert.equal(lines[0].author, 'Test Author');
  assert.equal(lines[0].email, 'author@example.com');
  assert.equal(lines[0].uncommitted, false);
  assert.match(lines[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{4}$/);
  assert.match(lines[0].when, /^(\d+ \w+ ago|just now)$/);
});

test('blames the working tree when no ref is given, marking uncommitted lines', async () => {
  const r = repo();
  r.write('README.md', 'hello\nedited\n');
  const lines = await blameFile(r.root, undefined, 'README.md');
  assert.equal(lines[0].uncommitted, false);
  assert.equal(lines[1].uncommitted, true);
  r.write('README.md', 'hello\nedited\nagain\n');
  assert.equal((await blameFile(r.root, undefined, 'README.md')).length, 3, 'working-tree blame is not cached');
});

test('caches a commit blame for good', async () => {
  const r = repo();
  const sha = r.head();
  const first = await blameFile(r.root, sha, 'README.md');
  assert.equal(await blameFile(r.root, sha, 'README.md'), first);
});

test('converts the author timezone into the absolute date', async () => {
  const r = repo();
  r.write('tz.txt', 'x\n');
  r.git('add', 'tz.txt');
  r.git('-c', 'user.name=T', 'commit', '-q', '-m', 'tz', '--date', '2026-01-02T03:04:05-0130');
  const [line] = await blameFile(r.root, 'HEAD', 'tz.txt');
  assert.equal(line.date, '2026-01-02 03:04 -0130');
});

test('rejects a file that does not exist', async () => {
  await assert.rejects(blameFile(repo().root, 'HEAD', 'missing.txt'), /missing\.txt/);
});
