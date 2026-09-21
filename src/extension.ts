import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { PresentRequest, PresentResponse, WindowEntry, windowsDir } from './ipc';
import { BlameLine, blameFile } from './blame';
import { DraftComment, PrDetails, PrInfo, ReviewComment, ReviewSummary, commitAuthorLogin, RefTitle, refTitles, prComments, prDetails, prForCommit, prReviews, prsByBranch, repoUrl, setGhErrorHandler, stagePendingReview, pendingReviewId, pendingReviewComments, deletePendingReview } from './gh';
import {
  Change,
  Worktree,
  RepoDiff,
  allIgnored,
  catFileBatch,
  countFiles,
  loadDiff,
  loadRefDiff,
  listBranches,
  isAncestor,
  stackCandidates,
  hasRef,
  fetchPullRef,
  listRefs,
  changedLineRanges,
  deleteRef,
  deleteBranch,
  BranchRef,
  detectBaseBranch,
  listWorktrees,
  mergeBase,
  commitsSince,
  countCommits,
  repoCommonDir,
  git,
  showAtRef,
  previewRebase,
  RebaseConflict,
  RebasePreview,
} from './git';

const SCHEME = 'crosscut-ref';
let log: vscode.LogOutputChannel;
let lastGhError: string | undefined; // most recent GitHub CLI failure, shown instead of "not found"

function nodeName(n?: Node): string {
  if (!n) return '<root>';
  if (n instanceof RepoNode) return `repo ${n.commonDir}`;
  if (n instanceof BranchGroupNode) return `branches ${n.kind}`;
  if (n instanceof WorktreeNode) return n.ref ? `branch ${n.ref.short}` : `worktree ${n.wt.branch ?? n.wt.path}`;
  if (n instanceof FolderNode) return `folder ${n.rel}`;
  if (n instanceof SubmoduleNode) return `submodule ${n.change.path}`;
  return `file ${n.change.path}`;
}
// 'branch'      = vs the merge-base with the base branch, or with the branch this one is stacked on
// 'base:<ref>'   = vs the merge-base with that ref, chosen explicitly
// 'commit:<sha>' = vs that commit (e.g. the last N commits, plus uncommitted edits in a worktree)
// 'rebase:<ref>' = what rebasing the committed tip onto that ref would produce, conflicts included
type Mode = 'branch' | 'uncommitted' | `commit:${string}` | `base:${string}` | `rebase:${string}`;

// ---------------------------------------------------------------------------
// Read-only documents holding a file's content at a git ref. The URI path is
// the real file path so VS Code picks the right language mode for the left
// side of the diff.

interface RefQuery {
  cwd: string;
  ref: string; // empty = file absent on this side
  rel: string;
}

function refUri(absPath: string, q: RefQuery): vscode.Uri {
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
let storageRoot = '';
const snapshotsReady = new Map<string, Promise<void>>(); // snapshot dir -> write in progress

// Which repo/commit a snapshot dir came from, so blame can be traced back from a snapshot file.
const snapshotOrigins = new Map<string, string>(); // "<store>/base/<root hash>" -> repo root

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const repoStore = (commonDir: string) => path.join(storageRoot, hash(commonDir));
const worktreeStore = (commonDir: string, wtPath: string) => path.join(repoStore(commonDir), hash(wtPath));

interface SavedDiff {
  mode: Mode;
  baseLabel: string;
  diff: RepoDiff;
}

/** Delete stored data for worktrees git no longer lists. */
async function pruneRemoved(commonDir: string, live: WorktreeNode[]) {
  const keep = new Set(live.map((n) => path.basename(n.store)));
  const dir = repoStore(commonDir);
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!keep.has(entry)) await fs.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

function snapshotDir(store: string, diff: RepoDiff, ref = diff.baseRef): string {
  const repoDir = path.join(store, 'base', hash(diff.root));
  snapshotOrigins.set(repoDir, diff.root);
  return path.join(repoDir, ref);
}

/** Write the base side (and, for branch diffs, the head side) of every changed file to disk. */
function snapshot(store: string, diff: RepoDiff) {
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
async function sideUri(store: string, diff: RepoDiff, ref: string, rel: string): Promise<vscode.Uri> {
  const dir = snapshotDir(store, diff, ref);
  await snapshotsReady.get(dir);
  const snap = path.join(dir, rel);
  if (await fs.access(snap).then(() => true, () => false)) return vscode.Uri.file(snap);
  return refUri(path.join(diff.root, rel), { cwd: diff.root, ref, rel });
}

class RefContentProvider implements vscode.TextDocumentContentProvider {
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

// ---------------------------------------------------------------------------
// Tree model

class RepoNode {
  constructor(readonly commonDir: string, readonly worktrees: WorktreeNode[], readonly groups: BranchGroupNode[]) {}
  get children(): Node[] {
    const opened = this.groups.filter((g) => g.kind === 'opened' && g.branches.length);
    const prs = this.groups.filter((g) => g.kind === 'prs' && g.branches.length);
    const rest = this.groups.filter((g) => g.kind !== 'opened' && g.kind !== 'prs' && g.branches.length);
    return [...opened, ...prs, ...this.worktrees, ...rest];
  }
}

/** "Local branches (no worktree)" / "Remote branches": diffed from git objects, nothing checked out. */
class BranchGroupNode {
  branches: WorktreeNode[] = [];
  parent?: RepoNode;
  constructor(readonly kind: 'local' | 'remote' | 'opened' | 'prs', readonly commonDir: string, readonly mainPath: string) {}
}

class WorktreeNode {
  diff?: RepoDiff; // undefined until the node is first expanded
  tree: Child[] = [];
  stale = true;
  loading?: Promise<boolean>;
  baseRef?: string; // what the working tree is compared against
  baseLabel = '';
  error?: string;
  parent?: RepoNode | BranchGroupNode; // repo: set only when several repos are shown
  webUrl?: string; // the PR (or branch) page on GitHub, once looked up
  prNumber?: number; // when this row is a pull request (or a branch with one)
  commentCounts = new Map<string, number>(); // changed path -> inline review comments on it
  threads: vscode.CommentThread[] = [];
  threadSignature?: string; // what the rendered threads were built from
  reviews: ReviewSummary[] = [];
  inlineComments: ReviewComment[] = [];
  details?: PrDetails; // the pull request's own description
  message?: string; // full commit message of this row's tip
  outdated: ReviewComment[] = []; // comments whose line no longer exists in the head version
  rebaseConflicts?: Map<string, RebaseConflict>; // path -> conflict, in a rebase preview
  ref?: BranchRef; // set for a branch with no worktree: `wt` is then the main checkout, used only to run git
  constructor(
    public wt: Worktree,
    public isCurrent: boolean,
    public repo: { current?: Worktree },
    readonly store: string, // this node's dir under the extension storage
  ) {}
  /** Identity for persisted state: the worktree path, or the ref for a branch row. */
  get key(): string {
    return this.ref ? `ref:${this.ref.ref}` : this.wt.path;
  }
}

type Child = FolderNode | SubmoduleNode | FileNode;

class FolderNode {
  children: Child[] = [];
  constructor(readonly owner: WorktreeNode, readonly diff: RepoDiff, readonly rel: string, readonly label: string, readonly parent: Node) {}
}

class SubmoduleNode {
  readonly children: Child[];
  constructor(readonly owner: WorktreeNode, readonly change: Change & { sub: RepoDiff }, readonly parent: Node) {
    this.children = buildFileTree(owner, change.sub, this);
  }
}

class FileNode {
  constructor(readonly owner: WorktreeNode, readonly diff: RepoDiff, readonly change: Change, readonly parent: Node) {}
  get absPath(): string {
    return path.join(this.diff.root, this.change.path);
  }
}

type Node = RepoNode | BranchGroupNode | WorktreeNode | Child;

interface RawDir {
  dirs: Map<string, RawDir>;
  files: Change[];
}

/** Group changes into folders (folders first), compacting single-child chains (`a/b/c`) like the SCM view. */
function buildFileTree(owner: WorktreeNode, diff: RepoDiff, parent: Node): Child[] {
  const root: RawDir = { dirs: new Map(), files: [] };
  for (const change of diff.changes) {
    const parts = change.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      dir = next;
    }
    dir.files.push(change);
  }
  const emit = (dir: RawDir, prefix: string, parent: Node): Child[] => {
    const out: Child[] = [];
    for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let d = sub;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [n2, d2] = [...d.dirs][0];
        label += `/${n2}`;
        d = d2;
      }
      const rel = prefix ? `${prefix}/${label}` : label;
      const folder = new FolderNode(owner, diff, rel, label, parent);
      folder.children = emit(d, rel, folder);
      out.push(folder);
    }
    const base = (c: Change) => path.posix.basename(c.path);
    for (const c of [...dir.files].sort((a, b) => base(a).localeCompare(base(b)))) {
      out.push(c.sub ? new SubmoduleNode(owner, c as Change & { sub: RepoDiff }, parent) : new FileNode(owner, diff, c, parent));
    }
    return out;
  };
  return emit(root, '', parent);
}

// PR review comments are rendered with VS Code's own comment threads, so they appear in the diff
// gutter exactly like a review on GitHub (read-only: replying belongs on the PR itself).
let comments: vscode.CommentController; // created in activate(), before any tree load
// Which PR row a snapshot file belongs to, so comments can be attached to the right pull request.
const storeOwners = new Map<string, WorktreeNode>(); // store dir -> node

interface Draft extends DraftComment {
  id: string;
}

/** Drafts live locally until staged, so nothing reaches GitHub until you ask for it. */
class Drafts {
  constructor(private readonly state: vscode.Memento) {}
  private key(node: WorktreeNode) {
    return `drafts:${node.wt.path}#${node.prNumber}`;
  }
  get(node: WorktreeNode): Draft[] {
    return node.prNumber ? this.state.get<Draft[]>(this.key(node), []) : [];
  }
  async set(node: WorktreeNode, list: Draft[]) {
    await this.state.update(this.key(node), list);
  }
  async add(node: WorktreeNode, d: Omit<Draft, 'id'>) {
    await this.set(node, [...this.get(node), { ...d, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);
  }
  async remove(node: WorktreeNode, id: string) {
    await this.set(node, this.get(node).filter((d) => d.id !== id));
  }
}
let drafts: Drafts;

/** The PR row, file and side a snapshot document belongs to. */
function ownerOfDocument(uri: vscode.Uri): { node: WorktreeNode; rel: string; side: 'LEFT' | 'RIGHT' } | undefined {
  if (uri.scheme !== 'file') return undefined;
  for (const [store, node] of storeOwners) {
    if (!isInside(uri.fsPath, store) || !node.diff) continue;
    const rest = path.relative(path.join(store, 'base'), uri.fsPath).split(path.sep);
    rest.shift(); // <root hash>
    const ref = rest.shift();
    if (!ref) continue;
    return { node, rel: rest.join('/'), side: ref === node.diff.headRef ? 'RIGHT' : 'LEFT' };
  }
  return undefined;
}

function threadsFor(node: WorktreeNode, all: ReviewComment[]) {
  if (!comments) return;
  // Rebuilding disposes every thread, which also closes a comment box the user is typing in — so
  // only rebuild when the comments or drafts actually differ from what is on screen.
  const signature = JSON.stringify([all, drafts.get(node), node.diff?.headRef, node.diff?.baseRef]);
  if (signature === node.threadSignature) return;
  node.threadSignature = signature;
  log.info(`comments for PR #${node.prNumber}: ${all.length} inline, headRef ${node.diff?.headRef?.slice(0, 8) ?? '(none)'}`);
  node.threads.forEach((t) => t.dispose());
  node.threads = [];
  node.commentCounts.clear();
  node.outdated = all.filter((c) => !c.line);
  if (!node.diff?.headRef) return;
  for (const c of all) node.commentCounts.set(c.path, (node.commentCounts.get(c.path) ?? 0) + 1);

  const byId = new Map(all.map((c) => [c.id, c]));
  const rootOf = (c: ReviewComment): ReviewComment => (c.inReplyTo && byId.get(c.inReplyTo)) || c;
  const groups = new Map<string, ReviewComment[]>();
  for (const c of all) {
    if (!c.line) continue; // outdated: no line in the current head version
    const root = rootOf(c);
    const key = `${root.path}:${root.line ?? c.line}:${root.side}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  for (const [key, group] of groups) {
    const [, lineText, side] = key.split(':');
    const first = group[0];
    const ref = side === 'LEFT' ? node.diff.baseRef : node.diff.headRef;
    const file = path.join(snapshotDir(node.store, node.diff, ref), first.path);
    const line = Math.max(0, Number(lineText) - 1);
    const from = Math.max(0, (first.startLine ?? Number(lineText)) - 1);
    const thread = comments.createCommentThread(
      vscode.Uri.file(file),
      new vscode.Range(Math.min(from, line), 0, line, 0),
      group
        .sort((a, b) => a.id - b.id)
        .map((c) => ({
          body: new vscode.MarkdownString(c.body),
          mode: vscode.CommentMode.Preview,
          author: { name: c.author },
          label: new Date(c.when).toLocaleString(),
          contextValue: String(c.id),
        })),
    );
    thread.canReply = false;
    // Collapsed: an expanded thread is an inline widget, and several of them shove the diff around
    // as they load. The end-of-line decoration below makes them visible without moving any text.
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.label = `Review comment on ${first.path}`;
    node.threads.push(thread);
  }
  // Local drafts, not yet staged on GitHub.
  for (const d of drafts.get(node)) {
    const ref = d.side === 'LEFT' ? node.diff.baseRef : node.diff.headRef;
    const line = Math.max(0, d.line - 1);
    const from = Math.max(0, (d.startLine ?? d.line) - 1);
    const thread = comments.createCommentThread(
      vscode.Uri.file(path.join(snapshotDir(node.store, node.diff, ref), d.path)),
      new vscode.Range(Math.min(from, line), 0, line, 0),
      [
        {
          body: new vscode.MarkdownString(d.body),
          mode: vscode.CommentMode.Preview,
          author: { name: 'You (draft)' },
          label: 'not staged yet',
          contextValue: 'draft',
          // @ts-expect-error VS Code carries unknown fields through untouched; used by the delete command
          draftId: d.id,
        },
      ],
    );
    thread.canReply = true;
    thread.contextValue = 'draft';
    thread.label = `Draft comment on ${d.path}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    node.threads.push(thread);
  }
  log.info(`PR #${node.prNumber}: ${node.threads.length} threads rendered (${drafts.get(node).length} drafts)`);
}

const STATUS_LABEL: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked',
};
const STATUS_COLOR: Record<string, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  '?': 'gitDecoration.untrackedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  U: 'gitDecoration.conflictingResourceForeground',
};

class WorktreeDiffsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private repos: RepoNode[] = [];
  private nodes = new Map<string, WorktreeNode>(); // by worktree path, kept stable across refreshes
  private branchNodes = new Map<string, WorktreeNode>(); // by `${commonDir}\0${refname}`
  private prCache = new Map<string, { at: number; value: Promise<Map<string, PrInfo>> }>();
  private opened = new Map<string, BranchGroupNode>(); // commonDir -> ad-hoc commits/PRs opened from a blame hover
  private prGroups = new Map<string, BranchGroupNode>(); // commonDir -> the open-pull-request rows
  private expanded?: WorktreeNode; // only one worktree is expanded (and diffed/watched) at a time
  private repoWatchers: vscode.Disposable[] = [];
  private repoWatchKey = '';
  private expandedWatcher?: vscode.Disposable;
  private expandedWatchPath?: string;
  private pendingPaths = new Set<string>();
  private layout = '';
  private queue: WorktreeNode[] = [];
  private running = 0;
  private listTimer?: NodeJS.Timeout;
  private diffTimer?: NodeJS.Timeout;

  constructor(private readonly state: vscode.Memento) {}

  modeFor(node: WorktreeNode): Mode {
    const def = vscode.workspace.getConfiguration('crosscut').get<Mode>('defaultMode', 'branch');
    const mode = this.state.get<Mode>(`mode:${node.key}`, node.ref ? 'branch' : def);
    return node.ref && mode === 'uncommitted' ? 'branch' : mode; // a branch has no working tree
  }

  async toggleMode(node: WorktreeNode) {
    if (node.ref) return;
    const next: Mode = this.modeFor(node) === 'branch' ? 'uncommitted' : 'branch';
    await this.setMode(node, next);
  }

  async setMode(node: WorktreeNode, mode: Mode) {
    await this.state.update(`mode:${node.key}`, mode);
    await this.reload(node, true);
  }

  /** Quick pick: a base branch (including the one this branch is stacked on), uncommitted, or the last N commits. */
  async pickBase(node: WorktreeNode) {
    const cwd = node.wt.path;
    const tip = node.ref?.sha ?? 'HEAD';
    const configured = vscode.workspace.getConfiguration('crosscut').get<string>('baseBranch', '');
    const base = await detectBaseBranch(cwd, configured);
    const self = node.ref?.ref ?? (node.wt.branch ? `refs/heads/${node.wt.branch}` : undefined);
    const stack = base ? await stackCandidates(cwd, tip, base, self) : [];
    const against = stack[0]?.ref ?? base;
    const mb = against && (await mergeBase(cwd, against, tip));
    // Only the branch's own commits; a checkout sitting on the base branch just gets "uncommitted".
    const commits = mb ? await commitsSince(cwd, mb, tip).catch(() => []) : [];
    const current = this.modeFor(node);

    type Pick = vscode.QuickPickItem & { mode: Mode };
    const items: Pick[] = [
      {
        label: `$(git-merge) Rebase preview onto…${current.startsWith('rebase:') ? `  $(check) ${shortName(current.slice(7))}` : ''}`,
        description: node.ref ? 'conflicts a rebase would hit, without rebasing' : 'committed changes only; conflicts a rebase would hit',
        mode: 'rebase:' as Mode,
      },
      // Base comparisons first — the whole branch, then the other bases: these are what a review
      // almost always wants, ahead of the long per-commit list.
      ...(commits.length
        ? [
            {
              label: `$(git-branch) Whole branch${stack[0] ? ` on top of ${stack[0].short}` : ''}`,
              description: `vs ${stack[0]?.short ?? base} (merge-base)${stack[0] ? ' — stacked, detected' : ''}`,
              mode: 'branch' as Mode,
            },
          ]
        : []),
      // Other bases: the base branch itself, plus anything further down the stack.
      ...(stack.length && base ? [{ label: `$(git-branch) Everything since ${base}`, description: 'ignores the stack', mode: `base:refs/heads/${base}` as Mode }] : []),
      ...stack.slice(1).map((c): Pick => ({ label: `$(layers) On top of ${c.short}`, description: `${c.ahead} commits ahead of it`, mode: `base:${c.ref}` as Mode })),
      ...(node.ref ? [] : [{ label: '$(edit) Uncommitted changes', description: 'vs HEAD', mode: 'uncommitted' as Mode }]),
      ...commits.map((c, i): Pick => {
        // "Last k commits" = working tree vs the commit just before the k-th newest one.
        const k = i + 1;
        const baseSha = commits[k]?.sha ?? mb!;
        return {
          label: `$(git-commit) Last ${k} commit${k === 1 ? '' : 's'}`,
          description: `${c.short} ${c.subject}`,
          detail: `back to ${c.when}${commits[k] ? '' : ' — the whole branch'}`,
          mode: `commit:${baseSha}`,
        };
      }),
    ];
    for (const it of items) if (it.mode === current) it.label += '  $(check)';
    const picked = await vscode.window.showQuickPick(items, {
      title: `Compare ${node.ref?.short ?? node.wt.branch ?? path.basename(cwd)} against…`,
      placeHolder: node.ref
        ? `The right side is always the tip of ${node.ref.short}`
        : 'The right side is always the working tree (uncommitted edits included)',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.mode !== 'rebase:') return this.setMode(node, picked.mode);
    const onto = await this.pickRebaseTarget(node);
    if (onto) await this.setMode(node, `rebase:${onto}`);
  }

  /** Open pull requests first — the usual thing to restack onto — then every other branch. */
  private async pickRebaseTarget(node: WorktreeNode): Promise<string | undefined> {
    const cwd = node.wt.path;
    const self = node.ref?.ref ?? (node.wt.branch ? `refs/heads/${node.wt.branch}` : undefined);
    const [branches, prs] = await Promise.all([
      listBranches(cwd).catch(() => [] as BranchRef[]),
      this.prsFor(cwd).catch(() => new Map<string, PrInfo>()),
    ]);
    const others = branches.filter((b) => b.ref !== self && b.short !== node.wt.branch);
    type Target = vscode.QuickPickItem & { ref?: string };
    const selfBranch = node.ref ? (node.prNumber ? undefined : branchNameOf(node.ref)) : node.wt.branch;
    const open = [...prs.values()]
      .filter((p) => p.state === 'OPEN' && p.number !== node.prNumber && p.headRef !== selfBranch)
      .sort((a, b) => b.number - a.number);
    const prItems: Target[] = open.flatMap((p) => {
      const b = others.find((x) => x.short === p.headRef) ?? others.find((x) => x.short === `origin/${p.headRef}`);
      return b ? [{ label: `$(git-pull-request) #${p.number} ${p.title}`, description: b.short, detail: `into ${p.baseRef}`, ref: b.ref }] : [];
    });
    const taken = new Set(prItems.map((i) => i.ref));
    const branchItems: Target[] = others
      .filter((b) => !taken.has(b.ref))
      .map((b) => ({ label: `$(${b.remote ? 'cloud' : 'git-branch'}) ${b.short}`, description: `${b.when} · ${b.author}`, ref: b.ref }));
    const picked = await vscode.window.showQuickPick<Target>(
      [
        ...(prItems.length ? [{ label: 'Open pull requests', kind: vscode.QuickPickItemKind.Separator }, ...prItems] : []),
        { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
        ...branchItems,
      ],
      { title: 'Rebase preview onto…', placeHolder: 'Committed changes only; nothing is checked out or rewritten', matchOnDescription: true },
    );
    return picked?.ref;
  }

  /** Re-list worktrees (cheap); redraws only what changed. */
  scheduleRefresh() {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => this.refresh(), 500);
  }

  private scheduleExpandedRefresh(file: string) {
    this.pendingPaths.add(file);
    clearTimeout(this.diffTimer);
    this.diffTimer = setTimeout(() => this.onExpandedFilesChanged(), 500);
  }

  private async onExpandedFilesChanged() {
    const node = this.expanded;
    const files = [...this.pendingPaths];
    this.pendingPaths.clear();
    if (!node || node.ref || !files.length) return;
    // Build output and other ignored files can't change the diff.
    if (await allIgnored(node.wt.path, files.map((f) => path.relative(node.wt.path, f)))) return;
    await this.reload(node);
  }

  /** Manual refresh: always re-diff the expanded worktree. */
  async refreshExpanded() {
    if (this.expanded) await this.reload(this.expanded, true);
  }

  /** Re-diff a worktree and redraw it only if the set of changed files (or the base) moved. */
  private async reload(node: WorktreeNode, force = false) {
    if ((await this.loadChanges(node)) || force) this.emitter.fire(node);
  }

  private enqueue(node: WorktreeNode, front = false) {
    this.queue = this.queue.filter((n) => n !== node);
    if (front) this.queue.unshift(node);
    else this.queue.push(node);
    this.pump();
  }

  private pump() {
    // The expanded row is the only one anybody is waiting on, so it never queues behind background
    // refreshes — it starts even when every background slot is busy.
    const i = this.expanded ? this.queue.indexOf(this.expanded) : -1;
    if (i >= 0) {
      const node = this.queue.splice(i, 1)[0];
      if (this.isLive(node)) {
        this.running++;
        this.reload(node).finally(() => {
          this.running--;
          this.pump();
        });
      }
    }
    while (this.running < 4 && this.queue.length) {
      const node = this.queue.shift()!;
      if (!this.isLive(node)) continue; // removed meanwhile
      this.running++;
      this.reload(node).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private isLive(node: WorktreeNode): boolean {
    return node.ref ? [...this.branchNodes.values()].includes(node) : this.nodes.get(node.wt.path) === node;
  }

  /** Branch rows for refs with no worktree: local branches nobody has checked out, and all remote ones. */
  private async listBranchGroups(common: string, main: Worktree, wts: Worktree[], repoCtx: { current?: Worktree }, next: Map<string, WorktreeNode>) {
    const local = new BranchGroupNode('local', common, main.path);
    const remote = new BranchGroupNode('remote', common, main.path);
    const checkedOut = new Set(wts.map((w) => w.branch).filter(Boolean));
    const moved: WorktreeNode[] = [];
    for (const b of await listBranches(main.path).catch(() => [] as BranchRef[])) {
      if (!b.remote && checkedOut.has(b.short)) continue;
      const key = `${common}\0${b.ref}`;
      let node = this.branchNodes.get(key);
      if (!node) {
        node = new WorktreeNode(main, false, repoCtx, '');
        node.ref = b;
        (node as { store: string }).store = worktreeStore(common, node.key);
      } else {
        if (node.ref!.sha !== b.sha) moved.push(node);
        node.ref = b;
        node.wt = main;
        node.repo = repoCtx;
      }
      const group = b.remote ? remote : local;
      node.parent = group;
      group.branches.push(node);
      next.set(key, node);
    }
    const opened = this.opened.get(common);
    const prs = this.prGroups.get(common);
    return { groups: [...(opened ? [opened] : []), ...(prs ? [prs] : []), local, remote], moved };
  }

  /**
   * Show an ad-hoc commit (or a PR) as its own row: same file tree, multi-file diff and blame as a
   * branch row, with `base` as the left side.
   */
  async openAdHoc(
    main: string,
    entry: { id: string; label: string; sha: string; base: string; when: string; author: string },
    view: vscode.TreeView<Node>,
    webUrl?: string,
  ) {
    const repo = this.repos.find((r) => r.worktrees.some((w) => w.wt.path === main)) ?? this.repos[0];
    if (!repo) return;
    let group = this.opened.get(repo.commonDir);
    if (!group) {
      group = new BranchGroupNode('opened', repo.commonDir, main);
      this.opened.set(repo.commonDir, group);
      (repo as { groups: BranchGroupNode[] }).groups.unshift(group);
      group.parent = this.repos.length > 1 ? repo : undefined;
    }
    const refname = `adhoc/${entry.id}`;
    let node = group.branches.find((n) => n.ref!.ref === refname);
    if (!node) {
      node = new WorktreeNode(repo.worktrees[0].wt, false, repo.worktrees[0].repo, worktreeStore(repo.commonDir, `ref:${refname}`));
      node.ref = { ref: refname, short: entry.label, sha: entry.sha, when: entry.when, author: entry.author, remote: false };
      node.parent = group;
      group.branches.unshift(node);
      this.branchNodes.set(`${repo.commonDir}\0${refname}`, node);
      await this.state.update(`mode:${node.key}`, `commit:${entry.base}` as Mode);
    }
    node.webUrl = webUrl ?? node.webUrl;
    node.prNumber = /^pr-(\d+)$/.exec(entry.id) ? Number(/^pr-(\d+)$/.exec(entry.id)![1]) : node.prNumber;
    this.emitter.fire(undefined);
    this.expanded = node;
    await view.reveal(node, { expand: true, select: true, focus: true });
  }

  closeAdHoc(node: WorktreeNode) {
    for (const [common, group] of this.opened) {
      const i = group.branches.indexOf(node);
      if (i < 0) continue;
      group.branches.splice(i, 1);
      this.branchNodes.delete(`${common}\0${node.ref!.ref}`);
      if (node === this.expanded) this.expanded = undefined;
    }
    this.emitter.fire(undefined);
  }

  /**
   * Link every worktree and branch row to its pull request in one lookup per repo, so the
   * PR-only actions are offered without having to expand a row first.
   */
  private async linkPrs() {
    if (!vscode.workspace.getConfiguration('crosscut').get<boolean>('showPrComments', true)) return;
    for (const repo of this.repos) {
      const main = repo.worktrees[0]?.wt.path;
      if (!main) continue;
      const prs = await this.prsFor(main);
      if (!prs.size) continue;
      let linked = 0;
      for (const node of [...repo.worktrees, ...repo.groups.flatMap((g) => g.branches)]) {
        if (node.prNumber) continue;
        const branch = node.ref ? (node.ref.ref.startsWith('adhoc/') ? undefined : branchNameOf(node.ref)) : node.wt.branch;
        const pr = branch && prs.get(branch);
        if (!pr) continue;
        node.prNumber = pr.number;
        node.webUrl ??= pr.url;
        linked++;
      }
      if (linked) {
        log.info(`linked ${linked} rows to pull requests`);
        this.emitter.fire(undefined);
      }
      await this.syncPrRows(repo, main, prs);
    }
  }

  /**
   * A row per open pull request, so a review starts from the PR rather than from hunting its branch
   * among the remotes. These are not the same as the branch rows: a branch is diffed against the
   * default base, while a PR is diffed against the merge-base with the branch it actually targets —
   * which for a stacked PR is its predecessor, not main.
   */
  private async syncPrRows(repo: RepoNode, main: string, prs: Map<string, PrInfo>) {
    const open = [...prs.values()].filter((p) => p.state === 'OPEN').sort((a, b) => b.number - a.number);
    let group = this.prGroups.get(repo.commonDir);
    if (!group) {
      group = new BranchGroupNode('prs', repo.commonDir, main);
      this.prGroups.set(repo.commonDir, group);
    }
    if (!repo.groups.includes(group)) {
      (repo as { groups: BranchGroupNode[] }).groups.push(group);
      group.parent = this.repos.length > 1 ? repo : undefined;
    }
    let added = 0;
    let unfetched = 0;
    for (const pr of open) {
      const refname = `pr/${pr.number}`;
      const key = `${repo.commonDir}\0${refname}`;
      if (this.branchNodes.has(key)) continue;
      // Only the PR's own remote-tracking branch; a fork's head is not in this clone and fetching
      // every one of them on a refresh would be a surprise.
      const head = await git(main, ['rev-parse', '--verify', `refs/remotes/origin/${pr.headRef}`]).then((o) => o.trim()).catch(() => '');
      if (!head) {
        unfetched++;
        continue;
      }
      const when = (await git(main, ['show', '-s', '--format=%cr', head]).catch(() => '')).trim();
      // Every rebuild starts a sync without waiting for the last, so another one may have added this
      // row while the git calls above were in flight.
      if (group.branches.some((n) => n.ref!.ref === refname)) continue;
      const node = new WorktreeNode(repo.worktrees[0].wt, false, repo.worktrees[0].repo, worktreeStore(repo.commonDir, `ref:${refname}`));
      node.ref = { ref: refname, short: `#${pr.number} ${pr.title}`, sha: head, when, author: `into ${pr.baseRef}`, remote: true };
      node.prNumber = pr.number;
      node.webUrl = pr.url;
      node.parent = group;
      group.branches.push(node);
      this.branchNodes.set(key, node);
      // `base:` rather than a resolved merge-base sha: the row then re-derives the merge-base on
      // every load, so the diff stays right as the target branch moves underneath the PR.
      await this.state.update(`mode:${node.key}`, `base:refs/remotes/origin/${pr.baseRef}` as Mode);
      added++;
    }
    // Drop rows for PRs that have since been merged or closed.
    for (const node of [...group.branches]) {
      if (open.some((p) => `pr/${p.number}` === node.ref!.ref)) continue;
      group.branches.splice(group.branches.indexOf(node), 1);
      this.branchNodes.delete(`${repo.commonDir}\0${node.ref!.ref}`);
    }
    group.branches.sort((a, b) => Number(b.ref!.ref.slice(3)) - Number(a.ref!.ref.slice(3)));
    if (added || unfetched) {
      log.info(`open pull requests: ${group.branches.length} rows${unfetched ? `, ${unfetched} skipped (head not in this clone)` : ''}`);
      this.emitter.fire(undefined);
    }
  }

  /** The pull request a row belongs to, looking it up if this row has not been linked yet. */
  async prOf(node: WorktreeNode): Promise<number | undefined> {
    if (node.prNumber) return node.prNumber;
    const branch = node.ref ? (node.ref.ref.startsWith('adhoc/') ? undefined : branchNameOf(node.ref)) : node.wt.branch;
    if (!branch) return undefined;
    const pr = (await this.prsFor(node.wt.path)).get(branch);
    node.prNumber = pr?.number;
    node.webUrl ??= pr?.url;
    return node.prNumber;
  }

  /** Main checkout of every repo in the window. */
  repoPaths(): string[] {
    return this.repos.map((r) => r.worktrees[0]?.wt.path).filter(Boolean);
  }

  /** Re-render comment threads for a row after its drafts change. */
  async reloadComments(node: WorktreeNode) {
    await this.loadComments(node);
    this.emitter.fire(node);
  }

  /** Inline review comments for a PR row (or a branch that has one), rendered as comment threads. */
  private async loadComments(node: WorktreeNode) {
    if (!vscode.workspace.getConfiguration('crosscut').get<boolean>('showPrComments', true)) return;
    // The right side is a synthetic commit, so review comments on the real head have nowhere to land.
    if (this.modeFor(node).startsWith('rebase:')) return;
    const main = node.wt.path;
    // A worktree row has a branch too, so it can be linked to its pull request just like a branch row.
    const branch = node.ref ? (node.ref.ref.startsWith('adhoc/') ? undefined : branchNameOf(node.ref)) : node.wt.branch;
    if (node.prNumber === undefined && branch) {
      const pr = (await this.prsFor(main)).get(branch);
      node.prNumber = pr?.state === 'OPEN' || pr?.state === 'MERGED' ? pr.number : pr?.number;
      node.webUrl ??= pr?.url;
    }
    if (!node.prNumber) return;
    const [inline, reviews] = await Promise.all([prComments(main, node.prNumber), prReviews(main, node.prNumber)]);
    node.reviews = reviews.filter((r) => r.body?.trim());
    node.inlineComments = inline;
    node.details ??= await prDetails(main, node.prNumber);
    threadsFor(node, inline);
    decorateAllVisible();
    if (inline.length || node.reviews.length) this.emitter.fire(node);
  }

  /** PRs by branch name, fetched at most once every few minutes per repo. */
  private prsFor(main: string): Promise<Map<string, PrInfo>> {
    const hit = this.prCache.get(main);
    if (hit && Date.now() - hit.at < 300_000) return hit.value;
    const value = prsByBranch(main);
    this.prCache.set(main, { at: Date.now(), value });
    return value;
  }

  /** Seed a node from its diff.json, so the tree has counts and files before git runs. */
  private async restore(node: WorktreeNode) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(node.store, 'diff.json'), 'utf8')) as SavedDiff;
      if (saved.mode !== this.modeFor(node)) return;
      node.diff = saved.diff;
      node.baseRef = saved.diff.baseRef;
      node.baseLabel = saved.baseLabel;
      node.tree = buildFileTree(node, saved.diff, node);
      node.stale = true;
    } catch {
      // nothing saved yet
    }
  }

  async refresh() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const byCommon = new Map<string, string>(); // commonDir -> a folder inside that repo
    await Promise.all(
      folders.map(async (f) => {
        const common = await repoCommonDir(f.uri.fsPath);
        if (common && !byCommon.has(common)) byCommon.set(common, f.uri.fsPath);
      }),
    );

    const repos: RepoNode[] = [];
    const nodes = new Map<string, WorktreeNode>();
    const branchNodes = new Map<string, WorktreeNode>();
    const moved: WorktreeNode[] = []; // HEAD or branch changed
    const created: WorktreeNode[] = [];
    for (const [common, cwd] of byCommon) {
      let wts: Worktree[];
      try {
        wts = (await listWorktrees(cwd)).filter((w) => !w.bare);
      } catch {
        continue;
      }
      const repoCtx: { current?: Worktree } = {};
      const repoNodes = wts.map((wt) => {
        const isCurrent = folders.some((f) => isInside(f.uri.fsPath, wt.path));
        if (isCurrent && !repoCtx.current) repoCtx.current = wt;
        // Keep node objects stable so VS Code keeps expansion state and nothing re-renders needlessly.
        let node = this.nodes.get(wt.path);
        if (!node) {
          node = new WorktreeNode(wt, isCurrent, repoCtx, worktreeStore(common, wt.path));
          created.push(node);
        } else {
          if (node.wt.head !== wt.head || node.wt.branch !== wt.branch) moved.push(node);
          node.wt = wt;
          node.isCurrent = isCurrent;
          node.repo = repoCtx;
        }
        nodes.set(wt.path, node);
        return node;
      });
      const listed = await this.listBranchGroups(common, wts[0], wts, repoCtx, branchNodes);
      for (const g of listed.groups) {
        if (g.kind !== 'opened' && g.kind !== 'prs') continue;
        // These rows are not rediscovered from refs, so a rebuild has to carry them over itself.
        for (const n of g.branches) {
          n.wt = wts[0];
          n.repo = repoCtx;
          branchNodes.set(`${common}\0${n.ref!.ref}`, n);
        }
      }
      for (const n of listed.moved) {
        if (n.diff) n.stale = true;
        moved.push(n);
      }
      repos.push(new RepoNode(common, repoNodes, listed.groups));
      void pruneRemoved(common, [...repoNodes, ...listed.groups.flatMap((g) => g.branches)]);
    }
    await Promise.all(created.map((n) => this.restore(n)));
    for (const repo of repos) {
      for (const n of repo.worktrees) n.parent = repos.length > 1 ? repo : undefined;
      for (const g of repo.groups) g.parent = repos.length > 1 ? repo : undefined;
    }

    const layout = repos
      .map(
        (r) =>
          r.commonDir +
          '\n' +
          r.worktrees.map((n) => `${n.wt.path}|${n.isCurrent}|${n.wt.isMain}`).join('\n') +
          '\n' +
          r.groups.map((g) => g.branches.map((b) => `${b.ref!.ref}|${b.ref!.when}`).join('\n')).join('\n'),
      )
      .join('\n\n');
    this.repos = repos;
    this.nodes = nodes;
    this.branchNodes = branchNodes;
    if (this.expanded && !this.isLive(this.expanded)) {
      // A row that did not survive a rebuild takes the accordion with it: the next expand sees no
      // previous row and so collapses nothing, leaving two rows open.
      log.info(`expanded row ${nodeName(this.expanded)} did not survive the rebuild; accordion reset`);
      this.expanded = undefined;
    }
    this.rewatchRepos();
    this.rewatchExpanded();

    if (layout !== this.layout) {
      this.layout = layout;
      this.emitter.fire(undefined);
    }
    // Only the rows you are actually looking at re-diff: the expanded one, and the worktree this
    // window sits in. Every other row shows its cached count from diff.json and re-diffs when
    // expanded, the same way branch rows always have.
    //
    // Diffing every worktree up front does not scale: a checkout with 18 worktrees and 12
    // submodules spent 42s of git work in an 8s window on window open, and an extension host busy
    // with that cannot paint the tree — rows stayed empty long after their diffs were ready.
    for (const node of [...created, ...moved]) {
      if (node === this.expanded || (!node.ref && node.isCurrent)) this.enqueue(node);
      else node.stale = true;
    }
    void this.linkPrs();
  }

  async onExpand(node: Node, view: vscode.TreeView<Node>) {
    if (!(node instanceof WorktreeNode) || node === this.expanded) return;
    const previous = this.expanded;
    this.expanded = node;
    node.stale = true;
    // Background refreshes for rows that are now collapsed only delay this one; they are marked
    // stale already and re-diff whenever they are expanded again.
    this.queue = this.queue.filter((n) => n === node);
    this.rewatchExpanded();
    if (previous) {
      // Accordion: VS Code has no per-item collapse API, so collapse all and re-reveal the new one.
      await vscode.commands.executeCommand('workbench.actions.treeView.crosscut.collapseAll');
      await view.reveal(node, { expand: true, select: false, focus: false });
    }
  }

  /**
   * "Open All Changes" on a collapsed row: make it the expanded one first (so the accordion and the
   * file watcher follow), wait for its diff, then open.
   */
  async openAll(node: WorktreeNode | FolderNode | SubmoduleNode, view: vscode.TreeView<Node>, reveal?: string) {
    if (node instanceof WorktreeNode) {
      if (node !== this.expanded) {
        await view.reveal(node, { expand: true, select: true, focus: false });
        await this.onExpand(node, view); // no-op if the reveal's expand event already did it
      }
      if (node.stale || !node.diff) await this.reload(node);
    }
    const files = collectFiles(node instanceof WorktreeNode ? node.tree : node.children);
    await openAll(node, reveal ? files.find((f) => f.absPath === reveal) : undefined);
  }

  /** The repos in the tree, for the CLI to find the window showing its repo. */
  commonDirs(): string[] {
    return this.repos.map((r) => r.commonDir);
  }

  /** `crosscut present`: open a row's changes, optionally under a new comparison, from outside. */
  async present(req: PresentRequest, view: vscode.TreeView<Node>): Promise<PresentResponse> {
    let node: WorktreeNode | undefined;
    if (req.commit) {
      const main = this.repos.find((r) => r.commonDir === req.commonDir)?.worktrees[0]?.wt.path;
      if (!main) return { ok: false, message: `${req.commonDir} is not in the Crosscut tree` };
      await this.openAdHoc(main, req.commit, view);
      node = this.branchNodes.get(`${req.commonDir}\0adhoc/${req.commit.id}`);
    } else if (req.ref) {
      node = this.branchNodes.get(`${req.commonDir}\0${req.ref}`);
      // A branch checked out in a worktree has no branch row; its worktree row is the one.
      const short = req.ref.replace(/^refs\/heads\//, '');
      node ??= [...this.nodes.values()].find((n) => n.wt.branch === short && this.repoOf(n) === req.commonDir);
    } else {
      node = this.nodes.get(req.worktree);
    }
    if (!node) return { ok: false, message: `no row for ${req.ref ?? req.worktree} in the Crosscut tree` };
    if (req.mode === 'uncommitted' && node.ref) return { ok: false, message: 'a branch has no uncommitted changes' };
    if (req.mode && req.mode !== this.modeFor(node)) {
      await this.state.update(`mode:${node.key}`, req.mode);
      node.stale = true;
    }
    const reveal = req.file && path.join(node.ref ? node.wt.path : req.worktree, req.file);
    await this.openAll(node, view, reveal);
    if (node.error) return { ok: false, message: node.error };
    const n = node.diff ? countFiles(node.diff) : 0;
    return { ok: true, message: `opened ${n} file${n === 1 ? '' : 's'}, ${node.baseLabel}` };
  }

  private repoOf(node: WorktreeNode): string | undefined {
    return this.repos.find((r) => r.worktrees.includes(node))?.commonDir;
  }

  onCollapse(node: Node) {
    if (node === this.expanded) {
      this.expanded = undefined;
      this.rewatchExpanded();
    }
  }

  /** Returns whether anything visible changed. Concurrent calls for one node share a single load. */
  private loadChanges(node: WorktreeNode): Promise<boolean> {
    node.loading ??= this.doLoadChanges(node).finally(() => (node.loading = undefined));
    return node.loading;
  }

  private async doLoadChanges(node: WorktreeNode): Promise<boolean> {
    const t = performance.now();
    const changed = await this.doLoadChangesInner(node);
    log.info(`load ${nodeName(node)} ${changed ? 'changed' : 'unchanged'} in ${(performance.now() - t).toFixed(0)}ms`);
    return changed;
  }

  private async doLoadChangesInner(node: WorktreeNode): Promise<boolean> {
    const mode = this.modeFor(node);
    const cwd = node.wt.path;
    const tip = node.ref?.sha ?? 'HEAD';
    const before = node.diff && JSON.stringify([node.diff, node.baseLabel, node.error]);
    let diff: RepoDiff;
    let baseLabel: string;
    let error: string | undefined;
    try {
      let baseRef = 'HEAD';
      node.rebaseConflicts = undefined;
      let preview: RebasePreview | undefined;
      if (mode.startsWith('rebase:')) {
        const onto = mode.slice('rebase:'.length);
        preview = await previewRebase(cwd, onto, tip);
        node.rebaseConflicts = new Map(preview.conflicts.map((c) => [c.path, c]));
        const n = preview.conflicts.length;
        baseLabel = `rebase onto ${shortName(onto)}: ${
          n ? `${n} conflicted file${n === 1 ? '' : 's'} in ${preview.conflictedCommits} of ${preview.replayed} commits` : `clean, ${preview.replayed} commits`
        }`;
      } else if (mode === 'uncommitted') {
        baseLabel = 'uncommitted';
      } else if (mode.startsWith('commit:')) {
        baseRef = mode.slice('commit:'.length);
        const n = await countCommits(cwd, baseRef, tip);
        baseLabel = Number.isNaN(n) ? `vs ${baseRef.slice(0, 7)}` : `last ${n} commit${n === 1 ? '' : 's'}`;
      } else if (mode.startsWith('base:')) {
        const ref = mode.slice('base:'.length);
        const mb = await mergeBase(cwd, ref, tip);
        if (!mb) throw new Error(`${ref} not found`);
        baseRef = mb;
        baseLabel = `vs ${shortName(ref)}`;
      } else {
        const cfg = vscode.workspace.getConfiguration('crosscut');
        const base = await detectBaseBranch(cwd, cfg.get<string>('baseBranch', ''));
        // A stacked branch diffed against the base branch would claim its predecessor's changes.
        const stack =
          base && cfg.get<boolean>('detectStackedBase', true)
            ? await stackCandidates(cwd, tip, base, node.ref?.ref ?? (node.wt.branch && `refs/heads/${node.wt.branch}`) ?? undefined)
            : [];
        const against = stack[0]?.ref ?? base;
        const mb = against && (await mergeBase(cwd, against, tip));
        if (against && mb) {
          baseRef = mb;
          baseLabel = stack[0] ? `vs ${stack[0].short} (stacked)` : `vs ${base}`;
        } else if (node.ref) {
          throw new Error('no base branch found to compare against');
        } else {
          baseLabel = 'uncommitted (no base branch found)';
        }
      }
      if (node.ref && !(await hasRef(cwd, tip))) {
        throw new Error(`commit ${tip.slice(0, 10)} is not in this clone — fetch it first`);
      }
      diff = preview ? preview.diff : node.ref ? await loadRefDiff(cwd, baseRef, tip) : await loadDiff(cwd, baseRef);
      node.message = (await git(cwd, ['show', '-s', '--format=%B', tip]).catch(() => '')).trim();
    } catch (e) {
      diff = { root: cwd, baseRef: 'HEAD', changes: [] };
      baseLabel = 'error';
      error = e instanceof Error ? e.message : String(e);
    }
    node.stale = false;
    if (before === JSON.stringify([diff, baseLabel, error])) return false;
    node.diff = diff;
    node.baseRef = diff.baseRef;
    node.baseLabel = baseLabel;
    node.error = error;
    node.tree = buildFileTree(node, diff, node);
    node.threadSignature = undefined; // snapshot paths changed, so threads must be rebuilt
    storeOwners.set(node.store, node);
    snapshot(node.store, diff);
    void this.loadComments(node);
    const saved: SavedDiff = { mode, baseLabel, diff };
    void fs
      .mkdir(node.store, { recursive: true })
      .then(() => fs.writeFile(path.join(node.store, 'diff.json'), JSON.stringify(saved)))
      .catch(() => undefined);
    return true;
  }

  /** The shared git dir: worktrees added/removed, and HEAD moving in any of them. */
  private rewatchRepos() {
    const key = this.repos.map((r) => r.commonDir).join('\0');
    if (key === this.repoWatchKey) return;
    this.repoWatchKey = key;
    this.repoWatchers.forEach((w) => w.dispose());
    this.repoWatchers = this.repos.map((repo) =>
      watch(
        new vscode.RelativePattern(vscode.Uri.file(repo.commonDir), '{HEAD,packed-refs,refs/heads/**,refs/remotes/**,worktrees/*,worktrees/*/HEAD}'),
        () => this.scheduleRefresh(),
      ),
    );
  }

  /** Working-tree files of the expanded worktree only. Recreated only when that worktree changes. */
  private rewatchExpanded() {
    const target = this.expanded && !this.expanded.ref ? this.expanded.wt.path : undefined;
    if (target === this.expandedWatchPath) return;
    this.expandedWatchPath = target;
    this.expandedWatcher?.dispose();
    this.expandedWatcher = undefined;
    this.pendingPaths.clear();
    if (!target) return;
    this.expandedWatcher = watch(new vscode.RelativePattern(vscode.Uri.file(target), '**/*'), (uri) => {
      const p = uri.fsPath;
      if (p.includes(`${path.sep}node_modules${path.sep}`) || p.includes(`${path.sep}.git${path.sep}`) || p.endsWith(`${path.sep}.git`)) return;
      this.scheduleExpandedRefresh(p);
    });
  }

  getParent(node: Node): Node | undefined {
    if (node instanceof FileNode || node instanceof FolderNode || node instanceof SubmoduleNode) return node.parent;
    if (node instanceof WorktreeNode || node instanceof BranchGroupNode) return node.parent;
    return undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const t = performance.now();
    const out = await this.getChildrenInner(node);
    log.info(`getChildren ${nodeName(node)} -> ${out.length} in ${(performance.now() - t).toFixed(1)}ms`);
    return out;
  }

  private async getChildrenInner(node?: Node): Promise<Node[]> {
    if (!node) return this.repos.length === 1 ? this.repos[0].children : this.repos;
    if (node instanceof RepoNode) return node.children;
    if (node instanceof BranchGroupNode) return node.branches;
    if (node instanceof WorktreeNode) {
      if (!node.diff && node.ref) await this.restore(node); // branch rows load lazily, on first expand
      if (!node.diff) {
        // Update the count/base label in the row itself; its children are then served from node.tree.
        if (await this.loadChanges(node)) this.emitter.fire(node);
      } else if (node.stale) {
        this.enqueue(node, true); // show the cached files now, redraw if the fresh diff differs
      }
      return node.tree;
    }
    if (node instanceof FolderNode || node instanceof SubmoduleNode) return node.children;
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const t = performance.now();
    const item = this.getTreeItemInner(node);
    const ms = performance.now() - t;
    if (ms > 5) log.debug(`getTreeItem ${nodeName(node)} slow: ${ms.toFixed(1)}ms`);
    return item;
  }

  private getTreeItemInner(node: Node): vscode.TreeItem {
    if (node instanceof RepoNode) {
      const item = new vscode.TreeItem(path.basename(path.dirname(node.commonDir)), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = node.commonDir;
      return item;
    }

    if (node instanceof BranchGroupNode) {
      const item = new vscode.TreeItem(
        node.kind === 'opened'
          ? 'Opened commits & PRs'
          : node.kind === 'prs'
            ? 'Open pull requests'
            : node.kind === 'local'
              ? 'Local branches (no worktree)'
              : 'Remote branches',
        node.kind === 'opened' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${node.branches.length}`;
      item.iconPath = new vscode.ThemeIcon(
        node.kind === 'opened' ? 'history' : node.kind === 'prs' ? 'git-pull-request' : node.kind === 'local' ? 'git-branch' : 'cloud',
      );
      item.contextValue =
        node.kind === 'remote' ? 'remotes' : node.kind === 'local' ? 'locals' : node.kind === 'prs' ? 'prs' : 'opened';
      item.tooltip =
        node.kind === 'prs'
          ? 'Every open pull request, diffed against the merge-base with the branch it actually targets.'
          : 'Diffed straight from git objects against the merge-base with the base branch; nothing is checked out.';
      item.id = `g:${node.commonDir}:${node.kind}`;
      return item;
    }

    if (node instanceof WorktreeNode && node.ref) {
      const b = node.ref;
      const item = new vscode.TreeItem(
        b.short,
        node === this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const n = node.diff && countFiles(node.diff);
      const count = n === undefined ? '' : `${n} file${n === 1 ? '' : 's'} · `;
      const m = this.modeFor(node);
      const label = node.diff ? node.baseLabel : m.startsWith('commit:') ? `vs ${m.slice(7, 14)}` : 'branch';
      // Push state matters most on local branches: unpushed work only exists here.
      const sync = b.remote
        ? ''
        : !b.upstream
          ? ' · ⬆ unpushed'
          : b.track === 'gone'
            ? ' · ⚠ upstream gone'
            : b.track
              ? ` · ${b.track.replace('ahead ', '↑').replace('behind ', '↓').replace(', ', ' ')}`
              : ' · in sync';
      // Codicon markup does not render in a tree description, so these are plain characters.
      const files = new Set([...node.commentCounts].filter(([, n]) => n > 0).map(([p]) => p)).size;
      const inline = [...node.commentCounts.values()].reduce((a, b) => a + b, 0);
      const review = [
        node.reviews.some((r) => r.state === 'CHANGES_REQUESTED') ? '✗ changes requested' : '',
        !node.reviews.some((r) => r.state === 'CHANGES_REQUESTED') && node.reviews.some((r) => r.state === 'APPROVED') ? '✓ approved' : '',
        inline ? `💬 ${inline} in ${files} file${files === 1 ? '' : 's'}` : '',
        drafts.get(node).length ? `✎ ${drafts.get(node).length} draft` : '',
      ]
        .filter(Boolean)
        .map((x) => ` · ${x}`)
        .join('');
      item.description = node.error
        ? `⚠ ${shortError(node.error)}`
        : `${count}${label} · ${b.when}${b.author ? ` · ${b.author}` : ''}${sync}${review}`;
      item.tooltip = describe(node, b);
      item.iconPath = new vscode.ThemeIcon(
        node.error
          ? 'warning'
          : b.ref.startsWith('adhoc/')
            ? b.ref.includes('/pr-')
              ? 'git-pull-request'
              : 'git-commit'
            : b.remote
              ? 'cloud'
              : !b.upstream
                ? 'git-branch'
                : 'git-merge',
      );
      // Suffixes gate the menus: `.pr` only when a pull request is known, `.web` only when there is
      // a GitHub page to open at all (an unpushed local branch has neither).
      const kind = b.ref.startsWith('adhoc/') ? 'branch.adhoc' : b.remote ? 'branch' : b.track === 'gone' ? 'branch.gone' : 'branch.local';
      const hasWeb = node.webUrl || node.prNumber || b.remote || (b.upstream && b.track !== 'gone'); // a gone upstream 404s
      item.contextValue = `${kind}${hasWeb ? '.web' : ''}${node.prNumber ? '.pr' : ''}${drafts.get(node).length ? '.drafts' : ''}`;
      item.id = `b:${node.key}`;
      return item;
    }

    if (node instanceof WorktreeNode) {
      const { wt } = node;
      // Label by folder: branch names repeat across worktrees' history, the folder is what you navigate to.
      const name = wt.branch ?? `(detached ${wt.head.slice(0, 7)})`;
      const main = (node.parent instanceof RepoNode ? node.parent : this.repos[0])?.worktrees[0];
      const item = new vscode.TreeItem(
        path.basename(wt.path),
        node === this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const n = node.diff && countFiles(node.diff);
      const count = n === undefined ? '' : `${n} file${n === 1 ? '' : 's'} · `;
      const m = this.modeFor(node);
      const label = node.diff ? node.baseLabel : m.startsWith('commit:') ? `vs ${m.slice(7, 14)}` : m;
      const where = wt.isMain ? 'main checkout' : main ? shortLocation(wt.path, main.wt.path) : '';
      item.description = node.error
        ? `⎇ ${name} · ⚠ ${shortError(node.error)}`
        : `⎇ ${name} · ${count}${label}${where ? ` · ${where}` : ''}`;
      const md = describe(node);
      md.appendMarkdown(
        `\n\n---\n\n**${name}**${node.isCurrent ? ' — open in this window' : ''}${wt.isMain ? ' — main checkout' : ''}\n\n\`${wt.path}\`\n\n` +
          `Compared against: ${node.baseLabel}${node.baseRef && node.baseRef !== 'HEAD' ? ` (\`${node.baseRef.slice(0, 10)}\`)` : ''}` +
          `${node.error ? `\n\n⚠ ${node.error}` : ''}`,
      );
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon(
        node.error ? 'warning' : node.isCurrent ? 'pass-filled' : wt.isMain ? 'home' : 'git-branch',
      );
      item.contextValue =
        (node.prNumber ? 'worktree.pr' : wt.branch ? 'worktree.web' : 'worktree') + (drafts.get(node).length ? '.drafts' : '');
      item.id = `wt:${wt.path}`;
      return item;
    }

    if (node instanceof FolderNode) {
      // Large diffs start with folders collapsed so the view stays responsive.
      const big = node.owner.diff !== undefined && countFiles(node.owner.diff) > 150;
      const item = new vscode.TreeItem(
        node.label,
        big ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.resourceUri = itemUri(path.join(node.diff.root, node.rel));
      const within = [...node.owner.commentCounts].filter(([p]) => p.startsWith(`${node.rel}/`)).reduce((a, [, n]) => a + n, 0);
      if (within) item.description = `💬 ${within}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'group';
      item.tooltip = node.rel;
      item.id = `d:${node.owner.key}:${node.diff.root}:${node.rel}`;
      return item;
    }

    if (node instanceof SubmoduleNode) {
      const { sub } = node.change;
      const item = new vscode.TreeItem(path.posix.basename(node.change.path), vscode.TreeItemCollapsibleState.Expanded);
      const n = countFiles(sub);
      item.description = `submodule · ${n} file${n === 1 ? '' : 's'}`;
      item.tooltip = `${sub.root}\nCompared against ${sub.baseRef.slice(0, 10)} (the commit the parent records at its base)${
        sub.headRef ? ` up to ${sub.headRef.slice(0, 10)}` : ''
      }`;
      item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor(STATUS_COLOR[node.change.status] ?? 'foreground'));
      item.id = `s:${node.owner.key}:${sub.root}`;
      item.contextValue = 'group';
      return item;
    }

    const { change, owner } = node;
    if (change.untrackedDir) {
      const item = new vscode.TreeItem(`${path.posix.basename(change.path)}/`);
      item.description = 'untracked folder';
      item.tooltip = `Untracked folder (contents not listed): ${node.absPath}`;
      item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor(STATUS_COLOR['?']));
      item.id = `u:${owner.key}:${node.diff.root}:${change.path}`;
      return item;
    }
    const item = new vscode.TreeItem(itemUri(node.absPath));
    item.label = path.basename(change.path);
    const n = owner.commentCounts.get(change.path) ?? 0;
    item.description = `${change.status === '?' ? 'U' : change.status}${change.oldPath ? `  ← ${change.oldPath}` : ''}${
      n ? `  💬 ${n}` : ''
    }`;
    item.tooltip = `${STATUS_LABEL[change.status] ?? change.status}: ${node.absPath}`;
    const conflict = node.diff === owner.diff ? owner.rebaseConflicts?.get(change.path) : undefined;
    if (conflict) {
      item.description = `conflict · ${conflict.commits.length} commit${conflict.commits.length === 1 ? '' : 's'}`;
      item.tooltip = `Conflicts when rebased, in:\n${conflict.commits.map((c) => `  ${c}`).join('\n')}\n\nShown as the last conflicting commit leaves it, markers included.`;
    }
    item.iconPath = new vscode.ThemeIcon(
      conflict ? 'warning' : change.status === 'D' ? 'diff-removed' : change.status === 'A' || change.status === '?' ? 'diff-added' : 'diff-modified',
      new vscode.ThemeColor(STATUS_COLOR[change.status] ?? 'foreground'),
    );
    item.contextValue = (owner.isCurrent && !owner.ref ? 'file' : 'file.foreign') + (n ? '.commented' : '');
    item.command = { command: 'crosscut.openDiff', title: 'Open Diff', arguments: [node] };
    item.id = `f:${owner.key}:${node.diff.root}:${change.path}`;
    return item;
  }

  dispose() {
    this.repoWatchers.forEach((w) => w.dispose());
    this.expandedWatcher?.dispose();
    clearTimeout(this.listTimer);
    clearTimeout(this.diffTimer);
  }
}

