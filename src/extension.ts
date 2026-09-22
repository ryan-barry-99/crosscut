import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PresentRequest } from './ipc';
import { prDetails, prForCommit, prsByBranch, repoUrl, setGhErrorHandler, stagePendingReview, pendingReviewId, pendingReviewComments, deletePendingReview } from './gh';
import { hasRef, fetchPullRef, listRefs, changedLineRanges, deleteRef, detectBaseBranch, mergeBase, git } from './git';
import { log, lastGhError, setLog, setLastGhError } from './log';
import { SCHEME, RefContentProvider, setStorageRoot } from './snapshots';
import { nodeName, RepoNode, BranchGroupNode, WorktreeNode, FolderNode, SubmoduleNode, FileNode, comments, storeOwners, drafts, ownerOfDocument, initComments } from './model';
import { WorktreeDiffsProvider } from './provider';
import { DESC_SCHEME, descriptions, descChanged, showDescription, diffSides, openDiff, presentedLines, highlightPresented, openInAll, allChanges, updateAllChangesContext, goToFileInAll, compareWithCurrent } from './diffs';
import { serveCli, installCli } from './cliServer';
import { branchNameOf } from './helpers';
import { repoMainPath, blameTarget, blameForDocument, blameHover, openAuthor, traceThroughPr, showCommit, commentDecoration, decorateComments, collapseThreadsOfClosedTabs, commentBadges, commentFileDecorations, blameDecoration, blamed, toggleBlame } from './annotations';
import { Verdict, classify, deleteBranches, doneMessage, pruneFetchedPrRefs, fetchedAt } from './branches';

