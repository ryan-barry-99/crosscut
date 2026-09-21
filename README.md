# Crosscut

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

With the [GitHub CLI](https://cli.github.com/) installed and authenticated, a row that belongs to a pull request — a worktree or branch whose branch has one, or a PR opened from a blame hover — carries its review conversation.

- Existing review comments appear in the diff, previewed at the end of the line and expandable into full threads, with replies grouped together.
- Files and folders show how many comments they carry, in the tree and in the multi-file diff.
- Review summaries and comments GitHub can no longer anchor are listed separately from the row.

### Writing comments

1. Open a file from a pull-request row, so the diff belongs to that PR.
2. Right-click the line you want to comment on — or hover its gutter and click the `+` that appears. To comment on a span, select the lines first.
3. Type the comment and press **Add draft comment**.

Only lines the pull request changed can be commented on, because GitHub rejects the rest. If a line offers nothing, it is not part of the diff.

Drafts are stored locally and survive reloads; the row shows how many you have.

### Sending a review

**Stage Review** sends your drafts to GitHub as a single **pending** review. Only you can see it, and it stays editable and discardable there until you press Submit yourself. GitHub allows one pending review per person per pull request, so the extension checks for an existing one first, and **Discard Pending Review on GitHub…** deletes yours after confirming how many unsubmitted comments it holds.

Staging cannot carry a summary: GitHub's *Finish your review* dialog does not pre-fill from a pending review's body, so a write-up staged with the comments is lost unless you retype it there. Submitting directly avoids that.

To submit directly, set `crosscut.allowSubmitReview` to `true`. A **Submit Review to GitHub…** action then appears on pull-request rows:

1. Write the comments as usual — they are still local drafts until this point.
2. Press **Submit Review to GitHub…** on the row.
3. Choose the verdict: comment, approve, or request changes.
4. Type the summary, which is sent together with the comments as the review body.
5. Confirm. It posts immediately and everyone watching the pull request can see it.

A summary with no comments is a valid review. GitHub does not let you approve your own pull request, and says so if you try.

## Housekeeping

- **Clean up merged branches**: local branches whose upstream is gone, classified by whether git or the PR can prove they were merged. Merged ones are pre-selected, every deletion is confirmed, and each deleted tip is logged with the `git branch <name> <sha>` needed to restore it.
- **Fetched PR refs** (`refs/prs/*`) are dropped at the start of the next session by default, since they pin objects. See `crosscut.fetchedPrRefs`.

## Command line

**Crosscut: Install 'crosscut' Command-Line Tool** writes `~/.local/bin/crosscut`, which runs with the extension host's own node and is kept current across extension updates.

- `crosscut present [--vs <rev> | --rebase <rev> | --uncommitted | --last <n> | --branch] [--ref <branch>] [--file <path>]` opens the current worktree's changes (or a branch's) in the VS Code window showing the repo, as one multi-file diff. A comparison flag also becomes the row's comparison in the tree. Meant for agents: run it from a terminal to show someone a change against the right base.
- `crosscut present --commit <rev>` or `crosscut present <from>..<to>` (`...` for the merge-base) opens a commit or range as its own row under **Opened commits & PRs**; `--title` names it. An agent can show what a session did by noting `HEAD` at the start and presenting `<start>..HEAD` at the end.
- `crosscut base [<tip>]` prints the branch `<tip>` is stacked on, or the base branch, and the merge-base.
- `crosscut rebase-preview <onto> [<tip>] [--json]` lists the files a rebase would conflict on and the commits responsible, without touching anything. Exits 1 when it would conflict.

Each window listens on a unix socket under `~/.cache/crosscut/windows/`; `present` picks the window whose workspace contains the current directory, else the one focused last.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `crosscut.baseBranch` | *(auto)* | Branch to compare against; empty tries `main`, `master`, then `origin/HEAD`. |
| `crosscut.defaultMode` | `branch` | Initial comparison for a worktree: `branch` or `uncommitted`. |
| `crosscut.detectStackedBase` | `true` | Diff a stacked branch against its predecessor rather than the base branch. |
| `crosscut.showPrComments` | `true` | Render pull-request review comments in diffs. |
| `crosscut.blameHover` | `true` | Show blame for the hovered line. |
| `crosscut.fetchedPrRefs` | `session` | Lifetime of fetched PR refs: `session`, `week` or `keep`. |
| `crosscut.allowSubmitReview` | `false` | Show **Submit Review**, which posts a review to GitHub immediately instead of staging it as pending. |

## Requirements

- git 2.30 or newer
- VS Code 1.86 or newer
- The GitHub CLI, only for the pull-request features

## Building

```
npm install
npm run package          # produces crosscut-<version>.vsix
code --install-extension crosscut-<version>.vsix
```
