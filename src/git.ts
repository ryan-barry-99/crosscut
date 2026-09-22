import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Never take optional locks (index refresh): we only read, and a lock would both contend with other
// git processes in the worktree and trip our own watchers.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export interface Worktree {
  path: string;
  head: string;
  branch?: string; // short name, undefined when detached
  isMain: boolean; // first entry of `git worktree list` is always the main checkout
  bare: boolean;
}

export async function repoCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const out = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const result: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const wt: Partial<Worktree> = { bare: false };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') wt.path = value;
      else if (key === 'HEAD') wt.head = value;
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') wt.bare = true;
    }
    if (wt.path) result.push({ ...(wt as Worktree), head: wt.head ?? '', isMain: result.length === 0 });
  }
  return result;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function detectBaseBranch(cwd: string, configured: string): Promise<string | undefined> {
  if (configured) return (await refExists(cwd, configured)) ? configured : undefined;
  for (const candidate of ['main', 'master']) {
    if (await refExists(cwd, candidate)) return candidate;
  }
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    return ref.replace(/^refs\/remotes\//, '');
  } catch {
    return undefined;
  }
}

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  when: string;
}

/** Every commit on `tip`'s first-parent chain back to (not including) `since`, newest first. */
export async function commitsSince(cwd: string, since: string, tip = 'HEAD'): Promise<Commit[]> {
  const out = await git(cwd, ['log', '--first-parent', '--format=%H%x1f%h%x1f%s%x1f%cr%x1e', `${since}..${tip}`, '--']);
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, short, subject, when] = r.split('\x1f');
      return { sha, short, subject, when };
    });
}

export async function countCommits(cwd: string, from: string, tip = 'HEAD'): Promise<number> {
  try {
    return Number((await git(cwd, ['rev-list', '--first-parent', '--count', `${from}..${tip}`])).trim());
  } catch {
    return NaN;
  }
}

/** True when `sha` is already contained in `ref` (a plain merge; a squash-merge is not). */
export async function isAncestor(cwd: string, sha: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', sha, ref]);
    return true;
  } catch {
    return false;
  }
}

export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Fetch a pull request's head commits (refs/pull/N/head), which GitHub keeps after a squash merge. */
export async function fetchPullRef(cwd: string, number: number, remote = 'origin'): Promise<string> {
  const local = `refs/prs/${number}/head`;
  await git(cwd, ['fetch', '--no-tags', remote, `refs/pull/${number}/head:${local}`]);
  return local;
}

export async function listRefs(cwd: string, prefix: string): Promise<{ ref: string; sha: string; when: string }[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(committerdate:relative)', prefix]).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, sha, when] = l.split('\x1f');
      return { ref, sha, when };
    });
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await git(cwd, ['update-ref', '-d', ref]);
}

export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<void> {
  await git(cwd, ['branch', force ? '-D' : '-d', name]);
}

const shortRef = (r: string) => r.replace(/^refs\/(heads\/|remotes\/[^/]+\/)/, '');

/**
 * Branches this tip is stacked on: contained in `tip` but not yet in `base`, nearest first. A
 * stacked branch diffed against `base` would show its predecessor's changes as its own.
 */
export async function stackCandidates(cwd: string, tip: string, base: string, self?: string): Promise<{ ref: string; short: string; ahead: number }[]> {
  const out = await git(cwd, ['branch', '-a', '--merged', tip, '--no-merged', base, '--format=%(refname)']).catch(() => '');
  const seen = new Set<string>([shortRef(self ?? ''), shortRef(base)]);
  const refs: string[] = [];
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const short = shortRef(line);
    if (seen.has(short)) continue; // the branch itself, its remote twin, or the base branch
    seen.add(short);
    refs.push(line);
  }
  const ranked = await Promise.all(
    refs.map(async (ref) => ({ ref, short: shortRef(ref), ahead: await countCommits(cwd, ref, tip) })),
  );
  return ranked.filter((r) => Number.isFinite(r.ahead) && r.ahead > 0).sort((a, b) => a.ahead - b.ahead);
}

