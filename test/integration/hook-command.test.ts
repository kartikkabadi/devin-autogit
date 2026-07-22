import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, cliJson, makeFixture, CLI } from './helpers.js';

const HOOKS_REL = join('.devin', 'hooks.v1.json');

function readHooks(repo: string): Record<string, unknown[]> {
  return JSON.parse(readFileSync(join(repo, HOOKS_REL), 'utf8')) as Record<string, unknown[]>;
}

describe('hook install / uninstall', () => {
  it('installs Stop and SessionEnd hooks into .devin/hooks.v1.json', () => {
    const fix = makeFixture();
    const res = cliJson(fix, ['hook', 'install', '--bin', `node ${CLI}`]);
    expect(res['ok']).toBe(true);
    expect(res['installed']).toEqual(['Stop', 'SessionEnd']);

    const hooks = readHooks(fix.repo);
    expect(hooks['Stop']).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: `node ${CLI} ship --quiet --json`, timeout: 120 }],
      },
    ]);
    expect(hooks['SessionEnd']).toBeDefined();
  });

  it('is idempotent', () => {
    const fix = makeFixture();
    cli(fix, ['hook', 'install', '--bin', `node ${CLI}`]);
    const before = readFileSync(join(fix.repo, HOOKS_REL), 'utf8');
    const res = cliJson(fix, ['hook', 'install', '--bin', `node ${CLI}`]);
    expect(res['installed']).toEqual([]);
    expect(readFileSync(join(fix.repo, HOOKS_REL), 'utf8')).toBe(before);
  });

  it('uninstall removes our entries and deletes an empty file', () => {
    const fix = makeFixture();
    cli(fix, ['hook', 'install', '--bin', `node ${CLI}`]);
    const res = cliJson(fix, ['hook', 'uninstall']);
    expect(res['ok']).toBe(true);
    expect(res['deleted']).toBe(true);
    expect(existsSync(join(fix.repo, HOOKS_REL))).toBe(false);
  });

  it('uninstall preserves user hooks', () => {
    const fix = makeFixture();
    cli(fix, ['hook', 'install', '--bin', `node ${CLI}`]);
    const hooks = readHooks(fix.repo);
    hooks['PostToolUse'] = [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }];
    writeFileSync(join(fix.repo, HOOKS_REL), JSON.stringify(hooks, null, 2) + '\n');

    const res = cliJson(fix, ['hook', 'uninstall']);
    expect(res['deleted']).toBe(false);
    expect(readHooks(fix.repo)).toEqual({
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }],
    });
  });

  it('uninstall is a no-op without a hooks file', () => {
    const fix = makeFixture();
    const res = cliJson(fix, ['hook', 'uninstall']);
    expect(res['ok']).toBe(true);
    expect(res['removed']).toEqual([]);
  });
});

describe('on --with-hooks / off', () => {
  it('on --with-hooks installs hooks and records hooks:true', () => {
    const fix = makeFixture();
    const res = cliJson(fix, ['on', '--public-ok', '--with-hooks']);
    expect(res['ok']).toBe(true);
    expect(res['hooks']).toBe(true);

    const config = JSON.parse(readFileSync(join(fix.repo, '.devin-autogit.json'), 'utf8')) as {
      hooks?: boolean;
    };
    expect(config.hooks).toBe(true);
    expect(existsSync(join(fix.repo, HOOKS_REL))).toBe(true);
  });

  it('off uninstalls hooks when hooks:true', () => {
    const fix = makeFixture();
    cli(fix, ['on', '--public-ok', '--with-hooks']);
    const res = cliJson(fix, ['off']);
    expect(res['ok']).toBe(true);
    expect(existsSync(join(fix.repo, HOOKS_REL))).toBe(false);
    expect(existsSync(join(fix.repo, '.devin-autogit.json'))).toBe(false);
  });

  it('off leaves user hooks alone', () => {
    const fix = makeFixture();
    cli(fix, ['on', '--public-ok', '--with-hooks']);
    const hooks = readHooks(fix.repo);
    hooks['PostToolUse'] = [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }];
    writeFileSync(join(fix.repo, HOOKS_REL), JSON.stringify(hooks, null, 2) + '\n');

    cli(fix, ['off']);
    expect(readHooks(fix.repo)).toEqual({
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }],
    });
  });
});