export function activate(context: vscode.ExtensionContext) {
  setLog(vscode.window.createOutputChannel('Crosscut', { log: true }));
  initComments(context.workspaceState, vscode.comments.createCommentController('crosscut.prComments', 'PR review comments'));
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
    setLastGhError(m);
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
  setStorageRoot(path.join(context.globalStorageUri.fsPath, 'repos'));
  const provider = new WorktreeDiffsProvider(context.workspaceState);
  void installCli(context, false).catch((e) => log.warn(`crosscut cli: ${e}`));
  const view = vscode.window.createTreeView('crosscut', { treeDataProvider: provider, showCollapseAll: true });

  const followedLinkFiles = new Map<string, number>(); // link file -> when it was last followed

  /** Run a `.crosscut-link` file however it came to be opened, then close every tab showing it. */
  const followLinkFile = async (uri: vscode.Uri, via: string) => {
    if (uri.scheme !== 'file' || !uri.path.endsWith('.crosscut-link')) return;
    // One click can raise several of the events that lead here; follow the link once.
    const last = followedLinkFiles.get(uri.fsPath);
    if (last && Date.now() - last < 2000) return;
    followedLinkFiles.set(uri.fsPath, Date.now());
    log.info(`link file opened (${via}): ${uri.fsPath}`);
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === uri.fsPath);
    if (tabs.length) await vscode.window.tabGroups.close(tabs).then(undefined, () => undefined);
    // The request sits beside the link file; links made before that held it in the file itself.
    const sidecar = uri.fsPath.replace(/\.crosscut-link$/, '.json');
    const text = (await fs.readFile(sidecar, 'utf8').catch(() => '')) || (await fs.readFile(uri.fsPath, 'utf8').catch(() => ''));
    await followLink(() => JSON.parse(text));
  };

  /** Select the changed-file row for a document, when the tree is showing. */
  const followInTree = (uri: vscode.Uri) => {
    if (!view.visible) return;
    const file = provider.fileFor(uri);
    if (file && view.selection[0] !== file) void view.reveal(file, { select: true, focus: false }).then(undefined, () => undefined);
  };

  /**
   * Run a link's request in this window: a link opens where it was clicked (VS Code hands a vscode://
   * link to the focused window too), so a repo this window does not show joins its tree. Forwarding
   * to a window that shows the repo opened the diff out of sight, since a window cannot be raised.
   */
  const followLink = async (parse: () => PresentRequest) => {
    try {
      const req = parse();
      log.info(`link: present ${req.ref ?? req.worktree}`);
      const t = performance.now();
      const reply = await provider.present(req, view);
      log.info(`link: ${reply.ok ? 'opened' : 'failed'} in ${(performance.now() - t).toFixed(0)}ms`);
      if (!reply.ok) void vscode.window.showWarningMessage(`Crosscut link: ${reply.message}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Crosscut link: ${e instanceof Error ? e.message : e}`);
    }
  };

  context.subscriptions.push(
    provider,
    view,
    serveCli(provider, view),
    // `crosscut link` links: the same request `present` sends over the socket, carried in the URI.
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        log.info(`uri: ${uri.path} (${uri.query.length} bytes of query)`);
        if (uri.path !== '/present') {
          void vscode.window.showWarningMessage(`Crosscut link: unknown path ${uri.path}`);
          return;
        }
        await followLink(() => JSON.parse(new URLSearchParams(uri.query).get('q') ?? ''));
      },
    }),
    // `crosscut link --chat` links: a file holding the request, since chat panels open file links
    // but not vscode:// ones. Opening the file runs it, and the tab closes itself. Chat panels open
    // their links in the text editor explicitly, which skips the custom editor below, so text tabs
    // on these files are caught as they open, too.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      // A preview tab reused for the file arrives as a change, not an open.
      for (const tab of [...e.opened, ...e.changed]) {
        if (tab.input instanceof vscode.TabInputText) void followLinkFile(tab.input.uri, 'tab');
      }
    }),
    // Clicking a link whose file is already open in a tab only focuses that tab, which the tab
    // events may not report; the active editor changing does.
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && void followLinkFile(ed.document.uri, 'editor')),
    vscode.workspace.onDidOpenTextDocument((doc) => void followLinkFile(doc.uri, 'document')),
    vscode.window.registerCustomEditorProvider(
      'crosscut.link',
      {
        async resolveCustomTextEditor(document, panel) {
          panel.webview.html = '<p style="font-family: sans-serif">Opening in Crosscut…</p>';
          const sidecar = document.uri.fsPath.replace(/\.crosscut-link$/, '.json');
          const text = (await fs.readFile(sidecar, 'utf8').catch(() => '')) || document.getText();
          await followLink(() => JSON.parse(text));
          panel.dispose();
        },
      },
      { supportsMultipleEditorsPerDocument: true },
    ),
    // Follow the editor: select the changed-file row for whatever diff (or file) is in front.
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && followInTree(ed.document.uri)),
    // In an Open All Changes editor, only the files on screen have editors, so the set of visible
    // editors changes as it scrolls; the topmost of them, in the order the editor lists its files,
    // is the one being read.
    vscode.window.onDidChangeVisibleTextEditors((eds) => {
      const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
      const all = label ? allChanges.get(label) : undefined;
      log.info(
        `visible editors: tab "${label}" ${all ? 'is' : 'is not'} an all-changes editor; ${eds.length} editors: ${eds
          .map((e) => `${e.document.uri.scheme}:${path.basename(e.document.uri.path)}`)
          .join(', ')}`,
      );
      if (!all) return;
      const shown = new Set(eds.map((e) => e.document.uri.toString()));
      const top = all.files.find((f) => shown.has(f.right.toString()) || shown.has(f.left.toString()));
      if (top) followInTree(top.right.scheme === 'file' ? top.right : top.left);
    }),
    view.onDidExpandElement((e) => {
      log.info(`expand ${nodeName(e.element)}`);
      provider.onExpand(e.element);
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
    vscode.window.onDidChangeVisibleTextEditors(() => presentedLines.size && highlightPresented()),
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
    vscode.commands.registerCommand('crosscut.removeRepo', (n: RepoNode) => provider.removeRepo(n.commonDir)),
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
