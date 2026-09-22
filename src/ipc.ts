// The channel between the `crosscut` CLI and the extension running in a VS Code window. Each window
// listens on its own unix socket and advertises it with a JSON entry beside it, listing the repos it
// shows so the CLI can pick the right window.
import { promises as fs } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  socket: string;
  folders: string[]; // workspace folders
  commonDirs: string[]; // the git common dir of every repo in the tree
  focusedAt: number; // ms epoch; breaks ties between windows showing the same repo
  uriScheme: string; // vscode, vscode-insiders, ...: what `crosscut link` links use
}

export const EXTENSION_ID = 'ryan-barry-99.crosscut';

export interface PresentRequest {
  cmd: 'present';
  commonDir: string;
  worktree: string; // toplevel of the worktree the CLI ran in
  ref?: string; // full refname: present that branch's row instead of the worktree's
  mode?: 'branch' | 'uncommitted' | `commit:${string}` | `base:${string}` | `rebase:${string}`;
  file?: PresentSpec; // scrolled to (and its lines highlighted)
  only?: PresentSpec[]; // limit the multi-file diff to these files or folders
  mark?: PresentSpec[]; // highlight these lines without narrowing the diff; scrolled to the first file
  open?: PresentSpec; // open this one file in its own diff editor instead
  // Present a commit or range as its own row in "Opened commits & PRs" instead of an existing row.
  commit?: { id: string; label: string; sha: string; base: string; when: string; author: string };
}

/** A repo-relative file or folder, optionally with a 1-based inclusive line range on the new side. */
export interface PresentSpec {
  path: string;
  lines?: [number, number];
}

export interface PresentResponse {
  ok: boolean;
  message: string;
}

/** Where `crosscut link --chat` writes the files its links point at. */
export function linksDir(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'crosscut', 'links');
}

export function windowsDir(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'crosscut', 'windows');
}

/** Every live window; entries whose socket no longer answers are removed on the way. */
export async function windows(): Promise<WindowEntry[]> {
  const dir = windowsDir();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: WindowEntry[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    // A half-written or corrupt entry must not take every other window down with it.
    const entry = await fs.readFile(path.join(dir, n), 'utf8').then((t) => JSON.parse(t) as WindowEntry).catch(() => undefined);
    if (!entry) continue;
    try {
      process.kill(entry.pid, 0);
      out.push(entry);
    } catch {
      await fs.rm(path.join(dir, n), { force: true });
      await fs.rm(entry.socket, { force: true });
    }
  }
  return out;
}

export function send(socket: string, req: PresentRequest): Promise<PresentResponse> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = '';
    conn.setEncoding('utf8');
    conn.setTimeout(120_000, () => conn.destroy(new Error('timed out waiting for VS Code')));
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (d) => (buf += d));
    conn.on('end', () => {
      try {
        resolve(JSON.parse(buf) as PresentResponse);
      } catch {
        reject(new Error(`bad reply from VS Code: ${buf}`));
      }
    });
    conn.on('error', reject);
  });
}

/** The windows showing this repo, best first: the one whose workspace holds `cwd`, else the one focused last. */
export async function windowsFor(commonDir: string, cwd: string): Promise<WindowEntry[]> {
  const all = (await windows()).filter((w) => w.commonDirs.includes(commonDir));
  const inside = (w: WindowEntry) => w.folders.some((f) => cwd === f || cwd.startsWith(f + path.sep));
  return all.sort((a, b) => Number(inside(b)) - Number(inside(a)) || b.focusedAt - a.focusedAt);
}