export async function mergeBase(cwd: string, base: string, tip = 'HEAD'): Promise<string | undefined> {
  try {
    return (await git(cwd, ['merge-base', tip, base])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export type Status = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface Change {
  status: Status;
  path: string; // repo-relative, forward slashes; the path in the working tree
  oldPath?: string; // for renames/copies: the path at the base ref
  gitlink?: boolean; // a submodule entry
  untrackedDir?: boolean; // a wholly untracked directory, listed once like `git status` does
  sub?: RepoDiff; // the submodule's own diff, when it is checked out
}

export interface RepoDiff {
  root: string; // absolute path of the repo's working tree
  baseRef: string;
  headRef?: string; // set when the right side is a commit (a branch diff) instead of the working tree
  changes: Change[];
}

export interface BranchRef {
  ref: string; // full refname, e.g. refs/remotes/origin/feat/x
  short: string; // e.g. origin/feat/x
  sha: string;
  when: string; // relative committer date of the tip
  author: string;
  remote: boolean;
  upstream?: string; // e.g. origin/feat/x — absent on a local branch that was never pushed
  track?: string; // e.g. "ahead 3, behind 1" / "gone"
}

/** Local and remote-tracking branches, most recently committed first (symbolic refs like origin/HEAD skipped). */
export async function listBranches(cwd: string): Promise<BranchRef[]> {
  const out = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(committerdate:relative)%1f%(authorname)%1f%(symref)%1f%(upstream:short)%1f%(upstream:track,nobracket)',
    'refs/heads',
    'refs/remotes',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))
    .filter((f) => !f[5])
    .map(([ref, short, sha, when, author, , upstream, track]) => ({
      ref,
      short,
      sha,
      when,
      author,
      remote: ref.startsWith('refs/remotes/'),
      upstream: upstream || undefined,
      track: track || undefined,
    }));
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function submodulePaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--stage', '-z']);
  return out
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
}

/** Commit a superproject records for a submodule at `ref`, if any. */
async function gitlinkAt(cwd: string, ref: string, rel: string): Promise<string | undefined> {
  return (await gitlinksAt(cwd, ref, [rel])).get(rel);
}

/**
 * Gitlink commits for many paths at `ref`, path -> sha, omitting paths that are not submodules.
 * `ls-tree` takes every path in one call, so this costs a couple of processes rather than one per
 * changed file — the difference between ~4ms and a couple of seconds on a branch touching hundreds.
 */
async function gitlinksAt(cwd: string, ref: string, rels: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const CHUNK = 400; // keep the argument list well clear of ARG_MAX
  for (let i = 0; i < rels.length; i += CHUNK) {
    let out: string;
    try {
      out = await git(cwd, ['-c', 'core.quotePath=false', 'ls-tree', '-z', ref, '--', ...rels.slice(i, i + CHUNK)]);
    } catch {
      continue; // ref missing or unreadable: no gitlinks to report from it
    }
    for (const rec of out.split('\0')) {
      // `<mode> <type> <sha>\t<path>`; split on the first tab rather than matching to end of line,
      // since core.quotePath=false leaves newlines in a path raw.
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const m = /^160000 commit ([0-9a-f]+)$/.exec(rec.slice(0, tab));
      if (m) found.set(rec.slice(tab + 1), m[1]);
    }
  }
  return found;
}

/** A submodule counts as checked out only if it is its own repo root with actual files in it; an
 * initialized-but-empty submodule dir (just a `.git` file) would otherwise show every file as deleted. */
async function isCheckedOut(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    if (!entries.some((e) => e !== '.git')) return false;
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return path.resolve(top) === path.resolve(dir);
  } catch {
    return false;
  }
}

/**
 * Working tree vs `baseRef`, descending into checked-out submodules. Each submodule is compared
 * against the commit the parent recorded for it at `baseRef`, so pointer bumps, commits inside the
 * submodule, and dirty submodule files all show up as file-level changes.
 */
