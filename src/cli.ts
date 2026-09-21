// `crosscut` on the command line: the git logic the extension uses, plus a way to open a diff in
// the VS Code window that shows this repo — meant for agents as much as people.
import { promises as fs } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { detectBaseBranch, git, mergeBase, previewRebase, repoCommonDir, stackCandidates } from './git';
import { PresentRequest, PresentResponse, WindowEntry, windowsDir } from './ipc';

const USAGE = `usage: crosscut <command> [options]

  present [--vs <rev> | --rebase <rev> | --uncommitted | --last <n> | --branch] [--file <path>] [--ref <branch>]
      Open this worktree's changes (or a branch's, with --ref) in the VS Code window showing this
      repo, as one multi-file diff. The comparison flag also becomes the row's comparison in the
      tree; without one the row keeps whatever it has. --file scrolls to that file.
      --vs diffs against the merge-base with <rev>; --rebase previews rebasing onto it.

  present --commit <rev> [--title <text>] [--file <path>]
  present <from>..<to> | <from>...<to> [--title <text>] [--file <path>]
      Open one commit (against its parent), or <to> against <from> (".." compares the two
      directly, "..." against their merge-base, as git diff does), as a row of its own.
      To show what a session did: note HEAD at the start, then present <start>..HEAD
      --title "what it was for".

  base [<tip>]
      Print what <tip> (default HEAD) should be diffed against: the branch it is stacked on if
      there is one, else the base branch. Prints the ref and the merge-base sha.

  rebase-preview <onto> [<tip>] [--json]
      What rebasing <tip> (default HEAD, committed work only) onto <onto> would do: commits
      replayed, and each conflicted file with the commits that conflict on it. Touches nothing.
      Exits 1 when there would be conflicts.
`;

function fail(message: string): never {
  process.stderr.write(`crosscut: ${message}\n`);
  process.exit(2);
}

/** `--name value` flags and positionals; boolean flags are listed so they don't eat an argument. */
function parse(argv: string[], booleans: string[]): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (booleans.includes(name)) flags.set(name, true);
    else if (i + 1 < argv.length) flags.set(name, argv[++i]);
    else fail(`--${name} needs a value`);
  }
  return { flags, rest };
}

async function toplevel(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    fail(`${cwd} is not inside a git repository`);
  }
}

/** A branch name or ref, as the full refname the tree keys its rows by. */
async function fullRef(cwd: string, ref: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--symbolic-full-name', ref]).catch(() => '');
  const full = out.trim();
  if (!full.startsWith('refs/')) fail(`${ref} is not a branch`);
  return full;
}

/** A branch as its full refname (so the tree shows its name), anything else as a commit sha. */
async function refOrSha(cwd: string, rev: string): Promise<string> {
  const full = (await git(cwd, ['rev-parse', '--symbolic-full-name', rev]).catch(() => '')).trim();
  return full.startsWith('refs/') ? full : sha(cwd, rev);
}