function watch(pattern: vscode.RelativePattern, onEvent: (uri: vscode.Uri) => void): vscode.Disposable {
  const w = vscode.workspace.createFileSystemWatcher(pattern);
  w.onDidChange(onEvent);
  w.onDidCreate(onEvent);
  w.onDidDelete(onEvent);
  return w;
}

/**
 * Tree rows get a private scheme instead of file://: the icon theme still picks icons from the
 * file name, but git/GitLens/etc. decoration providers skip them. With file:// URIs every row
 * rendered makes those providers run git against paths outside the workspace, which stalls the tree.
 */
function itemUri(absPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'crosscut-item', path: absPath });
}

/** Where a worktree lives, short enough for a row: relative to the main checkout, an agent
 * scratchpad, or its parent dir. */
function shortLocation(wtPath: string, mainPath: string): string {
  const parent = path.dirname(wtPath);
  if (isInside(parent, mainPath)) return `in repo: ${path.relative(mainPath, parent) || '.'}`;
  if (path.dirname(parent) === path.dirname(mainPath) || parent === path.dirname(mainPath)) return 'next to repo';
  const scratch = /\/([0-9a-f]{8})[0-9a-f-]*\/scratchpad$/.exec(parent);
  if (scratch) return `scratchpad ${scratch[1]}`;
  const home = process.env.HOME;
  const shown = home && parent.startsWith(home + path.sep) ? '~' + parent.slice(home.length) : parent;
  const parts = shown.split(path.sep);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : shown;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Commands

const DESC_SCHEME = 'crosscut-desc';
const descriptions = new Map<string, string>(); // uri -> markdown
const descChanged = new vscode.EventEmitter<vscode.Uri>();

/**
 * GitHub shorthand in a description is plain text in a markdown preview. Turn `#123`,
 * `org/repo#123`, `@user` and bare commit hashes into links; titles are filled in later, once
 * looked up. Code spans and fenced blocks are left alone.
 */
function linkifyGithub(text: string, slug: string, titles: Map<number, RefTitle>): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/); // odd indexes are code, left untouched
  return parts
    .map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m) // existing links stay as they are
        .replace(/(^|[\s(])([\w.-]+\/[\w.-]+)#(\d+)\b/g, (_m, pre, other, n) => `${pre}[${other}#${n}](https://github.com/${other}/issues/${n})`)
        .replace(/(^|[\s(])#(\d+)\b/g, (_m, pre, n) => {
          const t = titles.get(Number(n));
          const label = t ? `#${n} ${t.title}${t.state === 'closed' ? ' (closed)' : ''}` : `#${n}`;
          return `${pre}[${label}](https://github.com/${slug}/issues/${n})`;
        })
        .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/g, (_m, pre, user) => `${pre}[@${user}](https://github.com/${user})`)
        .replace(/(^|[\s(])([0-9a-f]{7,40})\b/g, (m, pre, sha) => `${pre}[\`${sha.slice(0, 8)}\`](https://github.com/${slug}/commit/${sha})`);
    })
    .join('');
}

