import { cleanup, tempDir } from './repo';
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { PresentRequest, WindowEntry, linksDir, send, windows, windowsDir, windowsFor } from '../ipc';

after(cleanup);
before(() => {
  process.env.XDG_CACHE_HOME = tempDir();
});

const REQ: PresentRequest = { cmd: 'present', commonDir: '/r/.git', worktree: '/r' };

function entry(name: string, e: Partial<WindowEntry>) {
  mkdirSync(windowsDir(), { recursive: true });
  const full: WindowEntry = { pid: process.pid, socket: path.join(windowsDir(), `${name}.sock`), folders: [], commonDirs: [], focusedAt: 0, uriScheme: 'vscode', ...e };
  writeFileSync(path.join(windowsDir(), `${name}.json`), JSON.stringify(full));
  return full;
}

test('directories live under XDG_CACHE_HOME', () => {
  assert.equal(windowsDir(), path.join(process.env.XDG_CACHE_HOME!, 'crosscut', 'windows'));
  assert.equal(linksDir(), path.join(process.env.XDG_CACHE_HOME!, 'crosscut', 'links'));
});

test('windowsFor ranks the window holding cwd first, then the one focused last', async () => {
  entry('old', { commonDirs: ['/r/.git'], folders: ['/elsewhere'], focusedAt: 1 });
  entry('recent', { commonDirs: ['/r/.git'], folders: ['/elsewhere2'], focusedAt: 5 });
  entry('holder', { commonDirs: ['/r/.git'], folders: ['/r'], focusedAt: 0 });
  entry('other-repo', { commonDirs: ['/s/.git'], folders: ['/r'], focusedAt: 9 });
  writeFileSync(path.join(windowsDir(), 'broken.json'), '{not json');
  const ranked = await windowsFor('/r/.git', '/r/src');
  assert.deepEqual(ranked.map((w) => path.basename(w.socket)), ['holder.sock', 'recent.sock', 'old.sock']);
  assert.equal((await windowsFor('/r/.git', '/rx')).at(0)?.focusedAt, 5, 'a sibling path is not inside /r');
});

test('windows drops entries whose process is gone', async () => {
  entry('ghost', { pid: 2 ** 22 + 999 });
  assert.ok(!(await windows()).some((w) => w.socket.endsWith('ghost.sock')));
});

test('send writes one JSON line and parses the reply', async () => {
  const socket = path.join(tempDir(), 's.sock');
  let got = '';
  const server = net.createServer((c) => c.on('data', (d) => ((got += d), got.endsWith('\n') && c.end('{"ok":true,"message":"hi"}'))));
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    assert.deepEqual(await send(socket, REQ), { ok: true, message: 'hi' });
    assert.deepEqual(JSON.parse(got), REQ);
  } finally {
    server.close();
  }
});

test('send rejects a garbled reply and a missing socket', async () => {
  const socket = path.join(tempDir(), 'g.sock');
  const server = net.createServer((c) => c.on('data', () => c.end('garbage')));
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    await assert.rejects(send(socket, REQ), /bad reply from VS Code: garbage/);
  } finally {
    server.close();
  }
  await assert.rejects(send(path.join(tempDir(), 'none.sock'), REQ), /ENOENT/);
});
