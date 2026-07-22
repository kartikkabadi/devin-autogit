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

  it('refuses to undo a foreign commit', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'manual.ts'), 'export {};\n');
    git(fix, ['add', '-A']);
    git(fix, ['commit', '-m', 'manual commit']);
    const res = cli(fix, ['undo']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('refusing');
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