function referencedNumbers(text: string): number[] {
  const prose = text.split(/(```[\s\S]*?```|`[^`\n]*`)/).filter((_, i) => i % 2 === 0).join(' ');
  return [...new Set([...prose.matchAll(/(?:^|[\s(])#(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** owner/repo for the repo a row belongs to, from its origin URL. */
async function repoSlug(cwd: string): Promise<string | undefined> {
  const url = await git(cwd, ['remote', 'get-url', 'origin']).then((o) => o.trim()).catch(() => '');
  return /(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/.exec(url)?.[1];
}

/** The full PR description or commit message, in a real editor: scrollable, selectable, linkable. */
async function showDescription(node: WorktreeNode) {
  const d = node.details;
  const parts: string[] = [];
  if (d) {
    parts.push(`# #${d.number} ${d.title}`);
    parts.push(
      `**${d.merged ? 'merged' : d.draft ? 'draft' : d.state.toLowerCase()}** · opened by ${d.author} · \`${d.headRef}\` → \`${d.baseRef}\`` +
        ` · +${d.additions} −${d.deletions} in ${d.changedFiles} files · [open on GitHub](${d.url})`,
    );
    if (d.body.trim()) parts.push('---', d.body);
  } else if (node.ref) {
    parts.push(`# ${node.ref.short}`, `\`${node.ref.sha}\` · ${node.ref.when}${node.ref.author ? ` · ${node.ref.author}` : ''}`);
  } else {
    parts.push(`# ${node.wt.branch ?? path.basename(node.wt.path)}`, `\`${node.wt.path}\``);
  }
  if (node.message && !d) parts.push('---', '## Commit message', '```', node.message, '```');
  for (const r of node.reviews) {
    parts.push('---', `## ${r.author} — ${r.state.toLowerCase().replace('_', ' ')}`, r.body || '_(no summary)_');
  }
  const name = d ? `PR-${d.number}.md` : `${(node.ref?.short ?? node.wt.branch ?? 'worktree').replace(/[/\\]/g, '-')}.md`;
  const uri = vscode.Uri.from({ scheme: DESC_SCHEME, path: `/${name}` });
  const raw = parts.join('\n\n');
  const slug = await repoSlug(node.wt.path);
  descriptions.set(uri.toString(), slug ? linkifyGithub(raw, slug, new Map()) : raw);
  // Referenced issues/PRs get their titles once looked up; the preview refreshes in place.
  if (slug) {
    void refTitles(node.wt.path, referencedNumbers(raw)).then((titles) => {
      if (!titles.size) return;
      descriptions.set(uri.toString(), linkifyGithub(raw, slug, titles));
      descChanged.fire(uri);
    });
  }
  await vscode.commands.executeCommand('markdown.showPreview', uri).then(undefined, async () => {
    // no markdown preview available: show the source instead
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  });
}

