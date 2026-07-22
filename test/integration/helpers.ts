import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CLI = resolve(import.meta.dirname, '../../dist/cli.js');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Fixture {
  root: string;
  repo: string;
  origin: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function git(fix: Fixture, args: string[], cwd = fix.repo): RunResult {
  return run('git', args, cwd, fix.env);
}

export function cli(fix: Fixture, args: string[], cwd = fix.repo): RunResult {
  return run(process.execPath, [CLI, ...args], cwd, fix.env);
}

export function cliJson(fix: Fixture, args: string[], cwd = fix.repo): Record<string, unknown> {
  const res = cli(fix, ['--json', ...args], cwd);
  if (res.stdout.trim().length === 0) {
    throw new Error(`no JSON output; code=${res.code} stderr=${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
}

/** Create a temp repo with a local bare origin, an initial commit, and an isolated HOME. */
export function makeFixture(opts: { devin?: boolean; branch?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'devin-autogit-it-'));
  const home = join(root, 'home');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    DEVIN_AUTOGIT_HOME: join(home, '.devin-autogit'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  if (opts.devin) env['DEVIN_SESSION_ID'] = 'devin-test-session';

  const fix: Fixture = { root, repo, origin, home, env };
  writeFileSync(join(home, '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
  run('git', ['init', '--bare', origin], root, env);
  git(fix, ['init', '-b', opts.branch ?? 'devin/test/work']);
  git(fix, ['config', 'user.name', 'Test']);
  git(fix, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(fix, ['add', '-A']);
  git(fix, ['commit', '-m', 'initial']);
  git(fix, ['remote', 'add', 'origin', origin]);
  git(fix, ['push', 'origin', 'HEAD']);
  return fix;
}

export function enable(fix: Fixture): void {
  const res = cli(fix, ['on', '--public-ok']);
  if (res.code !== 0) throw new Error(`on failed: ${res.stderr}`);
}