async function sha(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`]).catch(() => fail(`${rev} is not a commit`))).trim();
}

/** A row of its own for one commit or a range, like opening a commit from blame. */
async function adHoc(cwd: string, spec: string, isCommit: boolean): Promise<NonNullable<PresentRequest['commit']>> {
  let to: string;
  let base: string;
  let label: string;
  if (isCommit) {
    to = await sha(cwd, spec);
    base = await sha(cwd, `${to}^`);
    label = to.slice(0, 8);
  } else {
    const m = /^(.*?)(\.\.\.?)(.*)$/.exec(spec)!;
    const [from, dots, toSpec] = [m[1] || 'HEAD', m[2], m[3] || 'HEAD'];
    to = await sha(cwd, toSpec);
    const fromSha = await sha(cwd, from);
    base = dots === '...' ? ((await mergeBase(cwd, fromSha, to)) ?? fail(`${from} and ${toSpec} share no history`)) : fromSha;
    label = `${from}${dots}${toSpec}`;
  }
  const [subject, when, author] = (await git(cwd, ['show', '-s', '--format=%s%x1f%cr%x1f%an', to])).trim().split('\x1f');
  return {
    id: `${base.slice(0, 10)}-${to.slice(0, 10)}`,
    label: isCommit ? `${label} ${subject}` : label,
    sha: to,
    base,
    when,
    author,
  };
}

async function base(argv: string[]) {
  const { rest } = parse(argv, []);
  const cwd = process.cwd();
  const tip = rest[0] ?? 'HEAD';
  const baseBranch = await detectBaseBranch(cwd, '');
  if (!baseBranch) fail('no base branch found');
  const self = await git(cwd, ['rev-parse', '--symbolic-full-name', tip]).then((o) => o.trim() || undefined, () => undefined);
  const stack = await stackCandidates(cwd, tip, baseBranch, self);
  const against = stack[0]?.ref ?? baseBranch;
  const mb = await mergeBase(cwd, against, tip);
  process.stdout.write(`${stack[0]?.short ?? baseBranch}\t${mb ?? ''}${stack[0] ? '\tstacked' : ''}\n`);
}

async function rebasePreview(argv: string[]) {
  const { flags, rest } = parse(argv, ['json']);
  const [onto, tip = 'HEAD'] = rest;
  if (!onto) fail('rebase-preview needs <onto>');
  const p = await previewRebase(process.cwd(), onto, tip);
  if (flags.has('json')) {
    process.stdout.write(JSON.stringify({ replayed: p.replayed, conflictedCommits: p.conflictedCommits, conflicts: p.conflicts }, null, 2) + '\n');
  } else if (!p.conflicts.length) {
    process.stdout.write(`clean: ${p.replayed} commit${p.replayed === 1 ? '' : 's'} replay onto ${onto} without conflicts\n`);
  } else {
    process.stdout.write(`${p.conflicts.length} conflicted file(s) in ${p.conflictedCommits} of ${p.replayed} commits:\n`);
    for (const c of p.conflicts) process.stdout.write(`  ${c.path}\n${c.commits.map((x) => `      ${x}\n`).join('')}`);
  }
  process.exit(p.conflicts.length ? 1 : 0);
}

/** Every live window; entries whose socket no longer answers are removed on the way. */
async function windows(): Promise<WindowEntry[]> {
  const dir = windowsDir();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: WindowEntry[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const entry = await fs.readFile(path.join(dir, n), 'utf8').then((t) => JSON.parse(t) as WindowEntry, () => undefined);
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

function send(socket: string, req: PresentRequest): Promise<PresentResponse> {
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

async function present(argv: string[]) {
  const { flags, rest } = parse(argv, ['uncommitted', 'branch']);
  const cwd = process.cwd();
  const root = await toplevel(cwd);
  const commonDir = await repoCommonDir(cwd);
  if (!commonDir) fail('could not find the repository');

  let mode: PresentRequest['mode'];
  const range = rest.find((r) => r.includes('..'));
  if (rest.some((r) => r !== range)) fail(`unexpected argument ${rest.find((r) => r !== range)}`);
  const modes = ['vs', 'rebase', 'uncommitted', 'last', 'branch'].filter((f) => flags.has(f)).map((f) => `--${f}`);
  const own = [...(range ? [range] : []), ...(flags.has('commit') ? ['--commit'] : [])];
  if (modes.length > 1) fail(`${modes.join(', ')} are alternatives; pass one`);
  if (own.length > 1 || (own.length && (modes.length || flags.has('ref')))) {
    fail(`${[...own, ...modes, ...(flags.has('ref') ? ['--ref'] : [])].join(' and ')} cannot be combined`);
  }
  if (flags.has('title') && !own.length) fail('--title names a commit or range row; pass --commit or <from>..<to>');
  const commit = range ? await adHoc(cwd, range, false) : flags.has('commit') ? await adHoc(cwd, String(flags.get('commit')), true) : undefined;
  if (commit && flags.has('title')) commit.label = String(flags.get('title'));
  if (flags.has('vs')) mode = `base:${await refOrSha(cwd, String(flags.get('vs')))}`;
  else if (flags.has('rebase')) mode = `rebase:${await refOrSha(cwd, String(flags.get('rebase')))}`;
  else if (flags.has('uncommitted')) mode = 'uncommitted';
  else if (flags.has('branch')) mode = 'branch';
  else if (flags.has('last')) {
    const n = Number(flags.get('last'));
    if (!Number.isInteger(n) || n < 1) fail('--last needs a positive number');
    const sha = await git(cwd, ['rev-parse', '--verify', `HEAD~${n}`]).catch(() => fail(`HEAD has fewer than ${n} commits`));
    mode = `commit:${sha.trim()}`;
  }
  const ref = flags.has('ref') ? await fullRef(cwd, String(flags.get('ref'))) : undefined;
  const file = flags.has('file') ? path.relative(root, path.resolve(cwd, String(flags.get('file')))).split(path.sep).join('/') : undefined;

  const all = (await windows()).filter((w) => w.commonDirs.includes(commonDir));
  if (!all.length) fail(`no VS Code window with the Crosscut view is showing ${root}`);
  // The window whose workspace holds this directory, else the one focused last.
  const inside = (w: WindowEntry) => w.folders.some((f) => cwd === f || cwd.startsWith(f + path.sep));
  all.sort((a, b) => Number(inside(b)) - Number(inside(a)) || b.focusedAt - a.focusedAt);

  const reply = await send(all[0].socket, { cmd: 'present', commonDir, worktree: root, ref, mode, file, commit });
  if (!reply.ok) fail(reply.message);
  process.stdout.write(`${reply.message}\n`);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'present':
      return present(argv);
    case 'base':
      return base(argv);
    case 'rebase-preview':
      return rebasePreview(argv);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      fail(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