async function diffSides(node: FileNode): Promise<{ left: vscode.Uri; right: vscode.Uri }> {
  const { change, diff } = node;
  const cwd = diff.root;
  const store = node.owner.store;
  const leftRel = change.oldPath ?? change.path;
  const empty = (rel: string) => refUri(path.join(cwd, rel), { cwd, ref: '', rel });
  const left = change.status === 'A' || change.status === '?' ? empty(leftRel) : await sideUri(store, diff, diff.baseRef, leftRel);
  let right: vscode.Uri;
  if (change.status === 'D') right = empty(change.path);
  else if (diff.headRef) right = await sideUri(store, diff, diff.headRef, change.path); // branch tip snapshot
  else right = vscode.Uri.file(node.absPath); // the real file: full IntelliSense, editable
  return { left, right };
}

async function openDiff(node: FileNode) {
  const { change, owner } = node;
  if (change.gitlink) {
    vscode.window.showInformationMessage(`${change.path} is a submodule that isn't checked out in this worktree, so only its pointer changed.`);
    return;
  }
  const t0 = performance.now();
  const { left, right } = await diffSides(node);
  const t1 = performance.now();
  const branch = owner.ref?.short ?? owner.wt.branch ?? path.basename(owner.wt.path);
  const title = `${path.basename(change.path)} [${branch}: ${owner.baseLabel}]`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
  log.info(
    `openDiff ${change.path}: sides ${(t1 - t0).toFixed(0)}ms, editor ${(performance.now() - t1).toFixed(0)}ms (left ${left.scheme})`,
  );
}

function collectFiles(nodes: Child[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n instanceof FileNode) {
      if (!n.change.gitlink && !n.change.untrackedDir) out.push(n);
    } else collectFiles(n.children, out);
  }
  return out;
}

/** All changes under a worktree, folder or submodule in one multi-file diff editor. */
async function openAll(node: WorktreeNode | FolderNode | SubmoduleNode, reveal?: FileNode) {
  const files = collectFiles(node instanceof WorktreeNode ? node.tree : node.children);
  if (!files.length) return;
  const owner = files[0].owner;
  const branch = owner.ref?.short ?? owner.wt.branch ?? path.basename(owner.wt.path);
  const scope = node instanceof WorktreeNode ? '' : ` ${node instanceof FolderNode ? node.rel : node.change.path}`;
  // Files with review comments first: the multi-file view is long, and they are what you came for.
  files.sort((a, b) => (owner.commentCounts.get(b.change.path) ?? 0) - (owner.commentCounts.get(a.change.path) ?? 0));
  const resources = await Promise.all(
    files.map(async (f) => {
      const { left, right } = await diffSides(f);
      return [vscode.Uri.file(f.absPath), left, right];
    }),
  );
  const title = `${branch}${scope} (${owner.baseLabel})`;
  const all: AllChanges = {
    title,
    owner: `${owner.key}\0${scope}`,
    // VS Code reuses an open editor with the same source URI and ignores the new file list, so the
    // URI carries the comparison too: switching it gets a fresh editor. Hashed because a worktree
    // key is an absolute path, and a URI path may not start with `//`.
    source: vscode.Uri.from({
      scheme: 'crosscut-all',
      path: `/${crypto
        .createHash('sha1')
        .update(JSON.stringify([owner.key, scope, owner.baseLabel, owner.diff?.baseRef, owner.diff?.headRef, files.map((f) => f.change.path)]))
        .digest('hex')}`,
    }),
    files: files.map((f, i) => ({ rel: f.change.path, status: f.change.status, left: resources[i][1], right: resources[i][2] })),
  };
  // An editor this row opened under a different comparison is stale now; replace it rather than
  // leave two side by side.
  for (const [t, other] of allChanges) {
    if (other.owner !== all.owner || other.source.toString() === all.source.toString()) continue;
    allChanges.delete(t);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => tab.label === t);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }
  allChanges.set(title, all);
  updateAllChangesContext();
  // The private command rather than `vscode.changes`: it is the only one that can reveal a file
  // later (goToFileInAll), and reopening the same source URI reuses the editor instead of stacking tabs.
  const at = reveal && all.files[files.indexOf(reveal)]?.right;
  try {
    await openMultiDiff(all, at);
  } catch (e) {
    log.warn(`_workbench.openMultiDiffEditor failed, falling back to vscode.changes: ${e}`);
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }
}

/** The whole row's changes in one editor, scrolled to this file. */
function openInAll(node: FileNode) {
  return openAll(node.owner, node);
}

/**
 * Listen for the `crosscut` CLI on a per-window unix socket, advertised by an entry file the CLI
 * reads to find the window showing its repo. The entry is rewritten as repos and focus change.
 */
function serveCli(provider: WorktreeDiffsProvider, view: vscode.TreeView<Node>): vscode.Disposable {
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
        log.info(`cli: present ${req.ref ?? req.worktree}${req.mode ? ` as ${req.mode}` : ''}${req.file ? ` at ${req.file}` : ''}`);
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
 * own node, so it works where no node is installed. Rewritten on every activation once it exists,
 * so it follows extension updates.
 */
async function installCli(context: vscode.ExtensionContext, explicit: boolean) {
  const bin = path.join(require('os').homedir(), '.local', 'bin', 'crosscut');
  if (!explicit && !(await fs.stat(bin).then(() => true, () => false))) return;
  const script = `#!/bin/sh\n# Written by the Crosscut VS Code extension.\nexec "${process.execPath}" "${path.join(context.extensionPath, 'out', 'cli.js')}" "$@"\n`;
  if ((await fs.readFile(bin, 'utf8').catch(() => '')) === script) return;
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, script, { mode: 0o755 });
  if (explicit) void vscode.window.showInformationMessage(`Installed ${bin}. Try: crosscut present`);
}

interface AllChanges {
  title: string;
  owner: string; // the row and folder it was opened for
  source: vscode.Uri;
  files: { rel: string; status: string; left: vscode.Uri; right: vscode.Uri }[];
}
const allChanges = new Map<string, AllChanges>(); // by editor title

/** Shows the go-to-file button only while one of our multi-file diff editors is the active tab. */
function updateAllChangesContext() {
  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
  void vscode.commands.executeCommand('setContext', 'crosscut.allChangesActive', !!label && allChanges.has(label));
}

function openMultiDiff(all: AllChanges, reveal?: vscode.Uri) {
  return vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    title: all.title,
    multiDiffSourceUri: all.source,
    resources: all.files.map((f) => ({ originalUri: f.left, modifiedUri: f.right })),
    reveal: reveal && { modifiedUri: reveal },
  });
}

/** Quick pick over the files in the active "Open All Changes" editor, scrolling to the chosen one. */
async function goToFileInAll() {
  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
  const all = (label && allChanges.get(label)) ?? [...allChanges.values()].pop();
  if (!all) return;
  type Item = vscode.QuickPickItem & { file: AllChanges['files'][number] };
  const picked = await vscode.window.showQuickPick<Item>(
    all.files.map((f) => ({
      label: path.posix.basename(f.rel),
      description: `${f.status}  ${path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel)}`,
      iconPath: vscode.ThemeIcon.File,
      resourceUri: vscode.Uri.file(f.rel),
      file: f,
    })),
    { title: `Go to file in ${all.title}`, placeHolder: 'Type to filter by name or folder', matchOnDescription: true },
  );
  if (picked) await openMultiDiff(all, picked.file.right);
}

async function compareWithCurrent(node: FileNode) {
  const current = node.owner.repo.current;
  if (!current) {
    vscode.window.showWarningMessage('No worktree of this repository is open in this window.');
    return;
  }
  const mine = vscode.Uri.file(path.join(current.path, path.relative(node.owner.wt.path, node.absPath)));
  const theirs = (await diffSides(node)).right;
  const title = `${path.basename(node.change.path)} (${current.branch ?? 'current'} ↔ ${node.owner.ref?.short ?? node.owner.wt.branch ?? 'worktree'})`;
  await vscode.commands.executeCommand('vscode.diff', mine, theirs, title);
}

// ---------------------------------------------------------------------------
// Blame annotations. Snapshot files live outside any repo, so GitLens and friends can't blame them;
// here the path maps back to (repo, commit, path) and `git blame <commit>` fills in the rest.

interface BlameTarget {
  root: string;
  ref?: string; // undefined = blame the working tree
  rel: string;
}

const repoRoots = new Map<string, string | undefined>(); // containing dir -> that file's repo root

/** The repo a real file belongs to. `git show <sha>:<path>` needs a repo-relative path, not an absolute one. */
async function repoRootOf(dir: string): Promise<string | undefined> {
  if (!repoRoots.has(dir)) {
    repoRoots.set(
      dir,
      await git(dir, ['rev-parse', '--show-toplevel'])
        .then((o) => o.trim())
        .catch(() => undefined),
    );
  }
  return repoRoots.get(dir);
}

/**
 * The branch name GitHub knows, from the full refname: `refs/heads/feature/x` and
 * `refs/remotes/origin/feature/x` are both `feature/x`. Stripping the first path segment of the
 * short name is wrong — it eats the first segment of a slashed local branch.
 */