export async function loadDiff(root: string, baseRef: string): Promise<RepoDiff> {
  // Pin to an object id so content cached against it can never go stale (HEAD moves).
  baseRef = (await git(root, ['rev-parse', '--verify', baseRef])).trim();
  const [changes, subs] = await Promise.all([changesAgainst(root, baseRef), submodulePaths(root).catch(() => [])]);
  const byPath = new Map(changes.map((c) => [c.path, c]));
  await Promise.all(
    subs.map(async (rel) => {
      const subRoot = path.join(root, rel);
      const existing = byPath.get(rel);
      if (!(await isCheckedOut(subRoot))) {
        if (existing) existing.gitlink = true;
        return;
      }
      const subBase = (await gitlinkAt(root, baseRef, rel)) ?? EMPTY_TREE;
      let sub: RepoDiff;
      try {
        sub = await loadDiff(subRoot, subBase);
      } catch {
        // base commit not fetched in the submodule, etc. — fall back to its uncommitted changes
        sub = await loadDiff(subRoot, 'HEAD');
      }
      if (!sub.changes.length && !existing) return;
      if (existing) {
        existing.gitlink = true;
        existing.sub = sub;
      } else {
        changes.push({ status: 'M', path: rel, gitlink: true, sub });
      }
    }),
  );
  return { root, baseRef, changes };
}

/** Line ranges of a file that a diff actually touches — GitHub only accepts comments on those. */
export async function changedLineRanges(
  root: string,
  base: string,
  head: string | undefined,
  rel: string,
): Promise<{ left: [number, number][]; right: [number, number][] }> {
  const args = ['diff', '-U0', '--no-color', base, ...(head ? [head] : []), '--', rel];
  const out = await git(root, args).catch(() => '');
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount) left.push([oldStart, oldStart + oldCount - 1]);
    if (newCount) right.push([newStart, newStart + newCount - 1]);
  }
  return { left, right };
}

/** Contents of many `<ref>:<path>` blobs in one `git cat-file --batch` process. Missing ones are omitted. */
export function catFileBatch(cwd: string, specs: string[]): Promise<Map<string, Buffer>> {
  // Newlines in paths would break the batch protocol; those fall back to `git show` on demand.
  const batch = specs.filter((s) => !s.includes('\n'));
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch'], { cwd, env: GIT_ENV });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const buf = Buffer.concat(chunks);
      const result = new Map<string, Buffer>();
      let pos = 0;
      for (const spec of batch) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        const header = buf.toString('utf8', pos, nl);
        pos = nl + 1;
        const m = /^\S+ (\S+) (\d+)$/.exec(header);
        if (!m) continue; // "<spec> missing" / "ambiguous"
        const size = Number(m[2]);
        if (m[1] === 'blob') result.set(spec, buf.subarray(pos, pos + size));
        pos += size + 1; // content + trailing newline
      }
      resolve(result);
    });
    proc.stdin.end(batch.join('\n') + '\n');
  });
}

/** True when every path is gitignored, i.e. a burst of file events can't change the diff. */
export function allIgnored(cwd: string, rels: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd, env: GIT_ENV });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.on('error', () => resolve(false));
    // exit 1 = nothing ignored; 128 = error (e.g. a path inside a submodule) — treat as relevant
    proc.on('close', (code) => resolve(code === 0 && out.split('\0').filter(Boolean).length >= rels.length));
    proc.stdin.end(rels.join('\0') + '\0');
  });
}

export function countFiles(diff: RepoDiff): number {
  return diff.changes.reduce((n, c) => n + (c.sub ? countFiles(c.sub) : 1), 0);
}

function parseNameStatus(out: string): Change[] {
  const changes: Change[] = [];
  const tokens = out.split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++][0] as Status;
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      changes.push({ status, oldPath, path: tokens[i++] });
    } else {
      changes.push({ status, path: tokens[i++] });
    }
  }
  return changes;
}

/**
 * Commit vs commit, for branches with no worktree. Submodules are followed through the repo's own
 * checkout of them (whose object store usually has both commits); otherwise only the pointer shows.
 */
