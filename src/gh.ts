import { execFile, spawn } from 'child_process';

// gh failures are reported rather than swallowed: "no PR for this commit" and "gh could not run"
// look identical otherwise.
let onError: (message: string) => void = () => undefined;
export function setGhErrorHandler(fn: (message: string) => void) {
  onError = fn;
}

function report(args: string[], err: unknown, stderr: string) {
  const detail = (stderr || (err instanceof Error ? err.message : String(err))).split('\n').filter(Boolean).slice(0, 2).join(' ');
  onError(`gh ${args.slice(0, 3).join(' ')}: ${detail}`);
}

export interface PrInfo {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
}

/**
 * Pull-request state per branch name, from the GitHub CLI. A squash-merged branch is not an
 * ancestor of the base branch, so git alone cannot tell "merged" from "abandoned" — the PR can.
 * Returns an empty map when gh is missing, unauthenticated, or the repo isn't on GitHub.
 */
export function prsByBranch(cwd: string, limit = 500): Promise<Map<string, PrInfo>> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', '--paginate', `repos/{owner}/{repo}/pulls?state=all&per_page=100&sort=updated&direction=desc`, '--jq',
       '.[] | {number, state: (if .merged_at then "MERGED" else (.state | ascii_upcase) end), headRefName: .head.ref, url: .html_url}'],
      { cwd, timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          report(['api', 'pulls'], err, stderr);
          return resolve(new Map());
        }
        try {
          const rows = stdout
            .split('\n')
            .filter(Boolean)
            .slice(0, limit)
            .map((l) => JSON.parse(l) as { number: number; state: PrInfo['state']; headRefName: string; url: string });
          const map = new Map<string, PrInfo>();
          // rows are newest-first; keep the newest PR per branch, preferring a merged one
          for (const r of rows) {
            const prev = map.get(r.headRefName);
            if (!prev || (prev.state !== 'MERGED' && r.state === 'MERGED')) {
              map.set(r.headRefName, { number: r.number, state: r.state, url: r.url });
            }
          }
          resolve(map);
        } catch {
          resolve(new Map());
        }
      },
    );
  });
}

export interface PrForCommit {
  number: number;
  title: string;
  url: string;
  headSha: string;
  baseRef: string;
}

/** The pull request a commit belongs to, via the GitHub CLI. Undefined when gh can't answer. */
export function prForCommit(cwd: string, sha: string): Promise<PrForCommit | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '.[0] | {number, title, url: .html_url, headSha: .head.sha, baseRef: .base.ref}'],
      { cwd, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) report(['api', 'commits/…/pulls'], err, stderr);
        if (err || !stdout.trim()) return resolve(undefined);
        try {
          const pr = JSON.parse(stdout) as PrForCommit;
          resolve(pr.number ? pr : undefined);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

/** The repo's web URL, for opening branches when there is no PR. */
export function repoUrl(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // REST, not `gh repo view`: that one goes through GraphQL, which is deprecated/limited on some hosts.
    execFile('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.html_url'], { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) report(['api', 'repos'], err, stderr);
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

export interface ReviewComment {
  id: number;
  path: string;
  line?: number; // line in the head version; absent when the comment is outdated
  side: 'LEFT' | 'RIGHT';
  body: string;
  author: string;
  when: string; // ISO timestamp
  url: string;
  inReplyTo?: number;
}

export interface ReviewSummary {
  author: string;
  state: string; // APPROVED / CHANGES_REQUESTED / COMMENTED …
  body: string;
  when: string;
  url: string;
}

function ghJson<T>(cwd: string, args: string[]): Promise<T[]> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        report(args, err, stderr);
        return resolve([]);
      }
      const rows: T[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as T);
        } catch {
          // a partial line: ignore
        }
      }
      resolve(rows);
    });
  });
}

/** Inline review comments on a pull request (paginated; REST, since gh's GraphQL path is unreliable here). */
export function prComments(cwd: string, number: number): Promise<ReviewComment[]> {
  return ghJson<ReviewComment>(cwd, [
    'api',
    '--paginate',
    `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`,
    '--jq',
    '.[] | {id, path, line, side, body, author: .user.login, when: .created_at, url: .html_url, inReplyTo: .in_reply_to_id}',
  ]);
}

/** Review-level summaries (approvals, change requests and their bodies). */
export function prReviews(cwd: string, number: number): Promise<ReviewSummary[]> {
  return ghJson<ReviewSummary>(cwd, [
    'api',
    '--paginate',
    `repos/{owner}/{repo}/pulls/${number}/reviews?per_page=100`,
    '--jq',
    '.[] | {author: .user.login, state, body, when: .submitted_at, url: .html_url}',
  ]);
}

export interface DraftComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

/**
 * Stage comments as a PENDING review: visible only to its author, editable and discardable on
 * GitHub until they press Submit. The `event` field is deliberately never sent — sending it
 * (COMMENT/APPROVE/REQUEST_CHANGES) would publish the review immediately.
 */
export function stagePendingReview(cwd: string, number: number, body: string, comments: DraftComment[]): Promise<{ ok: boolean; message: string }> {
  const payload = JSON.stringify({ body, comments });
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'], { cwd });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    proc.on('error', (e) => resolve({ ok: false, message: String(e) }));
    proc.on('close', (code) => {
      if (code === 0) {
        const id = /"id":\s*(\d+)/.exec(out)?.[1];
        resolve({ ok: true, message: id ? `pending review ${id}` : 'pending review created' });
      } else {
        resolve({ ok: false, message: (err || out).split('\n').filter(Boolean).slice(0, 2).join(' ') });
      }
    });
  });
}

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  merged: boolean;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
}

/** Everything a PR row's tooltip shows: the description, who opened it, and its size. */
export function prDetails(cwd: string, number: number): Promise<PrDetails | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/pulls/${number}`,
        '--jq',
        '{number, title, body: (.body // ""), author: .user.login, state, draft, merged, baseRef: .base.ref, headRef: .head.ref, additions, deletions, changedFiles: .changed_files, url: .html_url}',
      ],
      { cwd, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          report(['api', `pulls/${number}`], err, stderr);
          return resolve(undefined);
        }
        try {
          resolve(JSON.parse(stdout) as PrDetails);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

/** The GitHub login that authored a commit, when the API knows it. */
export function commitAuthorLogin(cwd: string, sha: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', `repos/{owner}/{repo}/commits/${sha}`, '--jq', '.author.login // empty'],
      { cwd, timeout: 20000 },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

export interface RefTitle {
  number: number;
  title: string;
  kind: 'pull' | 'issue';
  state: string;
  url: string;
}

/** Titles for referenced issues/PRs, one REST call each (GraphQL is unreliable on some hosts). */
export async function refTitles(cwd: string, numbers: number[], repo?: string): Promise<Map<number, RefTitle>> {
  const target = repo ?? '{owner}/{repo}';
  const results = await Promise.all(
    numbers.slice(0, 20).map(
      (n) =>
        new Promise<RefTitle | undefined>((resolve) => {
          execFile(
            'gh',
            ['api', `repos/${target}/issues/${n}`, '--jq', '{number, title, state, url: .html_url, kind: (if .pull_request then "pull" else "issue" end)}'],
            { cwd, timeout: 15000 },
            (err, stdout) => {
              if (err) return resolve(undefined);
              try {
                resolve(JSON.parse(stdout) as RefTitle);
              } catch {
                resolve(undefined);
              }
            },
          );
        }),
    ),
  );
  return new Map(results.filter((r): r is RefTitle => !!r).map((r) => [r.number, r]));
}
