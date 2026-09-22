import * as vscode from 'vscode';
import { PrInfo } from './gh';
import { isAncestor, listRefs, deleteRef, deleteBranch, BranchRef } from './git';
import { log } from './log';
import { WorktreeNode } from './model';

// ---------------------------------------------------------------------------
// Deleting local branches. Never automatic: an "upstream gone" branch may have been squash-merged
// (so git can't prove it is contained in main) or belong to a PR that was closed, not merged.
// Every deletion is confirmed and its tip sha is logged, so `git branch <name> <sha>` restores it.

export interface Verdict {
  b: BranchRef;
  merged: boolean; // provably safe: contained in the base branch, or its PR was merged
  why: string;
}

export async function classify(main: string, node: WorktreeNode, base: string, prs: Map<string, PrInfo>): Promise<Verdict> {
  const b = node.ref!;
  const pr = prs.get(b.short);
  if (await isAncestor(main, b.sha, base)) return { b, merged: true, why: `$(check) merged into ${base}` };
  // A squash-merged branch is never an ancestor of the base branch, so only the PR can vouch for it.
  if (pr?.state === 'MERGED') return { b, merged: true, why: `$(check) PR #${pr.number} merged (squashed)` };
  if (pr?.state === 'OPEN') return { b, merged: false, why: `$(warning) PR #${pr.number} still open` };
  if (pr?.state === 'CLOSED') return { b, merged: false, why: `$(warning) PR #${pr.number} closed without merging` };
  return { b, merged: false, why: `$(warning) not in ${base}, and no PR found` };
}

export function recoveryLine(name: string, sha: string): string {
  return `deleted branch ${name} at ${sha} — restore with: git branch ${name} ${sha}`;
}

export async function deleteBranches(main: string, picks: Verdict[]): Promise<string[]> {
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

export function doneMessage(count: number, failed: string[]) {
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
export async function pruneFetchedPrRefs(repos: string[]) {
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

export const fetchedAt = new Map<string, number>(); // "<repo>\0<ref>" -> when this session fetched it
