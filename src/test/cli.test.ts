import { cleanup, repo, Repo, tempDir } from './repo';
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { PresentRequest } from '../ipc';

const CLI = path.join(__dirname, '..', 'cli.js');
let cache = '';

before(() => {
  cache = tempDir();
});
after(cleanup);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function crosscut(cwd: string, ...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, XDG_CACHE_HOME: cache } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** A stand-in for a VS Code window: advertises itself for `r` and records what it is sent. */
async function fakeWindow(r: Repo, reply = { ok: true, message: 'opened 1 file, vs main' }) {
  const dir = path.join(cache, 'crosscut', 'windows');
  mkdirSync(dir, { recursive: true });
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const socket = path.join(dir, `${id}.sock`);
  const received: PresentRequest[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      received.push(JSON.parse(buf.split('\n')[0]));
      conn.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((res) => server.listen(socket, res));
  const entry = { pid: process.pid, socket, folders: [r.root], commonDirs: [path.join(r.root, '.git')], focusedAt: Date.now(), uriScheme: 'vscode-test' };
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(entry));
  return {
    received,
    close: () => new Promise<void>((res) => server.close(() => (rmSync(path.join(dir, `${id}.json`), { force: true }), res()))),
    entryFile: path.join(dir, `${id}.json`),
  };
}

/** main plus a feature branch two commits ahead, checked out. */
function featureRepo() {
  const r = repo();
  r.git('checkout', '-q', '-b', 'feature');
  r.commit('one', { 'src/a.ts': 'a\n' });
  r.commit('two', { 'src/b.ts': 'b\n' });
  return r;
}

describe('crosscut help and errors', () => {
  test('prints usage with no command', async () => {
    const run = await crosscut(repo().root);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /^usage: crosscut/);
  });

  test('rejects an unknown command', async () => {
    const run = await crosscut(repo().root, 'frobnicate');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /unknown command frobnicate/);
  });

  test('outside a repository, needs a window to present to', async () => {
    const run = await crosscut(tempDir(), 'present');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /no VS Code window with the Crosscut extension is open/);
  });
});

describe('crosscut base', () => {
  test('prints the base branch and merge-base', async () => {
    const r = featureRepo();
    const run = await crosscut(r.root, 'base');
    assert.equal(run.stdout, `main\t${r.head('main')}\n`);
  });

  test('prints the branch a tip is stacked on', async () => {
    const r = featureRepo();
    r.git('checkout', '-q', '-b', 'on-top');
    r.commit('three');
    const run = await crosscut(r.root, 'base');
    assert.equal(run.stdout, `feature\t${r.head('feature')}\tstacked\n`);
  });

  test('fails with no base branch', async () => {
    const r = repo();
    r.git('branch', '-m', 'main', 'trunk');
    const run = await crosscut(r.root, 'base');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /no base branch/);
  });
});

describe('crosscut rebase-preview', () => {
  test('reports a clean replay and exits 0', async () => {
    const r = featureRepo();
    const run = await crosscut(r.root, 'rebase-preview', 'main');
    assert.equal(run.code, 0);
    assert.equal(run.stdout, 'clean: 2 commits replay onto main without conflicts\n');
  });

  test('lists conflicts and exits 1, as text and as JSON', async () => {
    const r = featureRepo();
    r.git('checkout', '-q', 'main');
    r.commit('main a', { 'src/a.ts': 'main\n' });
    const text = await crosscut(r.root, 'rebase-preview', 'main', 'feature');
    assert.equal(text.code, 1);
    assert.match(text.stdout, /^1 conflicted file\(s\) in 1 of 2 commits:\n  src\/a\.ts\n      [0-9a-f]+ one\n$/);
    const json = await crosscut(r.root, 'rebase-preview', 'main', 'feature', '--json');
    assert.equal(json.code, 1);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.replayed, 2);
    assert.deepEqual(parsed.conflicts.map((c: { path: string }) => c.path), ['src/a.ts']);
  });

  test('needs <onto>', async () => {
    const run = await crosscut(repo().root, 'rebase-preview');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /needs <onto>/);
  });
});

