import { git } from './git';

export interface BlameLine {
  sha: string;
  author: string;
  email: string;
  when: string; // relative, e.g. "3 weeks ago"
  date: string; // absolute, e.g. "2026-08-14 09:31"
  summary: string;
  uncommitted: boolean;
  origLine: number; // this line's number in that commit's own version of the file
  origPath: string; // the file's path at that commit — renames mean it differs from today's path
}

const cache = new Map<string, BlameLine[]>();

function absolute(unixSeconds: number, tz: string): string {
  const offset = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  const shift = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const d = new Date((unixSeconds + shift * 60) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${
    tz ? ` ${tz}` : ''
  }`;
}

function relative(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  const units: [number, string][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [86400 * 7, 'day'],
    [86400 * 30, 'week'],
    [86400 * 365, 'month'],
    [Infinity, 'year'],
  ];
  const divisors = [1, 60, 3600, 86400, 86400 * 7, 86400 * 30, 86400 * 365];
  for (let i = 0; i < units.length; i++) {
    if (s < units[i][0]) {
      const n = Math.max(1, Math.floor(s / divisors[i]));
      return `${n} ${units[i][1]}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/**
 * Blame for one file, by final line number. `ref` blames that commit (used for snapshot files, which
 * live outside any repo); omit it to blame the working tree. Results are keyed by commit, so they are
 * cached for good — a commit's blame never changes.
 */
export async function blameFile(root: string, ref: string | undefined, rel: string): Promise<BlameLine[]> {
  const key = `${root}\0${ref ?? ''}\0${rel}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const out = await git(root, ['blame', '--porcelain', ...(ref ? [ref] : []), '--', rel]);
  const lines: BlameLine[] = [];
  const commits = new Map<string, Omit<BlameLine, 'sha' | 'uncommitted' | 'origLine'>>();
  let sha = '';
  let author = '';
  let email = '';
  let time = 0;
  let tz = '';
  let summary = '';
  let finalLine = 0;
  let origLine = 0;
  let origPath = rel;
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      // content line: the header block before it described this line
      const known = commits.get(sha);
      const info = known ?? { author, email, when: relative(time), date: absolute(time, tz), summary, origPath };
      if (!known) commits.set(sha, info);
      lines[finalLine - 1] = { sha, ...info, origPath, uncommitted: /^0+$/.test(sha), origLine };
      continue;
    }
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (header) {
      sha = header[1];
      origLine = Number(header[2]);
      finalLine = Number(header[3]);
      const known = commits.get(sha);
      if (known) {
        author = known.author;
        email = known.email;
        summary = known.summary;
        origPath = known.origPath;
      }
      continue;
    }
    // `filename` is emitted per block and is the path AT that commit: a renamed file differs from today's.
    if (line.startsWith('filename ')) origPath = line.slice(9);
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-mail ')) email = line.slice(12).replace(/[<>]/g, '');
    else if (line.startsWith('author-tz ')) tz = line.slice(10);
    else if (line.startsWith('author-time ')) time = Number(line.slice(12));
    else if (line.startsWith('summary ')) summary = line.slice(8);
  }
  if (ref) cache.set(key, lines); // working-tree blame changes as you edit
  return lines;
}
