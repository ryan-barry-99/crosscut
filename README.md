# Worktree Diffs

See what changed in every git worktree, branch and pull request of a repository — from one tree in VS Code, with full language support in the diffs.

Built for repositories where a lot happens outside the checkout you have open: many worktrees, stacked branches, submodules, and pull requests you want to read without switching to a browser.

## What it shows

**Worktrees.** Every worktree `git worktree list` knows about, whether or not it is inside your workspace, with the files it changed. Each row can be compared against:

- the branch it is stacked on (detected automatically), or the base branch
- uncommitted changes only
- the last *N* commits of that branch

**Branches with no worktree.** Local branches nobody has checked out, and every remote branch, diffed straight from git objects — nothing is checked out and no worktree is created. Local rows show whether they are unpushed, in sync, ahead/behind, or pointing at a deleted upstream.

**Pull requests and commits.** Open a PR or a single commit as its own row, with the same file tree, diffs, and multi-file view. Review comments render inline in the diff; the PR description opens as a rendered markdown preview with `#123`, `@user` and commit references turned into links.

**Submodules.** A submodule with changes expands into its own files, compared against the commit the parent records — so pointer bumps, commits inside the submodule, and uncommitted work there all show up as file-level diffs. Nested submodules work the same way.

## Why the diffs are fast

Each row's file list is cached on disk, and both sides of every changed file are written into the extension's storage as real files. Opening a diff is a file read, not a git call, and the right side of a worktree diff is the file on disk — so hover, go-to-definition and errors come from your normal language servers.

## Blame

- Hover any line for its commit, author, date and message.
- Works on the snapshot files too — the old side of a diff, which nothing else can blame.
- End-of-line annotations for a whole file, toggled from the editor toolbar.
- On a squash-merged line, *Find the original commit inside the PR* fetches the PR's own commits (`refs/pull/N/head`) and names the commit that actually wrote the line.

## Reviewing

With the [GitHub CLI](https://cli.github.com/) installed and authenticated:

- Inline review comments appear in the diff, with replies grouped into threads.
- Files and folders show how many comments they carry.
- Comments you write are saved as **local drafts**. *Stage Review* posts them as a single **pending** review — visible only to you, editable and discardable on GitHub. The extension never submits or publishes a review; you do that on GitHub.

## Housekeeping

- **Clean up merged branches**: local branches whose upstream is gone, classified by whether git or the PR can prove they were merged. Merged ones are pre-selected, every deletion is confirmed, and each deleted tip is logged with the `git branch <name> <sha>` needed to restore it.
- **Fetched PR refs** (`refs/prs/*`) are dropped at the start of the next session by default, since they pin objects. See `worktreeDiffs.fetchedPrRefs`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `worktreeDiffs.baseBranch` | *(auto)* | Branch to compare against; empty tries `main`, `master`, then `origin/HEAD`. |
| `worktreeDiffs.defaultMode` | `branch` | Initial comparison for a worktree: `branch` or `uncommitted`. |
| `worktreeDiffs.detectStackedBase` | `true` | Diff a stacked branch against its predecessor rather than the base branch. |
| `worktreeDiffs.showPrComments` | `true` | Render pull-request review comments in diffs. |
| `worktreeDiffs.blameHover` | `true` | Show blame for the hovered line. |
| `worktreeDiffs.fetchedPrRefs` | `session` | Lifetime of fetched PR refs: `session`, `week` or `keep`. |

## Requirements

- git 2.30 or newer
- VS Code 1.86 or newer
- The GitHub CLI, only for the pull-request features

## Building

```
npm install
npm run package          # produces worktree-diffs-<version>.vsix
code --install-extension worktree-diffs-<version>.vsix
```
