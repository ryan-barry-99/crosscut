import * as path from 'path';
import * as vscode from 'vscode';
import { DraftComment, PrDetails, ReviewComment, ReviewSummary } from './gh';
import { Change, Worktree, RepoDiff, BranchRef, RebaseConflict } from './git';
import { log } from './log';
import { snapshotDir } from './snapshots';
import { isInside } from './provider';

export function nodeName(n?: Node): string {
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
export type Mode = 'branch' | 'uncommitted' | `commit:${string}` | `base:${string}` | `rebase:${string}`;

// ---------------------------------------------------------------------------
// Tree model

export class RepoNode {
  constructor(
    readonly commonDir: string,
    readonly worktrees: WorktreeNode[],
    readonly groups: BranchGroupNode[],
    readonly main: Worktree, // runs git for branch and commit rows; a shadow repo has no worktree rows
    readonly ctx: { current?: Worktree },
    readonly shadowOf?: string, // the folder, when this is the shadow history of a folder with no repo
  ) {}
  get children(): Node[] {
    const opened = this.groups.filter((g) => g.kind === 'opened' && g.branches.length);
    const prs = this.groups.filter((g) => g.kind === 'prs' && g.branches.length);
    const rest = this.groups.filter((g) => g.kind !== 'opened' && g.kind !== 'prs' && g.branches.length);
    return [...opened, ...prs, ...this.worktrees, ...rest];
  }
}

/** "Local branches (no worktree)" / "Remote branches": diffed from git objects, nothing checked out. */
export class BranchGroupNode {
  branches: WorktreeNode[] = [];
  parent?: RepoNode;
  constructor(readonly kind: 'local' | 'remote' | 'opened' | 'prs', readonly commonDir: string, readonly mainPath: string) {}
}

export class WorktreeNode {
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
  fixedBaseLabel?: string; // what the row says it is compared against, when a count of commits would mislead
  ref?: BranchRef; // set for a branch with no worktree: `wt` is then the main checkout, used only to run git
  presentOf?: WorktreeNode; // a presented row: diffs this row's worktree or branch under its own comparison
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

export type Child = FolderNode | SubmoduleNode | FileNode;

export class FolderNode {
  children: Child[] = [];
  constructor(readonly owner: WorktreeNode, readonly diff: RepoDiff, readonly rel: string, readonly label: string, readonly parent: Node) {}
}

export class SubmoduleNode {
  readonly children: Child[];
  constructor(readonly owner: WorktreeNode, readonly change: Change & { sub: RepoDiff }, readonly parent: Node) {
    this.children = buildFileTree(owner, change.sub, this);
  }
}

export class FileNode {
  constructor(readonly owner: WorktreeNode, readonly diff: RepoDiff, readonly change: Change, readonly parent: Node) {}
  get absPath(): string {
    return path.join(this.diff.root, this.change.path);
  }
}

export type Node = RepoNode | BranchGroupNode | WorktreeNode | Child;

export interface RawDir {
  dirs: Map<string, RawDir>;
  files: Change[];
}

/** Group changes into folders (folders first), compacting single-child chains (`a/b/c`) like the SCM view. */
export function buildFileTree(owner: WorktreeNode, diff: RepoDiff, parent: Node): Child[] {
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
export let comments: vscode.CommentController; // created in activate(), before any tree load
// Which PR row a snapshot file belongs to, so comments can be attached to the right pull request.
export const storeOwners = new Map<string, WorktreeNode>(); // store dir -> node

export interface Draft extends DraftComment {
  id: string;
}

/** Drafts live locally until staged, so nothing reaches GitHub until you ask for it. */
export class Drafts {
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
export let drafts: Drafts;

/** The PR row, file and side a snapshot document belongs to. */
export function ownerOfDocument(uri: vscode.Uri): { node: WorktreeNode; rel: string; side: 'LEFT' | 'RIGHT' } | undefined {
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

export function threadsFor(node: WorktreeNode, all: ReviewComment[]) {
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
          author: { name: c.pending ? `${c.author} (pending)` : c.author },
          label: c.pending ? 'in your pending review, not submitted' : new Date(c.when).toLocaleString(),
          contextValue: String(c.id),
        })),
    );
    thread.canReply = false;
    // Collapsed: an expanded thread is an inline widget, and several of them shove the diff around
    // as they load. The end-of-line decoration below makes them visible without moving any text.
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.label = group.every((c) => c.pending) ? `Pending review comment on ${first.path}` : `Review comment on ${first.path}`;
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

export const STATUS_LABEL: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked',
};
export const STATUS_COLOR: Record<string, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  '?': 'gitDecoration.untrackedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  U: 'gitDecoration.conflictingResourceForeground',
};


/** Called once from activate(), before any tree load. */
export function initComments(state: vscode.Memento, controller: vscode.CommentController) {
  drafts = new Drafts(state);
  comments = controller;
}
