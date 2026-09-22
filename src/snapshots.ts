import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepoDiff, catFileBatch, showAtRef } from './git';
import { log } from './log';
import { Mode, WorktreeNode } from './model';

export const SCHEME = 'crosscut-ref';

// ---------------------------------------------------------------------------
// Read-only documents holding a file's content at a git ref. The URI path is
// the real file path so VS Code picks the right language mode for the left
// side of the diff.

export interface RefQuery {
  cwd: string;
  ref: string; // empty = file absent on this side
  rel: string;
}

export function refUri(absPath: string, q: RefQuery): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: absPath, query: JSON.stringify(q) });
}

// Everything the view knows about a worktree lives on disk under the extension's storage dir,
// populated in the background for every worktree when the window opens:
//
//   <storage>/<repo hash>/<worktree hash>/diff.json                   changed-file list, base, mode
//   <storage>/<repo hash>/<worktree hash>/base/<root hash>/<commit>/…  each changed file at the base
//
// The left side of a diff is a real snapshot file (instant to open; language servers work on it).
// Snapshot paths are keyed by commit id, so they never go stale; older bases are pruned, and a
// worktree's whole dir is removed once git no longer lists the worktree.
export let storageRoot = '';
export const snapshotsReady = new Map<string, Promise<void>>(); // snapshot dir -> write in progress

// Which repo/commit a snapshot dir came from, so blame can be traced back from a snapshot file.
export const snapshotOrigins = new Map<string, string>(); // "<store>/base/<root hash>" -> repo root

export const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
export const repoStore = (commonDir: string) => path.join(storageRoot, hash(commonDir));
export const worktreeStore = (commonDir: string, wtPath: string) => path.join(repoStore(commonDir), hash(wtPath));

export interface SavedDiff {
  mode: Mode;
  baseLabel: string;
  diff: RepoDiff;
}

/** Delete stored data for worktrees git no longer lists. */
export async function pruneRemoved(commonDir: string, live: WorktreeNode[]) {
  const keep = new Set(live.map((n) => path.basename(n.store)));
  const dir = repoStore(commonDir);
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!keep.has(entry)) await fs.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

export function snapshotDir(store: string, diff: RepoDiff, ref = diff.baseRef): string {
  const repoDir = path.join(store, 'base', hash(diff.root));
  snapshotOrigins.set(repoDir, diff.root);
  return path.join(repoDir, ref);
}

/** Write the base side (and, for branch diffs, the head side) of every changed file to disk. */
export function snapshot(store: string, diff: RepoDiff) {
  const files = diff.changes.filter((c) => !c.sub && !c.gitlink && !c.untrackedDir);
  const sides = [{ ref: diff.baseRef, rels: files.filter((c) => c.status !== 'A' && c.status !== '?').map((c) => c.oldPath ?? c.path) }];
  if (diff.headRef) sides.push({ ref: diff.headRef, rels: files.filter((c) => c.status !== 'D').map((c) => c.path) });
  const keep = new Set(sides.map((sd) => sd.ref));
  const repoDir = path.dirname(snapshotDir(store, diff));
  const pruned = (async () => {
    for (const old of await fs.readdir(repoDir).catch(() => [] as string[])) {
      if (!keep.has(old)) await fs.rm(path.join(repoDir, old), { recursive: true, force: true });
    }
  })().catch(() => undefined);
  for (const side of sides) {
    const dir = snapshotDir(store, diff, side.ref);
    const work = (async () => {
      await pruned;
      const missing: string[] = [];
      await Promise.all(side.rels.map((r) => fs.access(path.join(dir, r)).catch(() => missing.push(r))));
      if (!missing.length) return;
      const blobs = await catFileBatch(diff.root, missing.map((r) => `${side.ref}:${r}`));
      await Promise.all(
        missing.map(async (r) => {
          const blob = blobs.get(`${side.ref}:${r}`);
          if (!blob) return;
          const file = path.join(dir, r);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, blob, { mode: 0o444 }); // read-only: edits belong in a worktree
        }),
      );
    })().catch(() => undefined); // a missing snapshot falls back to `git show` on open
    snapshotsReady.set(dir, work);
  }
  for (const c of diff.changes) if (c.sub) snapshot(store, c.sub);
}

/** A file's content at `ref` as a real snapshot file if one was written, else a read-only git document. */
export async function sideUri(store: string, diff: RepoDiff, ref: string, rel: string): Promise<vscode.Uri> {
  const dir = snapshotDir(store, diff, ref);
  await snapshotsReady.get(dir);
  const snap = path.join(dir, rel);
  if (await fs.access(snap).then(() => true, () => false)) return vscode.Uri.file(snap);
  return refUri(path.join(diff.root, rel), { cwd: diff.root, ref, rel });
}

export class RefContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: RefQuery;
    try {
      q = JSON.parse(uri.query) as RefQuery;
    } catch (e) {
      log.error(`bad content uri query: ${uri.query}`);
      return '';
    }
    if (!q.ref) return '';
    const text = await showAtRef(q.cwd, q.ref, q.rel);
    log.info(`content ${q.ref} :: ${q.rel} -> ${text.length} bytes (cwd ${q.cwd})`);
    return text;
  }
}

/** Called once from activate(), before any row loads. */
export function setStorageRoot(dir: string) {
  storageRoot = dir;
}
