// Throwaway git repos for tests: each one lives in its own temp dir with a fixed identity, so
// commits behave the same on every machine.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

// git.ts reads process.env when it loads, so pin the config here too: import this module first.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: ENV.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });

export class Repo {
  constructor(readonly root: string) {}

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  write(rel: string, text: string): this {
    const file = path.join(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return this;
  }

  rm(rel: string): this {
    rmSync(path.join(this.root, rel), { recursive: true, force: true });
    return this;
  }

  /** Stage everything and commit; returns the new sha. */
  commit(message: string, files: Record<string, string> = {}): string {
    for (const [rel, text] of Object.entries(files)) this.write(rel, text);
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  head(rev = 'HEAD'): string {
    return this.git('rev-parse', rev);
  }
}

const made: string[] = [];

/** A repo on `main` with one commit holding README.md. */
export function repo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crosscut-test-'));
  made.push(root);
  const r = new Repo(root);
  r.git('init', '-q', '-b', 'main');
  r.commit('initial', { 'README.md': 'hello\n' });
  return r;
}

/** A temp dir that is removed with the repos. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crosscut-test-'));
  made.push(dir);
  return dir;
}

export function cleanup() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export { ENV as GIT_TEST_ENV };
