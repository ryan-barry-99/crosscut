import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PresentRequest, PresentResponse, PresentSpec } from './ipc';
import { PrInfo, prComments, prDetails, prReviews, pendingComments, prsByBranch } from './gh';
import { Worktree, RepoDiff, allIgnored, countFiles, loadDiff, loadRefDiff, listBranches, stackCandidates, hasRef, BranchRef, detectBaseBranch, listWorktrees, mergeBase, commitsSince, countCommits, repoCommonDir, git, previewRebase, RebasePreview } from './git';
import { log } from './log';
import { hash, worktreeStore, SavedDiff, pruneRemoved, snapshotDir, snapshot } from './snapshots';
import { nodeName, Mode, RepoNode, BranchGroupNode, WorktreeNode, FolderNode, SubmoduleNode, FileNode, Node, buildFileTree, storeOwners, drafts, threadsFor, STATUS_LABEL, STATUS_COLOR } from './model';
import { diffSides, openDiff, keepUserEditor, collectFiles, openAll, presentedLines, highlightPresented } from './diffs';
import { shortError, describe, shortName, branchNameOf } from './helpers';
import { decorateAllVisible } from './annotations';

export class WorktreeDiffsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private repos: RepoNode[] = [];
  private nodes = new Map<string, WorktreeNode>(); // by worktree path, kept stable across refreshes
  private branchNodes = new Map<string, WorktreeNode>(); // by `${commonDir}\0${refname}`
  private prCache = new Map<string, { at: number; value: Promise<Map<string, PrInfo>> }>();
  private opened = new Map<string, BranchGroupNode>(); // commonDir -> ad-hoc commits/PRs opened from a blame hover
  private prGroups = new Map<string, BranchGroupNode>(); // commonDir -> the open-pull-request rows
  private expanded = new Set<WorktreeNode>(); // rows open in the tree: diffed first, and worktrees watched
  private repoWatchers: vscode.Disposable[] = [];
  private repoWatchKey = '';
  private expandedWatchers = new Map<string, vscode.Disposable>(); // worktree path -> its file watcher
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
    return (node.presentOf ?? node).ref && mode === 'uncommitted' ? 'branch' : mode; // a branch has no working tree
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
    const files = [...this.pendingPaths];
    this.pendingPaths.clear();
    for (const node of this.expanded) {
      if ((node.presentOf ?? node).ref) continue;
      const mine = files.filter((f) => f.startsWith(node.wt.path + path.sep));
      if (!mine.length) continue;
      // Build output and other ignored files can't change the diff.
      if (await allIgnored(node.wt.path, mine.map((f) => path.relative(node.wt.path, f)))) continue;
      await this.reload(node);
    }
  }

  /** Manual refresh: always re-diff every open row. */
  async refreshExpanded() {
    await Promise.all([...this.expanded].map((n) => this.reload(n, true)));
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
    // Open rows are the ones anybody is waiting on, so they never queue behind background refreshes
    // — they start even when every background slot is busy.
    for (let i = this.queue.findIndex((n) => this.expanded.has(n)); i >= 0; i = this.queue.findIndex((n) => this.expanded.has(n))) {
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
    present?: { of: WorktreeNode; mode: Mode },
  ) {
    const repo = this.repos.find((r) => r.worktrees.some((w) => w.wt.path === main)) ?? this.repos[0];
    if (!repo) return;
    let group = this.opened.get(repo.commonDir);
    if (!group) {
      group = new BranchGroupNode('opened', repo.commonDir, main);
      this.opened.set(repo.commonDir, group);
      (repo as { groups: BranchGroupNode[] }).groups.unshift(group);
      group.parent = this.repoRows ? repo : undefined;
    }
    const refname = `adhoc/${entry.id}`;
    let node = group.branches.find((n) => n.ref!.ref === refname);
    if (!node) {
      const wt = present?.of.wt ?? repo.worktrees[0].wt;
      node = new WorktreeNode(wt, false, repo.worktrees[0].repo, worktreeStore(repo.commonDir, `ref:${refname}`));
      node.ref = { ref: refname, short: entry.label, sha: entry.sha, when: entry.when, author: entry.author, remote: false };
      node.presentOf = present?.of;
      node.parent = group;
      group.branches.unshift(node);
      this.branchNodes.set(`${repo.commonDir}\0${refname}`, node);
      await this.state.update(`mode:${node.key}`, present?.mode ?? (`commit:${entry.base}` as Mode));
    } else if (present) {
      node.stale = true; // presented again: the worktree or branch may have moved since
    }
    node.webUrl = webUrl ?? node.webUrl;
    node.prNumber = /^pr-(\d+)$/.exec(entry.id) ? Number(/^pr-(\d+)$/.exec(entry.id)![1]) : node.prNumber;
    this.emitter.fire(undefined);
    this.expanded.add(node);
    // Not awaited: whoever opened the row (blame, the CLI) is waiting on its diff, not the tree.
    void view.reveal(node, { expand: true, select: true, focus: true }).then(undefined, () => undefined);
  }

  closeAdHoc(node: WorktreeNode) {
    for (const [common, group] of this.opened) {
      const i = group.branches.indexOf(node);
      if (i < 0) continue;
      group.branches.splice(i, 1);
      this.branchNodes.delete(`${common}\0${node.ref!.ref}`);
      this.expanded.delete(node);
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
      group.parent = this.repoRows ? repo : undefined;
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
  private async loadComments(node: WorktreeNode, fresh = false) {
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
    const [published, pending, reviews] = await Promise.all([
      prComments(main, node.prNumber),
      pendingComments(main, node.prNumber, fresh),
      prReviews(main, node.prNumber),
    ]);
    const seen = new Set(published.map((c) => c.id));
    const inline = [...published, ...pending.filter((c) => !seen.has(c.id))];
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

  /** Repos outside the workspace that were added to the tree, by a present for one: their paths. */
  private addedRepos(): string[] {
    return this.state.get<string[]>('addedRepos', []);
  }

  /** Whether a repo is in the tree only because it was added, not because the workspace holds it. */
  isAdded(commonDir: string): boolean {
    return this.added.has(commonDir);
  }
  private added = new Set<string>(); // commonDirs of the added repos currently shown

  /** Each repo gets a row of its own when there are several, or when one was added from outside. */
  private get repoRows(): boolean {
    return this.repos.length > 1 || this.added.size > 0;
  }

  /** Show a repo the workspace does not hold, remembered for this workspace. False if `dir` is not in one. */
  async addRepo(dir: string): Promise<boolean> {
    const common = await repoCommonDir(dir);
    if (!common) return false;
    if (!this.repos.some((r) => r.commonDir === common)) {
      await this.state.update('addedRepos', [...this.addedRepos(), dir]);
      await this.refresh();
    }
    return this.repos.some((r) => r.commonDir === common);
  }

  async removeRepo(commonDir: string) {
    const keep = [];
    for (const dir of this.addedRepos()) if ((await repoCommonDir(dir)) !== commonDir) keep.push(dir);
    await this.state.update('addedRepos', keep);
    await this.refresh();
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
    // Added repos follow the workspace's own, and one the workspace has since opened is its own again.
    // A path that no longer resolves to a repo is dropped.
    this.added = new Set();
    for (const dir of this.addedRepos()) {
      const common = await repoCommonDir(dir);
      if (!common || byCommon.has(common)) continue;
      byCommon.set(common, dir);
      this.added.add(common);
    }

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
      const rows = repos.length > 1 || this.added.size > 0;
      for (const n of repo.worktrees) n.parent = rows ? repo : undefined;
      for (const g of repo.groups) g.parent = rows ? repo : undefined;
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
    for (const n of this.expanded) if (!this.isLive(n)) this.expanded.delete(n);
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
      if (this.expanded.has(node) || (!node.ref && node.isCurrent)) this.enqueue(node);
      else node.stale = true;
    }
    void this.linkPrs();
  }

  onExpand(node: Node) {
    if (!(node instanceof WorktreeNode) || this.expanded.has(node)) return;
    this.expanded.add(node);
    node.stale = true;
    this.rewatchExpanded();
  }

  /**
   * "Open All Changes" on a collapsed row: open it first (so its worktree is watched), wait for its
   * diff, then open.
   */
  async openAll(node: WorktreeNode | FolderNode | SubmoduleNode, view: vscode.TreeView<Node>) {
    if (node instanceof WorktreeNode) await this.ready(node, view);
    await openAll(node);
  }

  /** Open a row in the tree (so its worktree is watched) and wait for its diff. Other rows stay open. */
  private async ready(node: WorktreeNode, view: vscode.TreeView<Node>) {
    if (!this.expanded.has(node)) {
      // The tree catching up (scrolling to the row) is cosmetic; the diff does not wait for it.
      void view.reveal(node, { expand: true, select: true, focus: false }).then(undefined, () => undefined);
      this.onExpand(node); // no-op if the reveal's expand event already did it
    }
    if (node.stale || !node.diff) await this.reload(node);
  }

  /**
   * The changed-file row showing this document, among the open rows: a diff side is the real file
   * (a worktree), a snapshot of it under the row's store, or a virtual document at its real path.
   * An exact snapshot match wins, then a worktree row, since a branch row's paths point into the
   * main checkout too.
   */
  fileFor(uri: vscode.Uri): FileNode | undefined {
    const target = uri.path;
    let loose: FileNode | undefined;
    for (const row of this.expanded) {
      if (!row.diff) continue;
      for (const f of collectFiles(row.tree)) {
        const snapshots = [snapshotDir(row.store, f.diff, f.diff.baseRef), ...(f.diff.headRef ? [snapshotDir(row.store, f.diff, f.diff.headRef)] : [])];
        const rels = [f.change.path, ...(f.change.oldPath ? [f.change.oldPath] : [])];
        if (snapshots.some((dir) => rels.some((rel) => vscode.Uri.file(path.join(dir, rel)).path === target))) return f;
        if (vscode.Uri.file(f.absPath).path === target && (!loose || (loose.owner.ref && !row.ref))) loose = f;
      }
    }
    return loose;
  }

  /** The repos in the tree, for the CLI to find the window showing its repo. */
  commonDirs(): string[] {
    return this.repos.map((r) => r.commonDir);
  }

  /** `crosscut present`: open a row's changes, optionally under a new comparison, from outside. */
  async present(req: PresentRequest, view: vscode.TreeView<Node>): Promise<PresentResponse> {
    // A repo this window does not show (the agent works elsewhere) joins the tree rather than failing.
    if (!this.repos.some((r) => r.commonDir === req.commonDir) && !(await this.addRepo(req.worktree))) {
      return { ok: false, message: `${req.worktree} is not a git repository` };
    }
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
    if (!node && req.ref?.startsWith('pr/')) {
      return { ok: false, message: `#${req.ref.slice(3)} is not under Open pull requests: it is not open, or its branch is not fetched` };
    }
    if (!node) return { ok: false, message: `no row for ${req.ref ?? req.worktree} in the Crosscut tree` };
    if (req.mode === 'uncommitted' && node.ref) return { ok: false, message: 'a branch has no uncommitted changes' };
    // A different comparison than the row shows gets a row of its own, so presenting never changes
    // what the user has open. Asking again for the same row and comparison reuses that row.
    if (req.mode && req.mode !== this.modeFor(node)) {
      const source = node;
      const id = `present-${hash(`${source.key}\0${req.mode}`)}`;
      const name = source.ref?.short ?? source.wt.branch ?? path.basename(source.wt.path);
      const main = this.repos.find((r) => r.commonDir === req.commonDir)?.worktrees[0]?.wt.path ?? source.wt.path;
      const entry = { id, label: name, sha: source.ref?.sha ?? source.wt.head, base: '', when: 'presented', author: '' };
      await this.openAdHoc(main, entry, view, source.webUrl, { of: source, mode: req.mode });
      node = this.branchNodes.get(`${req.commonDir}\0adhoc/${id}`);
      if (!node) return { ok: false, message: `could not open ${name} under a new comparison` };
    }
    await this.ready(node, view);
    if (node.error) return { ok: false, message: node.error };
    // A review staged since the row loaded (the usual reason to present a PR) must show up, but it
    // is several GitHub round trips: fetch it alongside opening the diff rather than before it.
    // Threads attach to the diff's documents by URI, so they appear whenever the fetch lands.
    void this.loadComments(node, true).catch((e) => log.warn(`comments for ${nodeName(node)}: ${e}`));

    // Specs name repo-relative paths, a folder standing for everything under it.
    const root = node.ref ? node.wt.path : req.worktree;
    const files = collectFiles(node.tree);
    const matching = (spec: PresentSpec) => {
      const abs = path.join(root, spec.path);
      return files.filter((f) => f.absPath === abs || f.absPath.startsWith(abs + path.sep));
    };
    const toRange = (lines?: [number, number]) => lines && new vscode.Range(lines[0] - 1, 0, lines[1] - 1, 0);
    const missing = [...(req.only ?? []), ...(req.mark ?? []), ...(req.open ? [req.open] : []), ...(req.file ? [req.file] : [])]
      .filter((spec) => !matching(spec).length)
      .map((spec) => spec.path);
    if (missing.length) return { ok: false, message: `not changed in ${node.baseLabel}: ${missing.join(', ')}` };

    // Highlight every requested range; a later present replaces the earlier highlights.
    presentedLines.clear();
    const ranged = [...(req.only ?? []), ...(req.mark ?? []), ...(req.open ? [req.open] : []), ...(req.file ? [req.file] : [])].filter(
      (spec) => spec.lines,
    );
    for (const spec of ranged) {
      for (const f of matching(spec)) {
        const { right } = await diffSides(f);
        const key = right.toString();
        presentedLines.set(key, [...(presentedLines.get(key) ?? []), toRange(spec.lines)!]);
      }
    }

    // The multi-file editor does not land reliably on a line range (it folds unchanged lines, and
    // stops short or at the top of the file), so a single file with lines goes to the ordinary diff
    // editor, which does. That is also every per-finding link.
    const single = !req.open && req.only?.length === 1 && req.only[0].lines && matching(req.only[0]).length === 1 ? req.only[0] : undefined;
    const open = req.open ?? single;
    if (open) {
      const [f] = matching(open);
      await keepUserEditor();
      await openDiff(f, { preview: false });
      const range = toRange(open.lines);
      const ed = vscode.window.activeTextEditor;
      if (range && ed) {
        ed.selection = new vscode.Selection(range.start, range.start);
        // Centred, a range taller than the view loses its top; pin those to the top instead, with
        // a few lines of context above.
        const visible = ed.visibleRanges[0];
        const height = visible ? visible.end.line - visible.start.line : 30;
        if (range.end.line - range.start.line + 6 > height) {
          ed.revealRange(new vscode.Range(Math.max(0, range.start.line - 3), 0, range.start.line, 0), vscode.TextEditorRevealType.AtTop);
        } else {
          ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      }
      highlightPresented();
      return { ok: true, message: `opened ${f.change.path}, ${node.baseLabel}` };
    }

    const only = req.only && [...new Set(req.only.flatMap(matching))];
    // Scroll to --file if given, else to the first spec that names lines.
    const first = req.file ?? req.mark?.[0] ?? ranged[0];
    const reveal = first && matching(first)[0];
    // Scroll to the file, not the lines: the multi-file editor misplaces a line range.
    await keepUserEditor();
    await openAll(node, reveal, { only, keepOthers: true });
    highlightPresented();
    const n = only?.length ?? files.length;
    return { ok: true, message: `opened ${n} file${n === 1 ? '' : 's'}${only ? ` of ${files.length}` : ''}, ${node.baseLabel}` };
  }

  private repoOf(node: WorktreeNode): string | undefined {
    return this.repos.find((r) => r.worktrees.includes(node))?.commonDir;
  }

  onCollapse(node: Node) {
    if (node instanceof WorktreeNode && this.expanded.delete(node)) this.rewatchExpanded();
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
    const src = node.presentOf ?? node; // whose worktree or branch this row diffs
    const cwd = src.wt.path;
    const tip = src.ref?.sha ?? 'HEAD';
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
            ? await stackCandidates(cwd, tip, base, src.ref?.ref ?? (src.wt.branch && `refs/heads/${src.wt.branch}`) ?? undefined)
            : [];
        const against = stack[0]?.ref ?? base;
        const mb = against && (await mergeBase(cwd, against, tip));
        if (against && mb) {
          baseRef = mb;
          baseLabel = stack[0] ? `vs ${stack[0].short} (stacked)` : `vs ${base}`;
        } else if (src.ref) {
          throw new Error('no base branch found to compare against');
        } else {
          baseLabel = 'uncommitted (no base branch found)';
        }
      }
      if (src.ref && !(await hasRef(cwd, tip))) {
        throw new Error(`commit ${tip.slice(0, 10)} is not in this clone — fetch it first`);
      }
      diff = preview ? preview.diff : src.ref ? await loadRefDiff(cwd, baseRef, tip) : await loadDiff(cwd, baseRef);
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

  /** Working-tree files of each open worktree. A watcher lives exactly as long as its row is open. */
  private rewatchExpanded() {
    const targets = new Set([...this.expanded].filter((n) => !(n.presentOf ?? n).ref).map((n) => n.wt.path));
    for (const [p, w] of this.expandedWatchers) {
      if (targets.has(p)) continue;
      w.dispose();
      this.expandedWatchers.delete(p);
    }
    for (const target of targets) {
      if (this.expandedWatchers.has(target)) continue;
      this.expandedWatchers.set(
        target,
        watch(new vscode.RelativePattern(vscode.Uri.file(target), '**/*'), (uri) => {
          const p = uri.fsPath;
          if (p.includes(`${path.sep}node_modules${path.sep}`) || p.includes(`${path.sep}.git${path.sep}`) || p.endsWith(`${path.sep}.git`)) return;
          this.scheduleExpandedRefresh(p);
        }),
      );
    }
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
    if (!node) return this.repoRows ? this.repos : (this.repos[0]?.children ?? []);
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
      if (this.added.has(node.commonDir)) {
        item.description = 'added';
        item.contextValue = 'repo.added';
      }
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
        this.expanded.has(node) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
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
        this.expanded.has(node) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
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
    this.expandedWatchers.forEach((w) => w.dispose());
    clearTimeout(this.listTimer);
    clearTimeout(this.diffTimer);
  }
}

export function watch(pattern: vscode.RelativePattern, onEvent: (uri: vscode.Uri) => void): vscode.Disposable {
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
export function itemUri(absPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'crosscut-item', path: absPath });
}

/** Where a worktree lives, short enough for a row: relative to the main checkout, an agent
 * scratchpad, or its parent dir. */
export function shortLocation(wtPath: string, mainPath: string): string {
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

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
