// Pull-request rows in the tree, with a fake `gh` on PATH answering the pulls listing.
import { cleanup, repo, tempDir } from './repo';
import { config, FakeUri, Memento, workspace } from './fake-vscode';
import { after, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { setLog } from '../log';
import { BranchGroupNode, initComments, Node, WorktreeNode } from '../model';
import { WorktreeDiffsProvider } from '../provider';
import { setStorageRoot } from '../snapshots';

after(cleanup);
setLog({ info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscodeTypes.LogOutputChannel);
config.showPrComments = true;

const bin = tempDir();
const pulls = path.join(bin, 'pulls.jsonl');
writeFileSync(
  path.join(bin, 'gh'),
  `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args.includes('pulls?state=all')) process.stdout.write(require('fs').readFileSync(${JSON.stringify(pulls)}, 'utf8'));
else process.exit(1);
`,
);
chmodSync(path.join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const pr = (number: number, headRefName: string, state = 'OPEN') => JSON.stringify({ number, state, headRefName, url: `https://gh/${number}`, title: `PR ${number}`, baseRef: 'main' });

async function setup(lines: string[]) {
  writeFileSync(pulls, lines.join('\n') + '\n');
  const r = repo();
  r.git('update-ref', 'refs/remotes/origin/main', 'main');
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('topic', { 't.ts': 't\n' });
  r.git('update-ref', 'refs/remotes/origin/topic', 'HEAD');
  r.git('checkout', '-q', '-b', 'feature', 'main');
  r.commit('feature', { 'f.ts': 'f\n' });
  setStorageRoot(tempDir());
  const state = new Memento();
  initComments(state as unknown as vscodeTypes.Memento, { createCommentThread: () => ({ dispose() {} }), dispose() {} } as unknown as vscodeTypes.CommentController);
  workspace.workspaceFolders = [{ uri: FakeUri.file(r.root), name: 'r', index: 0 }];
  const provider = new WorktreeDiffsProvider(state as unknown as vscodeTypes.Memento);
  const changed = new Promise<void>((resolve) => provider.onDidChangeTreeData(() => resolve()));
  await provider.refresh();
  const prsGroup = async () => {
    for (let i = 0; i < 100; i++) {
      const g = (await provider.getChildren()).find((n: Node): n is BranchGroupNode => n instanceof BranchGroupNode && n.kind === 'prs');
      if (g) return g;
      await new Promise((res) => setTimeout(res, 20));
    }
    return undefined;
  };
  await changed;
  return { r, state, provider, prsGroup };
}

describe('pull request rows', () => {
  test('open PRs get rows diffed against their target, and rows link to their PR', async () => {
    const { state, provider, prsGroup } = await setup([pr(3, 'topic'), pr(2, 'feature'), pr(1, 'fork-only'), pr(9, 'topic', 'CLOSED')]);
    const group = await prsGroup();
    assert.ok(group);
    assert.deepEqual(group.branches.map((b) => b.ref!.short), ['#3 PR 3']);
    const row = group.branches[0];
    assert.deepEqual([row.prNumber, row.webUrl, row.ref!.author], [3, 'https://gh/3', 'into main']);
    assert.equal(state.get(`mode:${row.key}`), 'base:refs/remotes/origin/main');
    const [wt] = (await provider.getChildren()).filter((n): n is WorktreeNode => n instanceof WorktreeNode);
    assert.equal(wt.prNumber, 2);
    assert.equal(await provider.prOf(wt), 2);
    const item = provider.getTreeItem(row) as vscodeTypes.TreeItem & { iconPath: { id: string } };
    assert.equal(item.contextValue, 'branch.web.pr');
    await provider.getChildren(row);
    assert.equal(row.baseLabel, 'vs main');
    assert.deepEqual(row.tree.map((c) => (c as { change: { path: string } }).change.path), ['t.ts']);
  });
});
