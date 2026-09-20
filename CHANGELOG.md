# Changelog

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
