import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { RefTitle, refTitles } from './gh';
import { git } from './git';
import { log } from './log';
import { refUri, sideUri } from './snapshots';
import { WorktreeNode, Child, FolderNode, SubmoduleNode, FileNode } from './model';

// ---------------------------------------------------------------------------
// Commands

export const DESC_SCHEME = 'crosscut-desc';
export const descriptions = new Map<string, string>(); // uri -> markdown
export const descChanged = new vscode.EventEmitter<vscode.Uri>();

/**
 * GitHub shorthand in a description is plain text in a markdown preview. Turn `#123`,
 * `org/repo#123`, `@user` and bare commit hashes into links; titles are filled in later, once
 * looked up. Code spans and fenced blocks are left alone.
 */
export function linkifyGithub(text: string, slug: string, titles: Map<number, RefTitle>): string {
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

export function referencedNumbers(text: string): number[] {
  const prose = text.split(/(```[\s\S]*?```|`[^`\n]*`)/).filter((_, i) => i % 2 === 0).join(' ');
  return [...new Set([...prose.matchAll(/(?:^|[\s(])#(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** owner/repo for the repo a row belongs to, from its origin URL. */
export async function repoSlug(cwd: string): Promise<string | undefined> {
  const url = await git(cwd, ['remote', 'get-url', 'origin']).then((o) => o.trim()).catch(() => '');
  return /(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/.exec(url)?.[1];
}

/** The full PR description or commit message, in a real editor: scrollable, selectable, linkable. */
export async function showDescription(node: WorktreeNode) {
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

export async function diffSides(node: FileNode): Promise<{ left: vscode.Uri; right: vscode.Uri }> {
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

export async function openDiff(node: FileNode, opts: { preview?: boolean } = {}) {
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
  await vscode.commands.executeCommand('vscode.diff', left, right, title, opts.preview === false ? { preview: false } : undefined);
  log.info(
    `openDiff ${change.path}: sides ${(t1 - t0).toFixed(0)}ms, editor ${(performance.now() - t1).toFixed(0)}ms (left ${left.scheme})`,
  );
}

/**
 * Before opening something the user did not click (the CLI, a link): pin the active tab if it is a
 * preview, which the next editor opened in its group would otherwise replace. A diff opened from
 * the tree with a single click is one, and it is usually what they are reading.
 */
export async function keepUserEditor() {
  if (vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview) {
    await vscode.commands.executeCommand('workbench.action.keepEditor').then(undefined, () => undefined);
  }
}

export function collectFiles(nodes: Child[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n instanceof FileNode) {
      if (!n.change.gitlink && !n.change.untrackedDir) out.push(n);
    } else collectFiles(n.children, out);
  }
  return out;
}

/** All changes under a worktree, folder or submodule in one multi-file diff editor. */
export async function openAll(
  node: WorktreeNode | FolderNode | SubmoduleNode,
  reveal?: FileNode,
  opts: { only?: FileNode[]; range?: vscode.Range; keepOthers?: boolean } = {},
) {
  const every = collectFiles(node instanceof WorktreeNode ? node.tree : node.children);
  const files = opts.only ? every.filter((f) => opts.only!.includes(f)) : every;
  if (!files.length) return;
  const owner = files[0].owner;
  const branch = owner.ref?.short ?? owner.wt.branch ?? path.basename(owner.wt.path);
  // A subset is its own editor (owner differs), so it neither replaces nor is replaced by the full one.
  const scope =
    (node instanceof WorktreeNode ? '' : ` ${node instanceof FolderNode ? node.rel : node.change.path}`) +
    (opts.only ? ` — ${files.length} of ${every.length} files` : '');
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
  // Not when opened from outside (the CLI, a link): that one may be what the user is reading.
  for (const [t, other] of opts.keepOthers ? [] : allChanges) {
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
    await openMultiDiff(all, at, opts.range);
  } catch (e) {
    log.warn(`_workbench.openMultiDiffEditor failed, falling back to vscode.changes: ${e}`);
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }
}

// Line ranges handed over by `crosscut present`, highlighted wherever the file's right side shows —
// the multi-file editor's embedded editors included, which appear only as they scroll into view.
export const presentedLines = new Map<string, vscode.Range[]>(); // right-side URI -> ranges
export let presentedDecoration: vscode.TextEditorDecorationType | undefined;

export function highlightPresented() {
  presentedDecoration ??= vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  for (const ed of vscode.window.visibleTextEditors) {
    const ranges = presentedLines.get(ed.document.uri.toString());
    if (ranges) ed.setDecorations(presentedDecoration, ranges);
  }
}

/** The whole row's changes in one editor, scrolled to this file. */
export function openInAll(node: FileNode) {
  return openAll(node.owner, node);
}

export interface AllChanges {
  title: string;
  owner: string; // the row and folder it was opened for
  source: vscode.Uri;
  files: { rel: string; status: string; left: vscode.Uri; right: vscode.Uri }[];
}
export const allChanges = new Map<string, AllChanges>(); // by editor title

/** Shows the go-to-file button only while one of our multi-file diff editors is the active tab. */
export function updateAllChangesContext() {
  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
  void vscode.commands.executeCommand('setContext', 'crosscut.allChangesActive', !!label && allChanges.has(label));
}

export function openMultiDiff(all: AllChanges, reveal?: vscode.Uri, range?: vscode.Range) {
  return vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    title: all.title,
    multiDiffSourceUri: all.source,
    resources: all.files.map((f) => ({ originalUri: f.left, modifiedUri: f.right })),
    reveal: reveal && {
      modifiedUri: reveal,
      range: range && {
        startLineNumber: range.start.line + 1,
        startColumn: 1,
        endLineNumber: range.end.line + 1,
        endColumn: 1,
      },
    },
  });
}

/** Quick pick over the files in the active "Open All Changes" editor, scrolling to the chosen one. */
export async function goToFileInAll() {
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

export async function compareWithCurrent(node: FileNode) {
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