export async function loadRefDiff(root: string, baseRef: string, headRef: string): Promise<RepoDiff> {
  const verify = async (r: string) => (await git(root, ['rev-parse', '--verify', r])).trim();
  [baseRef, headRef] = await Promise.all([verify(baseRef), verify(headRef)]);
  const out = await git(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', baseRef, headRef, '--']);
  const changes = parseNameStatus(out).sort((a, b) => a.path.localeCompare(b.path));
  const subs = new Set(await submodulePaths(root).catch(() => [] as string[]));
  const paths = changes.map((c) => c.path);
  const [oldLinks, newLinks] = await Promise.all([gitlinksAt(root, baseRef, paths), gitlinksAt(root, headRef, paths)]);
  await Promise.all(
    changes.map(async (c) => {
      const [oldSha, newSha] = [oldLinks.get(c.path), newLinks.get(c.path)];
      if (!oldSha && !newSha) return;
      c.gitlink = true;
      const subRoot = path.join(root, c.path);
      if (!subs.has(c.path) || !(await isCheckedOut(subRoot))) return;
      try {
        c.sub = await loadRefDiff(subRoot, oldSha ?? EMPTY_TREE, newSha ?? EMPTY_TREE);
      } catch {
        // commits not present in the local submodule clone: pointer-only row
      }
    }),
  );
  return { root, baseRef, headRef, changes };
}

/** A new folder with more untracked files than this stays one row: it is build output, not source. */
const UNTRACKED_DIR_LIMIT = 200;

/** Working tree (tracked + untracked) compared against `ref`. */
export async function changesAgainst(cwd: string, ref: string): Promise<Change[]> {
  const [diff, untracked] = await Promise.all([
    git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', ref, '--']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']),
  ]);
  const changes = parseNameStatus(diff);
  const dirs: string[] = [];
  for (const p of untracked.split('\0')) {
    if (!p) continue;
    if (p.endsWith('/')) dirs.push(p);
    else changes.push({ status: '?', path: p });
  }
  // --directory keeps an unignored build tree from listing thousands of files, but it also folds a
  // new source folder into one opaque row. Open up each folder that is small enough to be source.
  await Promise.all(
    dirs.map(async (dir) => {
      const inside = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', dir]).catch(() => ''))
        .split('\0')
        .filter(Boolean);
      if (inside.length && inside.length <= UNTRACKED_DIR_LIMIT) for (const p of inside) changes.push({ status: '?', path: p });
      else changes.push({ status: '?', path: dir.slice(0, -1), untrackedDir: true });
    }),
  );
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function showAtRef(cwd: string, ref: string, relPath: string): Promise<string> {
  try {
    return await git(cwd, ['show', `${ref}:${relPath.split(path.sep).join('/')}`]);
  } catch {
    return ''; // file does not exist at ref
  }
}

/** Like `git`, with stdin, extra environment, and the exit code instead of a rejection on status 1. */
function gitRaw(cwd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: { ...GIT_ENV, ...opts.env }, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: unknown }).code as number) : 0;
      if (err && code !== 1) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve({ code, stdout });
    });
    child.stdin?.end(opts.input ?? '');
  });
}

// Synthetic commits get a fixed identity and date, so replaying the same inputs gives the same ids
// and a reload that changed nothing is recognized as unchanged.
const SYNTH_ENV = {
  GIT_AUTHOR_NAME: 'crosscut', GIT_AUTHOR_EMAIL: 'crosscut@localhost', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'crosscut', GIT_COMMITTER_EMAIL: 'crosscut@localhost', GIT_COMMITTER_DATE: '@0 +0000',
};

