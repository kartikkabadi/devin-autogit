import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, enable, git, makeFixture, type Fixture } from './helpers.js';

let fix: Fixture;

afterEach(() => {
  rmSync(fix.root, { recursive: true, force: true });
});

describe('undo (integration)', () => {
  it('rewinds the last devin-autogit commit locally and remotely', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    const before = git(fix, ['rev-parse', 'HEAD']).stdout.trim();
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');
    cliJson(fix, ['ship', '-m', 'Add feature']);

    const result = cliJson(fix, ['undo']);
    expect(result['ok']).toBe(true);
    expect(git(fix, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
    const remote = git(fix, ['ls-remote', 'origin', 'refs/heads/devin/test/work']);
    expect(remote.stdout).toContain(before);
    // changes preserved in the working tree
    expect(git(fix, ['status', '--porcelain']).stdout).toContain('feature.ts');
  });

  it('is a noop on a second undo (nothing left to undo)', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');
    cliJson(fix, ['ship', '-m', 'Add feature']);

    expect(cli(fix, ['undo']).code).toBe(0);
    const second = cli(fix, ['--json', 'undo']);
    expect(second.code).toBe(0);
    const json = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    expect(json['result']).toBe('noop');
    expect(json['reason']).toBe('nothing-to-undo');
  });

  it('is a noop when there are no commits at all', () => {
    fix = makeFixture({ devin: true });
    const empty = join(fix.root, 'empty');
    git(fix, ['init', empty], fix.root);
    const res = cli(fix, ['--json', 'undo'], empty);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(json['result']).toBe('noop');
    expect(json['reason']).toBe('nothing-to-undo');
  });

  it('refuses to undo a foreign commit', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'manual.ts'), 'export {};\n');
    git(fix, ['add', '-A']);
    git(fix, ['commit', '-m', 'manual commit']);
    const res = cli(fix, ['--json', 'undo']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('refusing');
    const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(json['result']).toBe('refused');
    expect(json['reason']).toBe('foreign-commit');
  });

  it('refuses when the remote has moved past the shipped commit', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');
    cliJson(fix, ['ship', '-m', 'Add feature']);

    const other = join(fix.root, 'other');
    git(fix, ['clone', fix.origin, other], fix.root);
    git(fix, ['checkout', 'devin/test/work'], other);
    writeFileSync(join(other, 'later.ts'), 'export {};\n');
    git(fix, ['add', '-A'], other);
    git(fix, ['commit', '-m', 'later commit'], other);
    git(fix, ['push', 'origin', 'devin/test/work'], other);

    const res = cli(fix, ['undo']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('moved past');
  });
});
