// The channel between the `crosscut` CLI and the extension running in a VS Code window. Each window
// listens on its own unix socket and advertises it with a JSON entry beside it, listing the repos it
// shows so the CLI can pick the right window.
import * as os from 'os';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  socket: string;
  folders: string[]; // workspace folders
  commonDirs: string[]; // the git common dir of every repo in the tree
  focusedAt: number; // ms epoch; breaks ties between windows showing the same repo
}

export interface PresentRequest {
  cmd: 'present';
  commonDir: string;
  worktree: string; // toplevel of the worktree the CLI ran in
  ref?: string; // full refname: present that branch's row instead of the worktree's
  mode?: 'branch' | 'uncommitted' | `commit:${string}` | `base:${string}` | `rebase:${string}`;
  file?: string; // repo-relative, scrolled to
  // Present a commit or range as its own row in "Opened commits & PRs" instead of an existing row.
  commit?: { id: string; label: string; sha: string; base: string; when: string; author: string };
}

export interface PresentResponse {
  ok: boolean;
  message: string;
}

export function windowsDir(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'crosscut', 'windows');
}
