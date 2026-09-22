import * as vscode from 'vscode';
import { BranchRef } from './git';
import { WorktreeNode } from './model';

/** git/gh failures are multi-line and noisy; a row shows the gist and the tooltip carries the rest. */
export function shortError(message: string): string {
  const first = message.split('\n').find((l) => l.trim()) ?? message;
  const cleaned = first.replace(/^git [^:]*: /, '').replace(/^fatal: /, '');
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

/** Tooltip for a row: the pull request's description, or the tip commit's full message. */
export function describe(node: WorktreeNode, b?: BranchRef): vscode.MarkdownString {
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
export function clip(text: string, lines = 12, chars = 800): string {
  const kept = text.split('\n').slice(0, lines).join('\n');
  return kept.length > chars || kept.length < text.length ? `${kept.slice(0, chars).trimEnd()}\n\n…` : kept;
}

export const shortName = (ref: string) => ref.replace(/^refs\/(heads\/|remotes\/[^/]+\/)/, '');

/**
 * The branch name GitHub knows, from the full refname: `refs/heads/feature/x` and
 * `refs/remotes/origin/feature/x` are both `feature/x`. Stripping the first path segment of the
 * short name is wrong — it eats the first segment of a slashed local branch.
 */
export function branchNameOf(b: BranchRef): string {
  const m = /^refs\/(?:heads\/(.+)|remotes\/[^/]+\/(.+))$/.exec(b.ref);
  return m?.[1] ?? m?.[2] ?? b.short;
}