/** git/gh failures are multi-line and noisy; a row shows the gist and the tooltip carries the rest. */
function shortError(message: string): string {
  const first = message.split('\n').find((l) => l.trim()) ?? message;
  const cleaned = first.replace(/^git [^:]*: /, '').replace(/^fatal: /, '');
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

/** Tooltip for a row: the pull request's description, or the tip commit's full message. */
function describe(node: WorktreeNode, b?: BranchRef): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = false;
  const d = node.details;
  if (d) {
    const state = d.merged ? 'merged' : d.draft ? 'draft' : d.state.toLowerCase();
    md.appendMarkdown(`**[#${d.number} ${d.title}](${d.url})** · ${state}\n\n`);
    md.appendMarkdown(`$(person) ${d.author} · \`${d.headRef}\` → \`${d.baseRef}\` · +${d.additions} −${d.deletions} in ${d.changedFiles} files\n\n`);
    if (d.body.trim()) md.appendMarkdown(`---\n\n${clip(d.body)}\n\n`);
  }
  if (b && !d) {
    md.appendMarkdown(`**${b.short}** at \`${b.sha.slice(0, 10)}\`\n\n`);
    md.appendMarkdown(`Last commit ${b.when}${b.author ? ` by ${b.author}` : ''}\n\n`);
    if (!b.remote)
      md.appendMarkdown(
        b.upstream ? `Upstream: \`${b.upstream}\`${b.track ? ` (${b.track})` : ' (in sync)'}\n\n` : 'Never pushed — exists only in this clone\n\n',
      );
  }
  // For a PR the description is the content; its head commit message just repeats the last commit.
  if (node.message && !d) md.appendMarkdown(`---\n\n${clip(node.message)}\n\n`);
  if (node.reviews.length) {
    md.appendMarkdown(`---\n\n${node.reviews.map((r) => `**${r.author}** ${r.state.toLowerCase().replace('_', ' ')}${r.body ? `: ${r.body.split('\n')[0].slice(0, 120)}` : ''}`).join('\n\n')}\n\n`);
  }
  if (node.error) md.appendMarkdown(`\n\n⚠ ${node.error}`);
  if (node.details?.body.trim() || (!node.details && node.message && node.message.split('\n').length > 3)) {
    md.appendMarkdown(`\n\n---\n\n$(book) Use **Show Description** on the row for the full text.`);
  }
  return md;
}

/** Tooltips can't be scrolled or moved into, so they carry a taste; the full text opens in an editor. */
function clip(text: string, lines = 12, chars = 800): string {
  const kept = text.split('\n').slice(0, lines).join('\n');
  return kept.length > chars || kept.length < text.length ? `${kept.slice(0, chars).trimEnd()}\n\n…` : kept;
}

const shortName = (ref: string) => ref.replace(/^refs\/(heads\/|remotes\/[^/]+\/)/, '');

function branchNameOf(b: BranchRef): string {
  const m = /^refs\/(?:heads\/(.+)|remotes\/[^/]+\/(.+))$/.exec(b.ref);
  return m?.[1] ?? m?.[2] ?? b.short;
}

/** The main checkout of the repo a path belongs to (worktree paths differ from the main one). */
async function repoMainPath(cwd: string): Promise<string | undefined> {
  return git(cwd, ['worktree', 'list', '--porcelain'])
    .then((o) => /^worktree (.+)$/m.exec(o)?.[1])
    .catch(() => undefined);
}

async function blameTarget(uri: vscode.Uri): Promise<BlameTarget | undefined> {
  if (uri.scheme !== 'file') return undefined; // the empty side of an add/delete
  if (isInside(uri.fsPath, storageRoot)) {
    for (const [repoDir, root] of snapshotOrigins) {
      if (!isInside(uri.fsPath, repoDir)) continue;
      const rest = path.relative(repoDir, uri.fsPath).split(path.sep);
      const ref = rest.shift()!;
      return { root, ref, rel: rest.join('/') };
    }
    return undefined; // a snapshot from a previous session: its origin isn't loaded yet
  }
  const root = await repoRootOf(path.dirname(uri.fsPath));
  if (!root) return undefined;
  return { root, rel: path.relative(root, uri.fsPath).split(path.sep).join('/') };
}

/** Blame for a document, remembered per version so hovering doesn't re-run git on every line. */
const hoverCache = new Map<string, Promise<BlameLine[]>>();

function blameForDocument(doc: vscode.TextDocument, target: BlameTarget): Promise<BlameLine[]> {
  const key = `${doc.uri.toString()}#${target.ref ?? doc.version}`;
  let hit = hoverCache.get(key);
  if (!hit) {
    hit = blameFile(target.root, target.ref, target.rel);
    hoverCache.set(key, hit);
    if (hoverCache.size > 40) hoverCache.delete(hoverCache.keys().next().value!);
  }
  return hit;
}

function blameHover(b: BlameLine, target: BlameTarget): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  if (b.uncommitted) {
    md.appendMarkdown('$(git-commit) Uncommitted change');
    return md;
  }
  // Use the path the file had at that commit: a rename since then would make today's path empty there.
  const args = encodeURIComponent(JSON.stringify([{ root: target.root, sha: b.sha, rel: b.origPath }]));
  const trace = encodeURIComponent(JSON.stringify([{ root: target.root, sha: b.sha, rel: b.origPath, line: b.origLine }]));
  const author = encodeURIComponent(JSON.stringify([{ root: target.root, sha: b.sha, email: b.email, name: b.author }]));
  // A PR number in the subject is the only local evidence that a pull request exists at all.
  const prNumber = /\(#(\d+)\)\s*$/.exec(b.summary)?.[1] ?? /^Merge pull request #(\d+)/.exec(b.summary)?.[1];
  md.appendMarkdown(
    [
      `**${b.summary}**`,
      `$(person) [${b.author}](command:crosscut.openAuthor?${author}) · ${b.when} (${b.date})`,
      `$(git-commit) \`${b.sha.slice(0, 10)}\`${b.origPath !== target.rel ? ` · was \`${b.origPath}\`` : ''} · [This file's change](command:crosscut.showCommit?${args})`,
      [
        `[$(git-commit) Open the whole commit](command:crosscut.openCommitTree?${args})`,
        ...(prNumber
          ? [
              `[$(git-pull-request) Open PR #${prNumber} here](command:crosscut.openPrForCommit?${args})`,
              `[$(globe) PR #${prNumber} on GitHub](command:crosscut.openPrInBrowser?${args})`,
            ]
          : []),
      ].join(' · '),
      ...(prNumber ? [`[$(search) Find the original commit inside PR #${prNumber}](command:crosscut.traceThroughPr?${trace})`] : []),
    ].join('\n\n'),
  );
  return md;
}

/**
 * GitHub profile of a commit's author. A `…@users.noreply.github.com` address already carries the
 * login; otherwise the API knows it, and failing that the email goes to GitHub's user search.
 */
async function openAuthor(arg: { root: string; sha: string; email: string; name: string }) {
  const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(arg.email)?.[1];
  const login =
    noreply ??
    (await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Looking up author…' }, () =>
      commitAuthorLogin(arg.root, arg.sha),
    ));
  const url = login
    ? `https://github.com/${encodeURIComponent(login)}`
    : `https://github.com/search?type=users&q=${encodeURIComponent(arg.email || arg.name)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * A squash-merged commit on the base branch contains a whole PR, so blame points at "the PR" rather
 * than the commit that actually wrote the line. GitHub keeps the PR's own commits at
 * refs/pull/N/head, so blaming the same line there names the real one.
 */
async function traceThroughPr(arg: { root: string; sha: string; rel: string; line: number }) {
  const { root, rel } = arg;
  const main = (await repoMainPath(root)) ?? root;
  const subject = await git(root, ['show', '-s', '--format=%s', arg.sha]).then((o) => o.trim()).catch(() => '');
  const inSubject = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
  const number = inSubject ? Number(inSubject) : (await prForCommit(root, arg.sha))?.number;
  if (!number) {
    vscode.window.showInformationMessage('No pull request found for this commit, so there is nothing to trace into.');
    return;
  }
  const local = `refs/prs/${number}/head`;
  if (!(await hasRef(main, local))) {
    const ok = await vscode.window.showInformationMessage(
      `Fetch the commits of PR #${number}?`,
      { modal: true, detail: `They are not in this clone yet. This runs: git fetch origin refs/pull/${number}/head:${local}` },
      'Fetch',
    );
    if (ok !== 'Fetch') return;
    try {
      const ref = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching PR #${number}…` },
        () => fetchPullRef(main, number),
      );
      fetchedAt.set(`${main}\0${ref}`, Date.now());
    } catch (e) {
      vscode.window.showErrorMessage(`Could not fetch PR #${number}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      return;
    }
  }
  let original;
  try {
    const lines = await blameFile(main, local, rel);
    original = lines[arg.line - 1]; // the line as numbered in the squashed commit's own version
  } catch {
    original = undefined;
  }
  if (!original) {
    vscode.window.showInformationMessage(`That line could not be located in PR #${number} (the file may differ from the squashed version).`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(diff) This file, across that commit', id: 'file' },
      { label: '$(git-commit) The whole commit, in the tree', id: 'tree' },
      { label: '$(globe) PR #' + number + ' on GitHub', id: 'web' },
    ],
    {
      title: `In PR #${number}: ${original.sha.slice(0, 8)} — ${original.summary}`,
      placeHolder: `${original.author} · ${original.when} (${original.date})`,
    },
  );
  if (pick?.id === 'file') await showCommit({ root: main, sha: original.sha, rel: original.origPath });
  else if (pick?.id === 'tree') await vscode.commands.executeCommand('crosscut.openCommitTree', { root: main, sha: original.sha });
  else if (pick?.id === 'web') await vscode.commands.executeCommand('crosscut.openPrInBrowser', { root: main, sha: arg.sha });
}

/** Diff of one file across the commit a blame line points at. */
async function showCommit(arg: { root: string; sha: string; rel: string }) {
  const { root, sha, rel } = arg;
  const name = path.posix.basename(rel);
  // The file may have been renamed or added by this commit; ask git what its parent called it.
  const before = await git(root, ['log', '-1', '--format=', '--name-status', '-M', '--find-copies', sha, '--', rel])
    .then((o) => {
      const m = /^R\d*\t([^\t\n]+)\t/.exec(o) ?? /^C\d*\t([^\t\n]+)\t/.exec(o);
      if (m) return m[1];
      return /^A\t/.test(o) ? undefined : rel;
    })
    .catch(() => rel);
  log.info(`showCommit ${sha.slice(0, 8)} rel=${rel} before=${before ?? '(added)'} root=${root}`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    refUri(path.join(root, before ?? rel), { cwd: root, ref: before ? `${sha}^` : '', rel: before ?? rel }),
    refUri(path.join(root, rel), { cwd: root, ref: sha, rel }),
    `${name} @ ${sha.slice(0, 8)}`,
  );
}

// A one-line preview of each review comment, drawn after the code so nothing shifts. Click the
// gutter icon (or the tree's comment button) to open the full thread.
const commentDecoration = vscode.window.createTextEditorDecorationType({
  after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorInfo.foreground'), fontStyle: 'italic' },
});

function decorateComments(editor: vscode.TextEditor) {
  const owner = ownerOfDocument(editor.document.uri);
  if (!owner?.node.prNumber) {
    editor.setDecorations(commentDecoration, []);
    return;
  }
  const here = owner.node.inlineComments.filter((c) => c.path === owner.rel && c.line && c.side === owner.side);
  const byLine = new Map<number, ReviewComment[]>();
  for (const c of here) byLine.set(c.line!, [...(byLine.get(c.line!) ?? []), c]);
  const decorations: vscode.DecorationOptions[] = [];
  for (const [line, list] of byLine) {
    const i = Math.min(line - 1, editor.document.lineCount - 1);
    if (i < 0) continue;
    const first = list[0];
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
    const span = first.startLine && first.startLine !== first.line ? ` (lines ${first.startLine}–${first.line})` : '';
    const text = `💬 ${first.author}${span}: ${first.body.replace(/\s+/g, ' ').slice(0, 80)}${first.body.length > 80 ? '…' : ''}${more}`;
    const hover = new vscode.MarkdownString(
      list.map((c) => `**${c.author}** · ${new Date(c.when).toLocaleString()}\n\n${c.body}`).join('\n\n---\n\n'),
    );
    hover.isTrusted = true;
    const end = editor.document.lineAt(i).text.length;
    decorations.push({ range: new vscode.Range(i, end, i, end), renderOptions: { after: { contentText: text } }, hoverMessage: hover });
  }
  editor.setDecorations(commentDecoration, decorations);
}

function decorateAllVisible() {
  for (const editor of vscode.window.visibleTextEditors) decorateComments(editor);
  commentBadges.fire(undefined);
}

/**
 * Badges on the snapshot files themselves, so a file's comment count shows wherever VS Code lists
 * it — in particular the multi-file diff view, which our editor decorations never reach. Only our
 * own snapshot paths are answered, so this stays an in-memory lookup.
 */
/**
 * A comment thread keeps whatever state you leave it in, so a thread expanded once stays expanded
 * the next time you open that file — and several expanded threads shove the diff around. Threads
 * are collapsed again once their file is no longer open anywhere.
 */
function urisOfTab(tab: vscode.Tab): string[] {
  const input = tab.input as
    | { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri; textDiffs?: { original?: vscode.Uri; modified?: vscode.Uri }[] }
    | undefined;
  const list = [input?.uri, input?.original, input?.modified];
  for (const d of input?.textDiffs ?? []) list.push(d.original, d.modified); // multi-file diff editor
  return list.filter((u): u is vscode.Uri => !!u).map((u) => u.toString());
}

/**
 * Collapse the threads of files that were just closed. Only closed tabs are considered: reacting to
 * every tab change collapsed the thread being typed in, because a tab kind we do not recognise looks
 * exactly like a closed file.
 */
function collapseThreadsOfClosedTabs(closed: readonly vscode.Tab[]) {
  if (!closed.length) return;
  const stillOpen = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs.flatMap(urisOfTab)));
  const gone = new Set(closed.flatMap(urisOfTab).filter((u) => !stillOpen.has(u)));
  if (!gone.size) return;
  for (const node of storeOwners.values()) {
    for (const thread of node.threads) {
      if (thread.contextValue === 'draft') continue; // a draft you are writing stays as you left it
      if (gone.has(thread.uri.toString())) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }
}

const commentBadges = new vscode.EventEmitter<undefined>();
const commentFileDecorations: vscode.FileDecorationProvider = {
  onDidChangeFileDecorations: commentBadges.event,
  provideFileDecoration(uri) {
    if (uri.scheme !== 'file' || !isInside(uri.fsPath, storageRoot)) return undefined;
    const owner = ownerOfDocument(uri);
    const n = owner && owner.node.commentCounts.get(owner.rel);
    if (!n) return undefined;
    return {
      badge: n < 10 ? String(n) : '9+',
      tooltip: `${n} review comment${n === 1 ? '' : 's'}`,
      color: new vscode.ThemeColor('editorInfo.foreground'),
    };
  },
};

const blameDecoration = vscode.window.createTextEditorDecorationType({
  after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
});
const blamed = new Set<string>(); // document URIs currently annotated