describe('crosscut present', () => {
  test('sends the worktree request to the window and prints its reply', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r);
    try {
      const run = await crosscut(r.root, 'present');
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, 'opened 1 file, vs main\n');
      assert.deepEqual(win.received, [{ cmd: 'present', commonDir: path.join(r.root, '.git'), worktree: r.root }]);
    } finally {
      await win.close();
    }
  });

  test('turns each comparison flag into a mode', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r);
    try {
      for (const args of [['--branch'], ['--uncommitted'], ['--vs', 'main'], ['--vs', 'HEAD~1'], ['--rebase', 'main'], ['--last', '2']]) {
        const run = await crosscut(r.root, 'present', ...args);
        assert.equal(run.code, 0, run.stderr);
      }
      assert.deepEqual(
        win.received.map((q) => q.mode),
        ['branch', 'uncommitted', 'base:refs/heads/main', `base:${r.head('HEAD~1')}`, 'rebase:refs/heads/main', `commit:${r.head('HEAD~2')}`],
      );
    } finally {
      await win.close();
    }
  });

  test('resolves --ref and --pr to the row they name', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r);
    try {
      await crosscut(r.root, 'present', '--ref', 'main');
      await crosscut(r.root, 'present', '--pr', '381');
      assert.deepEqual(win.received.map((q) => q.ref), ['refs/heads/main', 'pr/381']);
    } finally {
      await win.close();
    }
  });

  test('builds a row for a commit, a range and a merge-base range', async () => {
    const r = featureRepo();
    const [one, two, main] = [r.head('HEAD~1'), r.head(), r.head('main')];
    r.git('checkout', '-q', 'main');
    const mainTip = r.commit('main moves');
    r.git('checkout', '-q', 'feature');
    const win = await fakeWindow(r);
    try {
      await crosscut(r.root, 'present', '--commit', 'HEAD');
      await crosscut(r.root, 'present', `${one}..HEAD`, '--title', 'Session');
      await crosscut(r.root, 'present', 'main...feature');
      const [commit, range, mb] = win.received.map((q) => q.commit!);
      assert.equal(commit.sha, two);
      assert.equal(commit.base, one);
      assert.equal(commit.label, `${two.slice(0, 8)} two`);
      assert.equal(commit.id, `${one.slice(0, 10)}-${two.slice(0, 10)}`);
      assert.equal(commit.author, 'Test Author');
      assert.deepEqual([range.base, range.sha, range.label], [one, two, 'Session']);
      assert.deepEqual([mb.base, mb.sha, mb.label], [main, two, 'main...feature']);
      assert.notEqual(mb.base, mainTip);
    } finally {
      await win.close();
    }
  });

  test('parses file and line specs relative to where it runs', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r);
    try {
      await crosscut(path.join(r.root, 'src'), 'present', '--branch', '--only', 'a.ts:4-9', 'b.ts');
      await crosscut(r.root, 'present', '--mark', 'src/a.ts:3', '--file', 'src');
      await crosscut(r.root, 'present', '--open', 'src/b.ts:1');
      const [only, mark, open] = win.received;
      assert.deepEqual(only.only, [{ path: 'src/a.ts', lines: [4, 9] }, { path: 'src/b.ts' }]);
      assert.deepEqual(mark.mark, [{ path: 'src/a.ts', lines: [3, 3] }]);
      assert.deepEqual(mark.file, { path: 'src' });
      assert.deepEqual(open.open, { path: 'src/b.ts', lines: [1, 1] });
    } finally {
      await win.close();
    }
  });

  test('sends to a window showing another repo when none shows this one', async () => {
    const r = featureRepo();
    const elsewhere = await fakeWindow(repo());
    try {
      const run = await crosscut(r.root, 'present');
      assert.equal(run.code, 0, run.stderr);
      assert.equal(elsewhere.received[0].commonDir, path.join(r.root, '.git'));
    } finally {
      await elsewhere.close();
    }
  });

  test('prefers the window showing the repo over one focused later', async () => {
    const r = featureRepo();
    const showing = await fakeWindow(r);
    const later = await fakeWindow(repo());
    try {
      await crosscut(r.root, 'present');
      assert.equal(showing.received.length, 1);
      assert.equal(later.received.length, 0);
    } finally {
      await showing.close();
      await later.close();
    }
  });

  test('passes on the window refusing', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r, { ok: false, message: 'not changed in vs main: x' });
    try {
      const run = await crosscut(r.root, 'present', '--only', 'x');
      assert.equal(run.code, 2);
      assert.equal(run.stderr, 'crosscut: not changed in vs main: x\n');
    } finally {
      await win.close();
    }
  });

  test('fails when no window is open, and clears entries of dead windows', async () => {
    const r = featureRepo();
    const dir = path.join(cache, 'crosscut', 'windows');
    mkdirSync(dir, { recursive: true });
    const dead = path.join(dir, 'dead.json');
    writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 + 12345, socket: path.join(dir, 'dead.sock'), folders: [], commonDirs: [path.join(r.root, '.git')], focusedAt: 0 }));
    const run = await crosscut(r.root, 'present');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /no VS Code window with the Crosscut extension is open/);
    assert.equal(existsSync(dead), false);
  });

  const refusals: [string[], RegExp][] = [
    [['--branch', '--uncommitted'], /--uncommitted, --branch are alternatives/],
    [['--commit', 'HEAD', '--branch'], /--commit and --branch cannot be combined/],
    [['HEAD~1..HEAD', '--commit', 'HEAD'], /cannot be combined/],
    [['--title', 'x'], /--title names a commit or range row/],
    [['--pr', '1', '--ref', 'main'], /--pr and --ref both pick the row/],
    [['--pr', 'abc'], /--pr needs a pull request number/],
    [['--last', '0'], /--last needs a positive number/],
    [['--last', '99'], /HEAD has fewer than 99 commits/],
    [['--ref', 'no-such-branch'], /no-such-branch is not a branch/],
    [['--commit', 'nope'], /nope is not a commit/],
    [['--mark', 'a', '--only', 'b'], /pass one/],
    [['--open', 'a', '--only', 'b'], /--open shows one file on its own/],
    [['--only', 'HEAD~1..HEAD'], /put the range before --only/],
    [['--only'], /--only needs at least one value/],
    [['--file'], /--file needs a value/],
    [['--file', '../outside'], /is outside the repository/],
    [['--open', 'a.ts:9-3'], /bad line range/],
    [['--bogus', 'x'], /unknown option --bogus/],
    [['stray'], /unexpected argument stray/],
  ];
  for (const [args, message] of refusals) {
    test(`refuses ${args.join(' ')}`, async () => {
      const run = await crosscut(featureRepo().root, 'present', ...args);
      assert.equal(run.code, 2);
      assert.match(run.stderr, message);
    });
  }
});

