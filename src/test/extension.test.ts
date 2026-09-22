import { cleanup, repo, tempDir } from './repo';
import { config, executed, FakeUri, Memento, registered, workspace } from './fake-vscode';
import { after, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, readdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';

after(cleanup);

const cache = tempDir();
process.env.XDG_CACHE_HOME = cache;
process.env.HOME = tempDir();
const bin = tempDir();
writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
chmodSync(path.join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
config.installCli = false;
config.showPrComments = false;

describe('activate', () => {
  test('registers the commands and serves the CLI, and disposes cleanly', async () => {
    const r = repo();
    workspace.workspaceFolders = [{ uri: FakeUri.file(r.root), name: 'r', index: 0 }];
    const { activate, deactivate } = await import('../extension');
    const subscriptions: { dispose(): unknown }[] = [];
    const storage = tempDir();
    activate({ subscriptions, workspaceState: new Memento(), globalStorageUri: FakeUri.file(storage), extensionPath: tempDir() } as unknown as vscodeTypes.ExtensionContext);
    for (const name of ['crosscut.refresh', 'crosscut.toggleMode', 'crosscut.pickBase', 'crosscut.openDiff', 'crosscut.toggleBlame', 'crosscut.stageReview']) {
      assert.ok(registered.has(name), name);
    }
    assert.ok(executed.some((e) => e.command === 'setContext' && e.args[0] === 'crosscut.canSubmit' && e.args[1] === false));
    await (registered.get('crosscut.refresh') as () => Promise<void>)();
    for (let i = 0; i < 50 && !readdirSync(cache, { recursive: true }).some((f) => String(f).endsWith('.json')); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(readdirSync(cache, { recursive: true }).some((f) => String(f).endsWith('.sock')), 'a CLI socket is listening');
    for (const s of subscriptions) s.dispose();
    deactivate();
    assert.equal(registered.size, 0);
    assert.ok(path.isAbsolute(storage));
  });
});