async function toggleBlame() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const key = editor.document.uri.toString();
  if (blamed.has(key)) {
    blamed.delete(key);
    editor.setDecorations(blameDecoration, []);
    return;
  }
  const target = await blameTarget(editor.document.uri);
  if (!target) {
    vscode.window.showInformationMessage('No blame available for this side of the diff.');
    return;
  }
  let lines;
  try {
    lines = await blameForDocument(editor.document, target);
  } catch (e) {
    vscode.window.showErrorMessage(`git blame failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  blamed.add(key);
  const decorations: vscode.DecorationOptions[] = [];
  for (let i = 0; i < editor.document.lineCount; i++) {
    const b = lines[i];
    if (!b) continue;
    const text = b.uncommitted ? 'Uncommitted' : `${b.author}, ${b.when} · ${b.summary}`;
    decorations.push({
      range: new vscode.Range(i, editor.document.lineAt(i).text.length, i, editor.document.lineAt(i).text.length),
      renderOptions: { after: { contentText: text.length > 90 ? text.slice(0, 89) + '…' : text } },
      hoverMessage: blameHover(b, target),
    });
  }
  editor.setDecorations(blameDecoration, decorations);
}

// ---------------------------------------------------------------------------
// Deleting local branches. Never automatic: an "upstream gone" branch may have been squash-merged
// (so git can't prove it is contained in main) or belong to a PR that was closed, not merged.
// Every deletion is confirmed and its tip sha is logged, so `git branch <name> <sha>` restores it.

interface Verdict {
  b: BranchRef;
  merged: boolean; // provably safe: contained in the base branch, or its PR was merged
  why: string;
}

async function classify(main: string, node: WorktreeNode, base: string, prs: Map<string, PrInfo>): Promise<Verdict> {
  const b = node.ref!;
  const pr = prs.get(b.short);
  if (await isAncestor(main, b.sha, base)) return { b, merged: true, why: `$(check) merged into ${base}` };
  // A squash-merged branch is never an ancestor of the base branch, so only the PR can vouch for it.
  if (pr?.state === 'MERGED') return { b, merged: true, why: `$(check) PR #${pr.number} merged (squashed)` };
  if (pr?.state === 'OPEN') return { b, merged: false, why: `$(warning) PR #${pr.number} still open` };
  if (pr?.state === 'CLOSED') return { b, merged: false, why: `$(warning) PR #${pr.number} closed without merging` };
  return { b, merged: false, why: `$(warning) not in ${base}, and no PR found` };
}

function recoveryLine(name: string, sha: string): string {
  return `deleted branch ${name} at ${sha} — restore with: git branch ${name} ${sha}`;
}

async function deleteBranches(main: string, picks: Verdict[]): Promise<string[]> {
  const failed: string[] = [];
  for (const p of picks) {
    try {
      await deleteBranch(main, p.b.short, !p.merged); // -d when provably merged, -D otherwise
      log.info(recoveryLine(p.b.short, p.b.sha));
    } catch (e) {
      failed.push(`${p.b.short}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
  return failed;
}

function doneMessage(count: number, failed: string[]) {
  if (failed.length) vscode.window.showWarningMessage(`Deleted ${count}; failed: ${failed.join('; ')}`);
  else if (count)
    vscode.window
      .showInformationMessage(`Deleted ${count} branch${count === 1 ? '' : 'es'}.`, 'Show recovery commands')
      .then((a) => a && log.show());
}

/**
 * PR commits fetched for a trace or a PR row are kept under refs/prs/*, which pins their objects.
 * Unless asked to keep them, they are dropped at the start of the next session — re-fetching is
 * one call, whereas a forgotten ref keeps a whole PR's objects alive forever.
 */
async function pruneFetchedPrRefs(repos: string[]) {
  const mode = vscode.workspace.getConfiguration('crosscut').get<string>('fetchedPrRefs', 'session');
  if (mode === 'keep') return;
  const cutoff = mode === 'week' ? 7 * 86400_000 : 0;
  for (const repo of repos) {
    for (const r of await listRefs(repo, 'refs/prs')) {
      const at = fetchedAt.get(`${repo}\0${r.ref}`);
      if (cutoff && at && Date.now() - at < cutoff) continue;
      await deleteRef(repo, r.ref).catch(() => undefined);
      fetchedAt.delete(`${repo}\0${r.ref}`);
      log.info(`dropped fetched ref ${r.ref} (${r.sha.slice(0, 10)}) in ${repo}`);
    }
  }
}

const fetchedAt = new Map<string, number>(); // "<repo>\0<ref>" -> when this session fetched it

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Crosscut', { log: true });
  drafts = new Drafts(context.workspaceState);
  comments = vscode.comments.createCommentController('crosscut.prComments', 'PR review comments');
  // Allow commenting anywhere in a file that belongs to a pull request row.
  const rangeCache = new Map<string, vscode.Range[]>();
  comments.commentingRangeProvider = {
    // Only lines the pull request actually changed: GitHub rejects a review comment on any other
    // line, so offering them would produce drafts that can never be staged.
    async provideCommentingRanges(document) {
      const owner = ownerOfDocument(document.uri);
      if (!owner?.node.prNumber || !owner.node.diff) return [];
      const { diff } = owner.node;
      const key = `${document.uri.toString()}#${diff.baseRef}#${diff.headRef ?? ''}`;
      const cached = rangeCache.get(key);
      if (cached) return cached;
      const spans = await changedLineRanges(diff.root, diff.baseRef, diff.headRef, owner.rel);
      const wanted = owner.side === 'LEFT' ? spans.left : spans.right;
      const last = Math.max(0, document.lineCount - 1);
      const ranges = wanted.map(([from, to]) => new vscode.Range(Math.min(from - 1, last), 0, Math.min(to - 1, last), 0));
      rangeCache.set(key, ranges);
      return ranges;
    },
  };
  setGhErrorHandler((m) => {
    lastGhError = m;
    log.warn(m);
  });
  context.subscriptions.push(comments);
  context.subscriptions.push(log);
  // Extension-host stalls (from this or any other extension) delay every tree response.
  let last = performance.now();
  const lag = setInterval(() => {
    const now = performance.now();
    if (now - last > 350) log.info(`extension host event loop blocked ~${(now - last - 250).toFixed(0)}ms`);
    last = now;
  }, 250);
  context.subscriptions.push({ dispose: () => clearInterval(lag) });
  // Submitting publishes a review the moment it is clicked, so it is opt-in.
  const syncSubmitOption = () =>
    void vscode.commands.executeCommand(
      'setContext',
      'crosscut.canSubmit',
      vscode.workspace.getConfiguration('crosscut').get<boolean>('allowSubmitReview', false),
    );
  syncSubmitOption();
  storageRoot = path.join(context.globalStorageUri.fsPath, 'repos');
  const provider = new WorktreeDiffsProvider(context.workspaceState);
  void installCli(context, false).catch((e) => log.warn(`crosscut cli: ${e}`));
  const view = vscode.window.createTreeView('crosscut', { treeDataProvider: provider, showCollapseAll: true });

  context.subscriptions.push(
    provider,
    view,
    serveCli(provider, view),
    view.onDidExpandElement((e) => {
      log.info(`expand ${nodeName(e.element)}`);
      return provider.onExpand(e.element, view);
    }),
    view.onDidCollapseElement((e) => provider.onCollapse(e.element)),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RefContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(DESC_SCHEME, {
      onDidChange: descChanged.event,
      provideTextDocumentContent: (uri) => descriptions.get(uri.toString()) ?? '',
    }),
    descChanged,
    vscode.commands.registerCommand('crosscut.showDescription', showDescription),
    vscode.commands.registerCommand('crosscut.refresh', async () => {
      await provider.refresh();
      provider.refreshExpanded();
    }),
    vscode.commands.registerCommand('crosscut.toggleMode', (n: WorktreeNode) => provider.toggleMode(n)),
    vscode.commands.registerCommand('crosscut.pickBase', (n: WorktreeNode) => provider.pickBase(n)),
    vscode.commands.registerCommand('crosscut.openWorktree', (n: WorktreeNode) =>
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(n.wt.path), { forceNewWindow: true }),
    ),
    vscode.commands.registerCommand('crosscut.openDiff', openDiff),
    vscode.commands.registerCommand('crosscut.openAll', (node: WorktreeNode | FolderNode | SubmoduleNode) => provider.openAll(node, view)),
    vscode.commands.registerCommand('crosscut.goToFileInAll', goToFileInAll),
    vscode.commands.registerCommand('crosscut.openInAll', openInAll),
    vscode.commands.registerCommand('crosscut.installCli', () =>
      installCli(context, true).catch((e) => vscode.window.showErrorMessage(`Could not install crosscut: ${e}`)),
    ),
    vscode.window.tabGroups.onDidChangeTabs(updateAllChangesContext),
    vscode.window.tabGroups.onDidChangeTabGroups(updateAllChangesContext),
    vscode.commands.registerCommand('crosscut.openFile', async (n: FileNode) =>
      vscode.window.showTextDocument((await diffSides(n)).right),
    ),
    vscode.commands.registerCommand('crosscut.fetch', async (g: BranchGroupNode) => {
      await vscode.window.withProgress(
        { location: { viewId: 'crosscut' }, title: 'Fetching…' },
        () => git(g.mainPath, ['fetch', '--all', '--prune']).catch((e) => vscode.window.showErrorMessage(String(e))),
      );
      await provider.refresh();
    }),
    vscode.commands.registerCommand('crosscut.compareWithCurrent', compareWithCurrent),
    vscode.commands.registerCommand('crosscut.toggleBlame', toggleBlame),
    vscode.commands.registerCommand('crosscut.showCommit', showCommit),
    vscode.commands.registerCommand('crosscut.traceThroughPr', traceThroughPr),
    vscode.commands.registerCommand('crosscut.openAuthor', openAuthor),
    vscode.commands.registerCommand('crosscut.showFileComments', async (n: FileNode) => {
      const list = n.owner.inlineComments.filter((c) => c.path === n.change.path);
      if (!list.length) return;
      const items = list.map((c) => ({
        label: `${c.line ? (c.startLine && c.startLine !== c.line ? `Lines ${c.startLine}–${c.line}` : `Line ${c.line}`) : 'Outdated'} · ${c.author}`,
        detail: c.body.replace(/\s+/g, ' ').slice(0, 300),
        comment: c,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: `${list.length} review comment${list.length === 1 ? '' : 's'} on ${path.posix.basename(n.change.path)}`,
        matchOnDetail: true,
      });
      if (!picked) return;
      await openDiff(n);
      const line = picked.comment.line;
      const editor = vscode.window.activeTextEditor;
      if (line && editor) {
        const at = new vscode.Range(line - 1, 0, line - 1, 0);
        editor.revealRange(at, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(at.start, at.start);
      } else if (!line) {
        await vscode.env.openExternal(vscode.Uri.parse(picked.comment.url)); // outdated: only GitHub has its context
      }
    }),
    vscode.commands.registerCommand('crosscut.addDraft', async (reply: vscode.CommentReply) => {
      const owner = ownerOfDocument(reply.thread.uri);
      if (!owner?.node.prNumber || !reply.text.trim()) return;
      // A selection spanning several lines becomes a span comment, as on GitHub.
      const range = reply.thread.range;
      const startLine = (range?.start.line ?? 0) + 1;
      const line = (range?.end.line ?? range?.start.line ?? 0) + 1;
      await drafts.add(owner.node, {
        path: owner.rel,
        line,
        ...(line > startLine ? { startLine } : {}),
        side: owner.side,
        body: reply.text,
      });
      reply.thread.dispose();
      await provider.reloadComments(owner.node);
      vscode.window.showInformationMessage(
        `Draft saved for PR #${owner.node.prNumber}. Use "Stage review" on the PR row to send it to GitHub as a pending review.`,
      );
    }),
    vscode.commands.registerCommand('crosscut.deleteDraft', async (comment: vscode.Comment & { draftId?: string }) => {
      for (const node of storeOwners.values()) {
        if (!comment.draftId || !drafts.get(node).some((d) => d.id === comment.draftId)) continue;
        await drafts.remove(node, comment.draftId);
        await provider.reloadComments(node);
        return;
      }
    }),
    vscode.commands.registerCommand('crosscut.stageReview', async (n: WorktreeNode) => {
      const list = drafts.get(n);
      if (!n.prNumber || !list.length) {
        vscode.window.showInformationMessage('No draft comments to stage on this pull request.');
        return;
      }
      // GitHub allows one pending review per person per PR; a second POST is rejected outright.
      const existing = await pendingReviewId(n.wt.path, n.prNumber);
      if (existing) {
        const go = await vscode.window.showWarningMessage(
          `You already have a pending review on PR #${n.prNumber}.`,
          { modal: true, detail: 'GitHub allows only one at a time. Submit or discard that one on GitHub, then stage these drafts.' },
          'Open PR',
        );
        if (go) await vscode.commands.executeCommand('crosscut.openOnGitHub', n);
        return;
      }
      const body = await vscode.window.showInputBox({
        title: `Stage ${list.length} comment${list.length === 1 ? '' : 's'} on PR #${n.prNumber}`,
        prompt: 'Optional summary for the review (it stays pending until you submit it on GitHub)',
      });
      if (body === undefined) return;
      log.info(`staging ${list.length} comment(s) on PR #${n.prNumber}: ${list.map((d) => `${d.path}:${d.startLine ?? d.line}${d.startLine ? `-${d.line}` : ''}`).join(', ')}`);
      const result = await vscode.window.withProgress(
        { location: { viewId: 'crosscut' }, title: 'Staging pending review…' },
        () => stagePendingReview(n.wt.path, n.prNumber!, body, list.map(({ path, line, startLine, side, body }) => ({ path, line, startLine, side, body }))),
      );
      if (!result.ok) {
        log.error(`staging failed: ${result.message}`);
        vscode.window
          .showErrorMessage(`Could not stage the review: ${result.message}`, 'Show log')
          .then((a) => a && log.show());
        return;
      }
      log.info(`staged: ${result.message}`);
      await drafts.set(n, []);
      await provider.reloadComments(n);
      const open = await vscode.window.showInformationMessage(
        `Staged ${list.length} comment${list.length === 1 ? '' : 's'} as a pending review on PR #${n.prNumber}. Nobody sees it until you submit it on GitHub.`,
        'Open PR',
      );
      if (open) await vscode.commands.executeCommand('crosscut.openOnGitHub', n);
    }),
    vscode.commands.registerCommand('crosscut.discardPendingReview', async (n: WorktreeNode) => {
      if (!n.prNumber) return;
      const id = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Checking for a pending review…' }, () =>
        pendingReviewId(n.wt.path, n.prNumber!),
      );
      if (!id) {
        vscode.window.showInformationMessage(`No pending review of yours on PR #${n.prNumber}.`);
        return;
      }
      const count = await pendingReviewComments(n.wt.path, n.prNumber, id);
      const ok = await vscode.window.showWarningMessage(
        `Discard your pending review on PR #${n.prNumber}?`,
        {
          modal: true,
          detail: `${count} unsubmitted comment${count === 1 ? '' : 's'} will be deleted on GitHub. Nobody else has seen them, and they cannot be recovered.`,
        },
        'Discard',
      );
      if (ok !== 'Discard') return;
      const result = await deletePendingReview(n.wt.path, n.prNumber, id);
      if (!result.ok) {
        log.error(`discarding pending review failed: ${result.message}`);
        vscode.window.showErrorMessage(`Could not discard the review: ${result.message}`);
        return;
      }
      log.info(`discarded pending review ${id} on PR #${n.prNumber} (${count} comments)`);
      await provider.reloadComments(n);
      vscode.window.showInformationMessage(`Discarded your pending review on PR #${n.prNumber}.`);
    }),
    vscode.commands.registerCommand('crosscut.submitReview', async (n: WorktreeNode) => {
      const list = drafts.get(n);
      if (!n.prNumber) return;
      if (!vscode.workspace.getConfiguration('crosscut').get<boolean>('allowSubmitReview', false)) return;
      // Same constraint as staging: one pending review per person per PR, and a submit POST is
      // rejected just as flatly while one is open.
      const pending = await pendingReviewId(n.wt.path, n.prNumber);
      if (pending) {
        const go = await vscode.window.showWarningMessage(
          `You already have a pending review on PR #${n.prNumber}.`,
          { modal: true, detail: 'GitHub rejects a new review while one is pending. Submit or discard that one on GitHub first.' },
          'Open PR',
        );
        if (go) await vscode.commands.executeCommand('crosscut.openOnGitHub', n);
        return;
      }
      const verdict = await vscode.window.showQuickPick(
        [
          { label: '$(comment) Comment', detail: 'Post the comments without approving or requesting changes', event: 'COMMENT' as const },
          { label: '$(check) Approve', detail: 'Approve the pull request', event: 'APPROVE' as const },
          { label: '$(request-changes) Request changes', detail: 'Ask for changes before this can merge', event: 'REQUEST_CHANGES' as const },
        ],
        { title: `Submit a review on PR #${n.prNumber}${list.length ? ` with ${list.length} comment${list.length === 1 ? '' : 's'}` : ''}` },
      );
      if (!verdict) return;
      const body = await vscode.window.showInputBox({
        title: `Summary for your ${verdict.event.toLowerCase().replace('_', ' ')} review on PR #${n.prNumber}`,
        prompt: 'Shown at the top of the review. Submitted together with the comments.',
        ignoreFocusOut: true,
      });
      if (body === undefined) return;
      if (!body.trim() && !list.length) {
        vscode.window.showInformationMessage('Nothing to submit: no summary and no comments.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Submit this review on PR #${n.prNumber}?`,
        {
          modal: true,
          detail:
            `It posts immediately as ${verdict.event.toLowerCase().replace('_', ' ')} and everyone watching the pull request can see it` +
            `${list.length ? `, along with your ${list.length} comment${list.length === 1 ? '' : 's'}` : ''}. This cannot be undone from here.`,
        },
        'Submit',
      );
      if (ok !== 'Submit') return;
      log.info(`submitting ${verdict.event} review on PR #${n.prNumber} with ${list.length} comment(s)`);
      const result = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Submitting review…' }, () =>
        stagePendingReview(n.wt.path, n.prNumber!, body, list.map(({ path, line, startLine, side, body }) => ({ path, line, startLine, side, body })), verdict.event),
      );
      if (!result.ok) {
        log.error(`submit failed: ${result.message}`);
        vscode.window.showErrorMessage(`Could not submit the review: ${result.message}`, 'Show log').then((a) => a && log.show());
        return;
      }
      log.info(`submitted: ${result.message}`);
      await drafts.set(n, []);
      await provider.reloadComments(n);
      const open = await vscode.window.showInformationMessage(`Submitted your review on PR #${n.prNumber}.`, 'Open PR');
      if (open) await vscode.commands.executeCommand('crosscut.openOnGitHub', n);
    }),
    vscode.commands.registerCommand('crosscut.discardDrafts', async (n: WorktreeNode) => {
      const list = drafts.get(n);
      if (!list.length) return;
      const ok = await vscode.window.showWarningMessage(`Discard ${list.length} draft comment(s)?`, { modal: true }, 'Discard');
      if (ok !== 'Discard') return;
      await drafts.set(n, []);
      await provider.reloadComments(n);
    }),
    vscode.commands.registerCommand('crosscut.showReviews', async (n: WorktreeNode) => {
      if (!n.prNumber) {
        vscode.window.showInformationMessage('No pull request is associated with this row.');
        return;
      }
      type Item = vscode.QuickPickItem & { url?: string };
      const items: Item[] = [
        ...n.reviews.map((r): Item => ({
          label: `$(${r.state === 'APPROVED' ? 'check' : r.state === 'CHANGES_REQUESTED' ? 'request-changes' : 'comment'}) ${r.author}`,
          description: r.state.toLowerCase().replace('_', ' '),
          detail: r.body.replace(/\s+/g, ' ').slice(0, 300),
          url: r.url,
        })),
        ...n.outdated.map((c): Item => ({
          label: `$(history) ${c.author}`,
          description: `outdated · ${c.path}`,
          detail: c.body.replace(/\s+/g, ' ').slice(0, 300),
          url: c.url,
        })),
      ];
      if (!items.length) {
        vscode.window.showInformationMessage(`PR #${n.prNumber} has no review summaries or outdated comments.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: `PR #${n.prNumber}: ${n.reviews.length} review${n.reviews.length === 1 ? '' : 's'}, ${n.outdated.length} outdated comment${
          n.outdated.length === 1 ? '' : 's'
        }`,
        placeHolder: 'Inline comments are shown in the diffs themselves',
        matchOnDetail: true,
      });
      if (picked?.url) await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }),
    vscode.commands.registerCommand('crosscut.openCommitTree', async (arg: { root: string; sha: string }) => {
      const main = (await repoMainPath(arg.root)) ?? arg.root;
      const [subject, when, author] = (
        await git(arg.root, ['show', '-s', '--format=%s%x1f%cr%x1f%an', arg.sha])
      ).trim().split('\x1f');
      await provider.openAdHoc(
        main,
        { id: arg.sha.slice(0, 10), label: `${arg.sha.slice(0, 8)} ${subject}`, sha: arg.sha, base: `${arg.sha}^`, when, author },
        view,
      );
    }),
    vscode.commands.registerCommand('crosscut.openPrForCommit', async (arg: { root: string; sha: string }) => {
      const main = (await repoMainPath(arg.root)) ?? arg.root;
      const pr = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Finding pull request…' }, () =>
        prForCommit(arg.root, arg.sha),
      );
      if (!pr) {
        vscode.window.showInformationMessage(lastGhError ?? 'No pull request found for this commit.');
        return;
      }
      // The PR head may not be in this clone (e.g. a fork, or a branch deleted after merging).
      if (!(await hasRef(main, pr.headSha))) {
        const ok = await vscode.window.showInformationMessage(
          `Fetch the commits of PR #${pr.number}?`,
          { modal: true, detail: `Its head ${pr.headSha.slice(0, 10)} is not in this clone yet.` },
          'Fetch',
        );
        if (ok !== 'Fetch') return;
        try {
          const ref = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching PR #${pr.number}…` },
            () => fetchPullRef(main, pr.number),
          );
          fetchedAt.set(`${main}\0${ref}`, Date.now());
        } catch (e) {
          vscode.window.showErrorMessage(`Could not fetch PR #${pr.number}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
          return;
        }
      }
      const base = (await mergeBase(main, pr.baseRef, pr.headSha)) ?? `${pr.headSha}^`;
      const when = (await git(main, ['show', '-s', '--format=%cr', pr.headSha]).catch(() => '')).trim();
      await provider.openAdHoc(
        main,
        { id: `pr-${pr.number}`, label: `PR #${pr.number} ${pr.title}`, sha: pr.headSha, base, when, author: `into ${pr.baseRef}` },
        view,
        pr.url,
      );
    }),
    vscode.commands.registerCommand('crosscut.openPrInBrowser', async (arg: { root: string; sha: string }) => {
      const pr = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Finding pull request…' }, () =>
        prForCommit(arg.root, arg.sha),
      );
      if (!pr) {
        vscode.window.showInformationMessage('No pull request found for this commit.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    }),
    vscode.commands.registerCommand('crosscut.cleanPrRefs', async () => {
      const repos = provider.repoPaths();
      const found: { repo: string; ref: string; when: string }[] = [];
      for (const repo of repos) for (const r of await listRefs(repo, 'refs/prs')) found.push({ repo, ...r });
      if (!found.length) {
        vscode.window.showInformationMessage('No fetched pull-request refs to clean up.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete ${found.length} fetched PR ref${found.length === 1 ? '' : 's'}?`,
        { modal: true, detail: found.map((f) => `${f.ref} (${f.when})`).join('\n') + '\n\nThey can be fetched again at any time.' },
        'Delete',
      );
      if (ok !== 'Delete') return;
      for (const f of found) await deleteRef(f.repo, f.ref).catch(() => undefined);
      vscode.window.showInformationMessage(`Deleted ${found.length} fetched PR ref${found.length === 1 ? '' : 's'}.`);
    }),
    vscode.commands.registerCommand('crosscut.openAsPr', async (n: WorktreeNode) => {
      const main = (await repoMainPath(n.wt.path)) ?? n.wt.path;
      const number = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Finding pull request…' }, () =>
        provider.prOf(n),
      );
      if (!number) {
        vscode.window.showInformationMessage(lastGhError ?? 'No pull request found for this branch.');
        return;
      }
      const d = await prDetails(main, number);
      if (!d) return;
      // The PR's head as GitHub has it, which is not necessarily what this worktree holds.
      let head = await git(main, ['rev-parse', '--verify', `refs/remotes/origin/${d.headRef}`]).then((o) => o.trim()).catch(() => '');
      if (!head) {
        const ok = await vscode.window.showInformationMessage(
          `Fetch the commits of PR #${number}?`,
          { modal: true, detail: `origin/${d.headRef} is not in this clone.` },
          'Fetch',
        );
        if (ok !== 'Fetch') return;
        const ref = await fetchPullRef(main, number).catch(() => undefined);
        if (!ref) return;
        fetchedAt.set(`${main}\0${ref}`, Date.now());
        head = await git(main, ['rev-parse', '--verify', ref]).then((o) => o.trim()).catch(() => '');
      }
      if (!head) return;
      const base = (await mergeBase(main, d.baseRef, head)) ?? `${head}^`;
      const when = (await git(main, ['show', '-s', '--format=%cr', head]).catch(() => '')).trim();
      await provider.openAdHoc(
        main,
        { id: `pr-${number}`, label: `PR #${number} ${d.title}`, sha: head, base, when, author: `into ${d.baseRef}` },
        view,
        d.url,
      );
    }),
    vscode.commands.registerCommand('crosscut.closeAdHoc', (n: WorktreeNode) => provider.closeAdHoc(n)),
    vscode.commands.registerCommand('crosscut.openOnGitHub', async (n: WorktreeNode) => {
      const main = n.wt.path;
      let url = n.webUrl;
      const branch = n.ref && !n.ref.ref.startsWith('adhoc/') ? branchNameOf(n.ref) : n.wt.branch;
      if (!url && branch) {
        const prs = await vscode.window.withProgress({ location: { viewId: 'crosscut' }, title: 'Looking up pull request…' }, () =>
          prsByBranch(main),
        );
        url =
          prs.get(branch)?.url ??
          (await repoUrl(main).then((u) => (u ? `${u}/tree/${branch.split('/').map(encodeURIComponent).join('/')}` : undefined)));
        n.webUrl = url;
      }
      if (!url) {
        vscode.window.showInformationMessage('No GitHub page found (is this repo on GitHub, and is gh installed?).');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    // Hover blame: works in any editor, including snapshot files that live outside a repo.
    vscode.languages.registerHoverProvider(
      [{ scheme: 'file' }],
      {
        async provideHover(doc, pos) {
          if (!vscode.workspace.getConfiguration('crosscut').get<boolean>('blameHover', true)) return undefined;
          const target = await blameTarget(doc.uri);
          if (!target) return undefined;
          const lines = await blameForDocument(doc, target).catch(() => undefined);
          const b = lines?.[pos.line];
          return b ? new vscode.Hover(blameHover(b, target), doc.lineAt(pos.line).range) : undefined;
        },
      },
    ),
    vscode.commands.registerCommand('crosscut.deleteBranch', async (n: WorktreeNode) => {
      const main = n.wt.path;
      const base = (await detectBaseBranch(main, '')) ?? 'main';
      const verdict = await classify(main, n, base, await prsByBranch(main));
      const ok = await vscode.window.showWarningMessage(
        `Delete local branch ${verdict.b.short}?`,
        {
          modal: true,
          detail: `${verdict.why.replace(/\$\([a-z]+\) /, '')}. Its tip ${verdict.b.sha.slice(0, 10)} is logged, so it can be restored with git branch <name> <sha>.`,
        },
        'Delete',
      );
      if (ok !== 'Delete') return;
      doneMessage(1, await deleteBranches(main, [verdict]));
      await provider.refresh();
    }),
    vscode.commands.registerCommand('crosscut.cleanupMerged', async (g: BranchGroupNode) => {
      const main = g.mainPath;
      const base = (await detectBaseBranch(main, '')) ?? 'main';
      const gone = g.branches.filter((n) => n.ref?.track === 'gone');
      if (!gone.length) {
        vscode.window.showInformationMessage('No local branches whose upstream is gone.');
        return;
      }
      const prs = await vscode.window.withProgress(
        { location: { viewId: 'crosscut' }, title: 'Checking pull requests…' },
        () => prsByBranch(main),
      );
      const classified = await Promise.all(gone.map((n) => classify(main, n, base, prs)));
      type Pick = vscode.QuickPickItem & { entry: Verdict };
      const items: Pick[] = classified
        .sort((a, x) => Number(x.merged) - Number(a.merged))
        .map((c) => ({
          label: c.b.short,
          description: `${c.b.when} · ${c.b.sha.slice(0, 10)}`,
          detail: c.why,
          picked: c.merged,
          entry: c,
        }));
      const picked = await vscode.window.showQuickPick(items, {
        title: `Delete local branches whose upstream is gone (${gone.length})`,
        placeHolder: 'Merged ones are pre-selected; every deletion is logged with a restore command',
        canPickMany: true,
      });
      if (!picked?.length) return;
      const risky = picked.filter((p) => !p.entry.merged).length;
      const unproven = picked.filter((p) => !p.entry.merged).map((p) => p.entry.b.short);
      const ok = await vscode.window.showWarningMessage(
        `Delete ${picked.length} local branch${picked.length === 1 ? '' : 'es'}?`,
        {
          modal: true,
          detail: risky
            ? `${risky} are not provably merged and will be force-deleted: ${unproven.join(', ')}. All tips are logged, so each can be restored with git branch <name> <sha>.`
            : `All are merged into ${base}. Tips are logged, so each can be restored.`,
        },
        'Delete',
      );
      if (ok !== 'Delete') return;
      const failed = await deleteBranches(main, picked.map((p) => p.entry));
      doneMessage(picked.length - failed.length, failed);
      await provider.refresh();
    }),
    blameDecoration,
    commentDecoration,
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorateComments)),
    vscode.window.registerFileDecorationProvider(commentFileDecorations),
    vscode.window.tabGroups.onDidChangeTabs((e) => collapseThreadsOfClosedTabs(e.closed)),
    commentBadges,
    vscode.window.onDidChangeActiveTextEditor(async (e) => {
      // Only offer the button where blame can actually be produced.
      const can = !!(e && (await blameTarget(e.document.uri)));
      void vscode.commands.executeCommand('setContext', 'crosscut.canBlame', can);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => blamed.delete(d.uri.toString())),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('crosscut')) return;
      syncSubmitOption();
      void provider.refresh();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) provider.scheduleRefresh();
    }),
  );

  void provider.refresh().then(() => pruneFetchedPrRefs(provider.repoPaths()));
}

export function deactivate() {}
