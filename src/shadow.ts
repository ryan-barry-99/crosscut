// History for a folder that has no git repo yet. Each present snapshots the folder into a bare repo
// under the crosscut cache, never touching the folder itself, so the window can show what changed
// since the previous present, the way a commit row does. `git init` in the folder retires it: the
// CLI only reaches for a shadow when the folder is not in a repository.
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from './git';

/** Directories that are never source, excluded on top of the folder's own .gitignore files. */
const EXCLUDE = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store', '.crosscut-link'];

const PRESENTED = 'refs/crosscut/presented';

export function shadowsDir(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'crosscut', 'shadow');
}

export function shadowDir(folder: string): string {
  return path.join(shadowsDir(), `${path.basename(folder)}-${createHash('sha1').update(folder).digest('hex').slice(0, 12)}.git`);
}

/** The folder a shadow repo snapshots, or undefined for any other repo. */
export async function shadowFolder(dir: string): Promise<string | undefined> {
  return (await fs.readFile(path.join(dir, 'crosscut-folder'), 'utf8').catch(() => undefined))?.trim() || undefined;
}

/** The folder `cwd` belongs to: the nearest ancestor that already has a shadow, else `cwd` itself. */
export async function shadowRoot(cwd: string): Promise<string> {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (await fs.access(shadowDir(dir)).then(() => true, () => false)) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}

export interface Snapshot {
  dir: string; // the shadow repo
  base: string; // the previous present's snapshot, or an empty root commit on the first present
  head: string; // this present's snapshot
  first: boolean;
  changed: boolean; // false when nothing changed since the previous present, which is then shown again
}

/** Snapshot `folder` and return what to compare: this present's snapshot against the last one. */
export async function snapshotFolder(folder: string): Promise<Snapshot> {
  const dir = shadowDir(folder);
  const env = ['-c', 'user.name=crosscut', '-c', 'user.email=crosscut@localhost', '-c', 'core.autocrlf=false'];
  const inShadow = (args: string[]) => git(folder, [`--git-dir=${dir}`, `--work-tree=${folder}`, ...env, ...args]);
  if (!(await shadowFolder(dir))) {
    await fs.mkdir(shadowsDir(), { recursive: true });
    await git(shadowsDir(), ['init', '-q', '--bare', dir]);
    await fs.writeFile(path.join(dir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
    await fs.writeFile(path.join(dir, 'crosscut-folder'), folder + '\n');
  }
  const last = (await git(dir, ['rev-parse', '--verify', '--quiet', PRESENTED]).catch(() => '')).trim();
  let base = last;
  if (!base) base = (await inShadow(['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'empty'])).trim();
  await inShadow(['add', '-A', '--', '.']);
  const tree = (await inShadow(['write-tree'])).trim();
  if (last && tree === (await git(dir, ['rev-parse', `${last}^{tree}`])).trim()) {
    const parent = (await git(dir, ['rev-parse', `${last}^`])).trim();
    return { dir, base: parent, head: last, first: false, changed: false };
  }
  const head = (await inShadow(['commit-tree', tree, '-p', base, '-m', `present ${new Date().toISOString()}`])).trim();
  await git(dir, ['update-ref', PRESENTED, head]);
  return { dir, base, head, first: !last, changed: true };
}
