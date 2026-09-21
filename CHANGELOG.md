# Changelog

## 0.2.0

- **Open pull requests** group: a row per open PR, diffed against the branch it targets, so a
  stacked PR shows only its own commits.
- **Rebase preview**: see what rebasing a worktree, branch or PR onto another branch would do,
  with each conflicted file shown with its markers and the commits that conflict on it. Nothing
  is checked out or rewritten.
- **`crosscut` command-line tool** (install it from the command palette):
  - `present` opens a worktree, branch, commit or range of commits in the VS Code window showing
    the repo, so an agent can show what it changed.
  - `base` prints the branch to diff against, stacked branches included.
  - `rebase-preview` lists the conflicts a rebase would hit.
- **Open All Changes**: a go-to-file picker (Ctrl+Alt+O), a Show in All Changes button on each
  file row, and switching the comparison replaces the open editor instead of leaving it stale.
- The compare-against picker lists the base comparisons first.
- Only the expanded row and the current worktree re-diff when the window opens; other rows show
  their cached counts until expanded.

### Fixed

- Open All Changes did nothing on worktree rows, and on collapsed rows.
- Open pull requests could each be listed more than once.

## 0.1.0

First release.

- Tree of every worktree, branch without a worktree, and ad-hoc commit or pull request, each with
  its changed files grouped into folders.
- Comparison per row: stacked base (detected), base branch, uncommitted only, or the last N commits.
- Submodules expand into their own file-level diffs, including nested ones.
- File lists and both sides of every diff cached on disk; the right side of a worktree diff is the
  real file, so language servers work in the diff.
- Blame on hover and as end-of-line annotations, including on cached snapshot files, with tracing
  from a squash-merged line to the original commit inside its pull request.
- Pull requests: review comments inline, review summaries, descriptions rendered with GitHub
  references linked, and local draft comments that can be staged as a pending review.
- Branch cleanup for merged branches, and automatic expiry of fetched PR refs.