describe('crosscut link', () => {
  test('prints a vscode link carrying the request, with the window scheme', async () => {
    const r = featureRepo();
    const win = await fakeWindow(r);
    try {
      const run = await crosscut(r.root, 'link', '--branch');
      const m = /^vscode-test:\/\/ryan-barry-99\.crosscut\/present\?q=(.+)\n$/.exec(run.stdout);
      assert.ok(m, run.stdout);
      const req = JSON.parse(decodeURIComponent(m[1]));
      assert.equal(req.mode, 'branch');
      assert.equal(win.received.length, 0, 'making a link presents nothing');
      const text = await crosscut(r.root, 'link', '--branch', '--text', 'see [this]');
      assert.match(text.stdout, /^\[see \\\[this\\\]\]\(vscode-test:\/\//);
    } finally {
      await win.close();
    }
  });

  test('falls back to the vscode scheme with no window', async () => {
    const run = await crosscut(featureRepo().root, 'link');
    assert.match(run.stdout, /^vscode:\/\/ryan-barry-99\.crosscut\/present\?q=/);
  });

  test('--chat writes a link file and its request, named by content', async () => {
    const r = featureRepo();
    const a = await crosscut(r.root, 'link', '--chat', '--branch', '--open', 'src/a.ts:2-4');
    const b = await crosscut(r.root, 'link', '--chat', '--branch', '--open', 'src/a.ts:2-4');
    assert.equal(a.stdout, b.stdout);
    const m = /^\[src\/a\.ts:2-4\]\((.+\.crosscut-link)\)\n$/.exec(a.stdout);
    assert.ok(m, a.stdout);
    assert.equal(readFileSync(m[1], 'utf8'), 'Opening in Crosscut…\n');
    const req = JSON.parse(readFileSync(m[1].replace(/\.crosscut-link$/, '.json'), 'utf8'));
    assert.deepEqual(req.open, { path: 'src/a.ts', lines: [2, 4] });
    const single = await crosscut(r.root, 'link', '--chat', '--mark', 'src/b.ts:5');
    assert.match(single.stdout, /^\[src\/b\.ts:5\]/);
    const bare = await crosscut(r.root, 'link', '--chat');
    assert.match(bare.stdout, /^\[open diff\]/);
    const labeled = await crosscut(r.root, 'link', '--chat', '--text', 'Reopen');
    assert.match(labeled.stdout, /^\[Reopen\]/);
  });
});

describe('crosscut present in a folder with no git repo', () => {
  const folder = () => {
    const dir = path.join(tempDir(), 'project');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'main.py'), 'print(1)\n');
    writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    return dir;
  };
  const shadowGit = (req: PresentRequest, ...args: string[]) =>
    execFileSync('git', [`--git-dir=${req.commonDir}`, ...args], { encoding: 'utf8' }).trim();

  test('presents every file the first time, then only what changed since', async () => {
    const dir = folder();
    const win = await fakeWindow(repo());
    try {
      const first = await crosscut(dir, 'present');
      assert.equal(first.code, 0, first.stderr);
      writeFileSync(path.join(dir, 'src', 'main.py'), 'print(2)\n');
      await crosscut(path.join(dir, 'src'), 'present', '--only', 'main.py');
      await crosscut(dir, 'present');
      const [a, b, c] = win.received;
      assert.equal(a.shadow, dir);
      assert.equal(a.worktree, dir);
      assert.equal(a.commit!.label, 'project: all files');
      assert.equal(shadowGit(a, 'diff', '--name-only', a.commit!.base, a.commit!.sha), 'README.md\nsrc/main.py');
      assert.equal(b.commit!.base, a.commit!.sha);
      assert.equal(b.commit!.baseLabel, 'since the last present');
      assert.deepEqual(b.only, [{ path: 'src/main.py' }], 'specs are relative to the folder, found from a subfolder');
      assert.equal(shadowGit(b, 'diff', '--name-only', b.commit!.base, b.commit!.sha), 'src/main.py');
      assert.equal(c.commit!.sha, b.commit!.sha, 'nothing new: the last step is shown again');
      assert.equal(c.commit!.baseLabel, 'since the last present (nothing new)');
      assert.ok(!existsSync(path.join(dir, '.git')), 'the folder itself is never touched');
    } finally {
      await win.close();
    }
  });

  test('leaves out node_modules and what the folder ignores', async () => {
    const dir = folder();
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
    writeFileSync(path.join(dir, 'debug.log'), '');
    const win = await fakeWindow(repo());
    try {
      await crosscut(dir, 'present');
      const [q] = win.received;
      assert.equal(shadowGit(q, 'ls-tree', '-r', '--name-only', q.commit!.sha), '.gitignore\nREADME.md\nsrc/main.py');
    } finally {
      await win.close();
    }
  });

  test('refuses the flags that need git', async () => {
    const run = await crosscut(folder(), 'present', '--branch');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /is not in a git repository, so --branch cannot apply/);
  });

  test('uses the real repo once the folder has one', async () => {
    const dir = folder();
    const win = await fakeWindow(repo());
    try {
      await crosscut(dir, 'present');
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      await crosscut(dir, 'present');
      assert.equal(win.received[1].shadow, undefined);
      assert.equal(win.received[1].commonDir, path.join(dir, '.git'));
    } finally {
      await win.close();
    }
  });
});