/** `tree` with each path replaced by its entry in `from` (a tree-ish), or removed where `from` lacks it. */
async function patchTree(cwd: string, tree: string, from: string, paths: string[]): Promise<string> {
  const entries = new Map<string, string>();
  for (const line of (await git(cwd, ['ls-tree', '-z', from, '--', ...paths])).split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , sha] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), `${mode} ${sha}`);
  }
  const index = path.join(os.tmpdir(), `crosscut-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitRaw(cwd, ['read-tree', tree], { env });
    const info = paths.map((p) => `${entries.get(p) ?? `0 ${'0'.repeat(40)}`}\t${p}`).join('\n') + '\n';
    await gitRaw(cwd, ['update-index', '--index-info'], { env, input: info });
    return (await gitRaw(cwd, ['write-tree'], { env })).stdout.trim();
  } finally {
    await fs.rm(index, { force: true });
  }
}

export interface RebaseConflict {
  path: string;
  commits: string[]; // "<short sha> <subject>" of every replayed commit that conflicted on this path
}

export interface RebasePreview {
  diff: RepoDiff; // onto's tip vs the replayed result, conflicted files holding their conflict markers
  conflicts: RebaseConflict[];
  replayed: number;
  conflictedCommits: number;
}

/**
 * What `git rebase <onto>` would do to `tip`, without touching a checkout, the index, or any ref:
 * each commit is replayed with `merge-tree`, as a rebase would, onto the result of the one before.
 *
 * A conflicted path is carried forward as the commit's own version of it — roughly what resolving
 * the conflict produces — so later commits are replayed against something sensible instead of a
 * file full of markers. The result then shows each conflicted file as its last conflicting merge
 * left it, markers included. Commits already upstream (by patch id) are skipped, as rebase does.
 */
export async function previewRebase(cwd: string, onto: string, tip: string): Promise<RebasePreview> {
  const verify = async (r: string) => (await git(cwd, ['rev-parse', '--verify', `${r}^{commit}`])).trim();
  const [ontoSha, tipSha] = await Promise.all([verify(onto), verify(tip)]);
  const log = await git(cwd, ['log', '--reverse', '--no-merges', '--right-only', '--cherry-pick', '--format=%H%x00%P%x00%h %s', `${ontoSha}...${tipSha}`]);
  const commits = log.split('\n').filter(Boolean).map((l) => {
    const [sha, parents, desc] = l.split('\0');
    return { sha, parent: parents.split(' ')[0], desc };
  });
  const conflicts = new Map<string, { commits: string[]; markers: string }>();
  let conflictedCommits = 0;
  let cur = ontoSha;
  for (const c of commits) {
    const merged = await gitRaw(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${c.parent}`, cur, c.sha]);
    const [tree, ...rest] = merged.stdout.split('\n');
    let result = tree.trim();
    if (merged.code === 1) {
      const paths = [...new Set(rest.filter(Boolean))];
      conflictedCommits++;
      for (const p of paths) {
        const hit = conflicts.get(p) ?? { commits: [], markers: '' };
        hit.commits.push(c.desc);
        hit.markers = result;
        conflicts.set(p, hit);
      }
      result = await patchTree(cwd, result, c.sha, paths);
    }
    cur = (await gitRaw(cwd, ['commit-tree', result, '-p', cur, '-m', c.desc], { env: SYNTH_ENV })).stdout.trim();
  }
  let head = cur;
  if (conflicts.size) {
    // Each conflicted file as its last conflicting merge left it, grouped by that merge's tree.
    let tree = (await git(cwd, ['rev-parse', `${cur}^{tree}`])).trim();
    const byMerge = new Map<string, string[]>();
    for (const [p, { markers }] of conflicts) byMerge.set(markers, [...(byMerge.get(markers) ?? []), p]);
    for (const [markers, paths] of byMerge) tree = await patchTree(cwd, tree, markers, paths);
    head = (await gitRaw(cwd, ['commit-tree', tree, '-p', cur, '-m', 'rebase preview'], { env: SYNTH_ENV })).stdout.trim();
  }
  const diff = await loadRefDiff(cwd, ontoSha, head);
  for (const p of conflicts.keys()) {
    const change = diff.changes.find((ch) => ch.path === p);
    if (change) change.status = 'U';
    else diff.changes.push({ status: 'U', path: p });
  }
  diff.changes.sort((a, b) => a.path.localeCompare(b.path));
  return {
    diff,
    conflicts: [...conflicts].map(([p, { commits }]) => ({ path: p, commits })),
    replayed: commits.length,
    conflictedCommits,
  };
}
