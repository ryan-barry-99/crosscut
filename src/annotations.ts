import * as path from 'path';
import * as vscode from 'vscode';
import { BlameLine, blameFile } from './blame';
import { ReviewComment, commitAuthorLogin, prForCommit } from './gh';
import { hasRef, fetchPullRef, git } from './git';
import { log } from './log';
import { refUri, storageRoot, snapshotOrigins } from './snapshots';
import { storeOwners, ownerOfDocument } from './model';
import { isInside } from './provider';
import { fetchedAt } from './branches';

// ---------------------------------------------------------------------------
// Blame annotations. Snapshot files live outside any repo, so GitLens and friends can't blame them;
// here the path maps back to (repo, commit, path) and `git blame <commit>` fills in the rest.

export interface BlameTarget {
  root: string;
  ref?: string; // undefined = blame the working tree
  rel: string;
}

export const repoRoots = new Map<string, string | undefined>(); // containing dir -> that file's repo root

/** The repo a real file belongs to. `git show <sha>:<path>` needs a repo-relative path, not an absolute one. */
export async function repoRootOf(dir: string): Promise<string | undefined> {
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

/** The main checkout of the repo a path belongs to (worktree paths differ from the main one). */
export async function repoMainPath(cwd: string): Promise<string | undefined> {
  return git(cwd, ['worktree', 'list', '--porcelain'])
    .then((o) => /^worktree (.+)$/m.exec(o)?.[1])
    .catch(() => undefined);
}

export async function blameTarget(uri: vscode.Uri): Promise<BlameTarget | undefined> {
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
export const hoverCache = new Map<string, Promise<BlameLine[]>>();

export function blameForDocument(doc: vscode.TextDocument, target: BlameTarget): Promise<BlameLine[]> {
  const key = `${doc.uri.toString()}#${target.ref ?? doc.version}`;
  let hit = hoverCache.get(key);
  if (!hit) {
    hit = blameFile(target.root, target.ref, target.rel);
    hoverCache.set(key, hit);
    if (hoverCache.size > 40) hoverCache.delete(hoverCache.keys().next().value!);
  }
  return hit;
}

export function blameHover(b: BlameLine, target: BlameTarget): vscode.MarkdownString {
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
export async function openAuthor(arg: { root: string; sha: string; email: string; name: string }) {
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
export async function traceThroughPr(arg: { root: string; sha: string; rel: string; line: number }) {
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
export async function showCommit(arg: { root: string; sha: string; rel: string }) {
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
export const commentDecoration = vscode.window.createTextEditorDecorationType({
  after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorInfo.foreground'), fontStyle: 'italic' },
});

export function decorateComments(editor: vscode.TextEditor) {
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

export function decorateAllVisible() {
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
export function urisOfTab(tab: vscode.Tab): string[] {
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
export function collapseThreadsOfClosedTabs(closed: readonly vscode.Tab[]) {
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

export const commentBadges = new vscode.EventEmitter<undefined>();
export const commentFileDecorations: vscode.FileDecorationProvider = {
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

export const blameDecoration = vscode.window.createTextEditorDecorationType({
  after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
});
export const blamed = new Set<string>(); // document URIs currently annotated

export async function toggleBlame() {
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
