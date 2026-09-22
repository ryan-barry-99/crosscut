// `crosscut` on the command line: the git logic the extension uses, plus a way to open a diff in
// the VS Code window that shows this repo — meant for agents as much as people.
import * as path from 'path';
import { detectBaseBranch, git, mergeBase, previewRebase, repoCommonDir, stackCandidates } from './git';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { EXTENSION_ID, PresentRequest, PresentSpec, linksDir, send, windowsFor } from './ipc';

const USAGE = `usage: crosscut <command> [options]

  present [--vs <rev> | --rebase <rev> | --uncommitted | --last <n> | --branch] [--file <path>] [--ref <branch>]
      Open this worktree's changes (or a branch's, with --ref) in the VS Code window showing this
      repo, as one multi-file diff. A comparison flag that differs from the row's opens as a row
      of its own under Opened commits & PRs, leaving the row alone. --file scrolls to that file.
      --vs diffs against the merge-base with <rev>; --rebase previews rebasing onto it.

  present --pr <n> [--only <spec>... | --open <spec>]
      The pull request's row under Open pull requests, diffed against the branch it targets, with
      its review comments inline — your pending (unsubmitted) review included, marked pending.
      The PR's branch must be fetched.

  present --commit <rev> [--title <text>] [--file <path>]
  present <from>..<to> | <from>...<to> [--title <text>] [--file <path>]
      Open one commit (against its parent), or <to> against <from> (".." compares the two
      directly, "..." against their merge-base, as git diff does), as a row of its own.
      To show what a session did: note HEAD at the start, then present <start>..HEAD
      --title "what it was for".

  Narrowing any of the above to particular files. A <spec> is a path (a folder means everything
  under it), optionally with the lines it is about on the new side: path:12 or path:12-30.
      --only <spec>...   only these files, their lines highlighted (one file with lines opens
                         in the single-file diff at them)
      --mark <spec>...   the full diff, these lines highlighted, scrolled to the first file
      --open <spec>      that one file in its own side-by-side diff editor, at those lines
      --file <spec>      scroll to that file (and its lines) in the full view
  e.g. present findings:  crosscut present --branch --only src/a.ts:40-52 src/b.ts:7

  link <any present arguments> [--text <label>] [--chat]
      Print a vscode:// link that does what that present would, when clicked in a terminal or a
      markdown preview. With --text, print it as a markdown link.
      --chat prints a markdown link to a small file instead, for chat panels that open file links
      but not vscode:// ones (the Claude Code panel): opening the file runs it. Label defaults to
      the file and lines it points at.
      e.g.  crosscut link --pr 381 --open util/gui/api_command_gui.cpp:309 --text "the drain loop"

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

/**
 * `--name value` flags and positionals; boolean flags are listed so they don't eat an argument, and
 * list flags take every value up to the next flag (and may repeat).
 */
function parse(
  argv: string[],
  booleans: string[],
  lists: string[] = [],
): { flags: Map<string, string | true>; lists: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const listed = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (booleans.includes(name)) flags.set(name, true);
    else if (lists.includes(name)) {
      const values = listed.get(name) ?? [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i]);
      if (!values.length) fail(`--${name} needs at least one value`);
      listed.set(name, values);
    } else if (i + 1 < argv.length) flags.set(name, argv[++i]);
    else fail(`--${name} needs a value`);
  }
  return { flags, lists: listed, rest };
}

/** `path`, `path:12` or `path:12-30`, with the path made repo-relative. */
function spec(root: string, cwd: string, text: string): PresentSpec {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(text);
  const file = m ? m[1] : text;
  const lines: [number, number] | undefined = m ? [Number(m[2]), Number(m[3] ?? m[2])] : undefined;
  if (lines && (lines[0] < 1 || lines[1] < lines[0])) fail(`bad line range in ${text}`);
  const rel = path.relative(root, path.resolve(cwd, file)).split(path.sep).join('/');
  if (rel.startsWith('..')) fail(`${file} is outside the repository`);
  return { path: rel || '.', lines };
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

/** The `present` arguments, resolved into the request the extension acts on. */
async function presentRequest(argv: string[], extra: string[] = []): Promise<{ req: PresentRequest; flags: Map<string, string | true> }> {
  const { flags, lists, rest } = parse(argv, ['uncommitted', 'branch', 'chat'], ['only', 'mark']);
  for (const f of flags.keys()) {
    if (!['vs', 'rebase', 'uncommitted', 'last', 'branch', 'commit', 'title', 'ref', 'pr', 'file', 'open', ...extra].includes(f)) fail(`unknown option --${f}`);
  }
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
  const row = ['ref', 'pr'].filter((f) => flags.has(f)).map((f) => `--${f}`);
  if (own.length > 1 || (own.length && (modes.length || row.length))) {
    fail(`${[...own, ...modes, ...row].join(' and ')} cannot be combined`);
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
  if (flags.has('pr') && flags.has('ref')) fail('--pr and --ref both pick the row; pass one');
  const pr = flags.has('pr') ? Number(flags.get('pr')) : undefined;
  if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) fail('--pr needs a pull request number');
  // Open pull requests rows are keyed pr/<n>, not by a refname.
  const ref = pr ? `pr/${pr}` : flags.has('ref') ? await fullRef(cwd, String(flags.get('ref'))) : undefined;
  const file = flags.has('file') ? spec(root, cwd, String(flags.get('file'))) : undefined;
  const swallowed = [...(lists.get('only') ?? []), ...(lists.get('mark') ?? [])].find((t) => /\.\./.test(t) && !t.startsWith('../') && !t.includes('/../'));
  if (swallowed) fail(`${swallowed} after --only reads as a file; put the range before --only / --mark`);
  const only = lists.get('only')?.map((t) => spec(root, cwd, t));
  const mark = lists.get('mark')?.map((t) => spec(root, cwd, t));
  const open = flags.has('open') ? spec(root, cwd, String(flags.get('open'))) : undefined;
  if (mark && only) fail('--mark highlights in the full diff and --only narrows it; pass one');
  if (open && (only || file || mark)) fail('--open shows one file on its own; it cannot be combined with --only, --mark or --file');

  return { req: { cmd: 'present', commonDir, worktree: root, ref, mode, file, commit, only, mark, open }, flags };
}

async function present(argv: string[]) {
  const { req } = await presentRequest(argv);
  const [win] = await windowsFor(req.commonDir, process.cwd());
  if (!win) fail(`no VS Code window with the Crosscut view is showing ${req.worktree}`);
  const reply = await send(win.socket, req);
  if (!reply.ok) fail(reply.message);
  process.stdout.write(`${reply.message}\n`);
}

/**
 * The same request as a link: clicking it in a terminal, a markdown preview or a chat reply does
 * what `present` would. Everything is resolved now (--last to a sha, a range to its commits), so
 * the link keeps meaning the same thing after the branch moves.
 */
async function link(argv: string[]) {
  const { req, flags } = await presentRequest(argv, ['text', 'chat']);
  if (flags.has('chat')) {
    // A file link, for chat panels that open files but drop vscode:// links. Named by content, so
    // the same request always gets the same file and repeated links don't pile up new ones.
    const body = JSON.stringify(req, null, 2);
    const dir = linksDir();
    const id = createHash('sha1').update(body).digest('hex').slice(0, 16);
    const file = path.join(dir, `${id}.crosscut-link`);
    await fs.mkdir(dir, { recursive: true });
    // The chat opens the link file in a text tab for a moment before the extension closes it, so
    // it holds a line worth flashing; the request itself sits beside it.
    await fs.writeFile(path.join(dir, `${id}.json`), body);
    await fs.writeFile(file, 'Opening in Crosscut…\n');
    const spec = req.open ?? req.file ?? req.only?.[0] ?? req.mark?.[0];
    const text = flags.has('text') ? String(flags.get('text')) : spec ? `${spec.path}${spec.lines ? `:${spec.lines[0]}${spec.lines[1] !== spec.lines[0] ? `-${spec.lines[1]}` : ''}` : ''}` : 'open diff';
    process.stdout.write(`[${text.replace(/[[\]]/g, '\\$&')}](${file})\n`);
    return;
  }
  const [win] = await windowsFor(req.commonDir, process.cwd());
  const url = `${win?.uriScheme ?? 'vscode'}://${EXTENSION_ID}/present?q=${encodeURIComponent(JSON.stringify(req))}`;
  process.stdout.write(flags.has('text') ? `[${String(flags.get('text')).replace(/[[\]]/g, '\\$&')}](${url})\n` : `${url}\n`);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'present':
      return present(argv);
    case 'link':
      return link(argv);
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
