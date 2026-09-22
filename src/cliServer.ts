import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { PresentRequest, PresentResponse, WindowEntry, windowsDir } from './ipc';
import { log } from './log';
import { Node } from './model';
import { WorktreeDiffsProvider } from './provider';

/**
 * Listen for the `crosscut` CLI on a per-window unix socket, advertised by an entry file the CLI
 * reads to find the window showing its repo. The entry is rewritten as repos and focus change.
 */
export function serveCli(provider: WorktreeDiffsProvider, view: vscode.TreeView<Node>): vscode.Disposable {
  const dir = windowsDir();
  const id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const socket = path.join(dir, `${id}.sock`);
  const entryFile = path.join(dir, `${id}.json`);
  let focusedAt = Date.now();
  let written = '';
  const writeEntry = () => {
    const entry: WindowEntry = {
      pid: process.pid,
      socket,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      commonDirs: provider.commonDirs(),
      focusedAt,
      uriScheme: vscode.env.uriScheme,
    };
    const text = JSON.stringify(entry);
    if (text === written) return; // tree redraws are frequent; the entry rarely changes
    written = text;
    void fs.writeFile(entryFile, text).catch((e) => log.warn(`cli entry: ${e}`));
  };
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let reply: PresentResponse;
      try {
        const req = JSON.parse(buf.slice(0, nl)) as PresentRequest;
        log.info(`cli: present ${req.ref ?? req.worktree}${req.mode ? ` as ${req.mode}` : ''}${req.open ? ` open ${req.open.path}` : ''}${req.only ? ` only ${req.only.length}` : ''}`);
        reply = await provider.present(req, view);
      } catch (e) {
        reply = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      conn.end(JSON.stringify(reply));
    });
    conn.on('error', () => undefined);
  });
  void fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.rm(socket, { force: true }))
    .then(() => server.listen(socket, writeEntry))
    .catch((e) => log.warn(`cli socket: ${e}`));
  const onFocus = vscode.window.onDidChangeWindowState((s) => {
    if (!s.focused) return;
    focusedAt = Date.now();
    writeEntry();
  });
  const onRepos = provider.onDidChangeTreeData(() => writeEntry());
  return new vscode.Disposable(() => {
    onFocus.dispose();
    onRepos.dispose();
    server.close();
    void fs.rm(entryFile, { force: true });
    void fs.rm(socket, { force: true });
  });
}

/**
 * Put `crosscut` on the PATH as a wrapper that runs this extension's CLI with the extension host's
 * own node, so it works where no node is installed. Done on every activation (unless
 * `crosscut.installCli` is off), which also keeps it pointing at the current extension version.
 * A `crosscut` this extension did not write is never overwritten automatically.
 */
export async function installCli(context: vscode.ExtensionContext, explicit: boolean) {
  if (!explicit && !vscode.workspace.getConfiguration('crosscut').get<boolean>('installCli', true)) return;
  const bin = path.join(require('os').homedir(), '.local', 'bin', 'crosscut');
  const marker = '# Written by the Crosscut VS Code extension.';
  const script = `#!/bin/sh\n${marker}\nexec "${process.execPath}" "${path.join(context.extensionPath, 'out', 'cli.js')}" "$@"\n`;
  const existing = await fs.readFile(bin, 'utf8').catch(() => undefined);
  if (existing === script) return;
  if (existing !== undefined && !existing.includes(marker) && !explicit) {
    log.warn(`not installing the crosscut CLI: ${bin} exists and was not written by this extension`);
    return;
  }
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, script, { mode: 0o755 });
  log.info(`installed the crosscut CLI at ${bin}`);
  if (explicit) void vscode.window.showInformationMessage(`Installed ${bin}. Try: crosscut present`);
}
