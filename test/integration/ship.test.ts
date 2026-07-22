import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, enable, git, makeFixture, type Fixture } from './helpers.js';

let fix: Fixture;

afterEach(() => {
  rmSync(fix.root, { recursive: true, force: true });
});

describe('ship (integration)', () => {
  it('happy path: stages, commits with trailers, and pushes', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');

    const result = cliJson(fix, ['ship', '-m', 'Add feature']);
    expect(result['shipped']).toBe(true);
    expect(result['pushed']).toBe(true);
    expect(result['subject']).toBe('Add feature');

    const log = git(fix, ['log', '-1', '--format=%B']);
    expect(log.stdout).toContain('Add feature');
    expect(log.stdout).toContain('Devin-Session: devin-test-session');
    expect(log.stdout).toContain('Shipped-by: devin-autogit');

    const remote = git(fix, ['ls-remote', 'origin', 'refs/heads/devin/test/work']);
    const local = git(fix, ['rev-parse', 'HEAD']);
    expect(remote.stdout).toContain(local.stdout.trim());
  });

  it('does not commit the autogit config or hooks file', () => {
    fix = makeFixture({ devin: true });
    cli(fix, ['on', '--public-ok', '--with-hooks']);
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');

    const result = cliJson(fix, ['ship', '-m', 'Add feature']);
    expect(result['shipped']).toBe(true);
    expect(result['files']).toEqual(['feature.ts']);

    const tree = git(fix, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tree.stdout).not.toContain('.devin-autogit.json');
    expect(tree.stdout).not.toContain('hooks.v1.json');
  });

  it('unstages config/hooks files even without exclude entries (pre-fix repos)', () => {
    fix = makeFixture({ devin: true });
    cli(fix, ['on', '--public-ok', '--with-hooks']);
    rmSync(join(fix.repo, '.git', 'info', 'exclude'), { force: true });
    writeFileSync(join(fix.repo, 'feature.ts'), 'export const x = 1;\n');

    const result = cliJson(fix, ['ship', '-m', 'Add feature']);
    expect(result['shipped']).toBe(true);
    expect(result['files']).toEqual(['feature.ts']);

    const tree = git(fix, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tree.stdout).not.toContain('.devin-autogit.json');
    expect(tree.stdout).not.toContain('hooks.v1.json');
  });

  it('is a clean no-op when not enabled', () => {
    fix = makeFixture();
    writeFileSync(join(fix.repo, 'x.ts'), 'export {};\n');
    const result = cliJson(fix, ['ship']);
    expect(result['shipped']).toBe(false);
    expect(result['reason']).toBe('not-enabled');
  });

  it('holds on a secrets hit without discarding changes', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(
      join(fix.repo, 'leak.ts'),
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    );
    const result = cliJson(fix, ['ship']);
    expect(result['shipped']).toBe(false);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'secrets')).toBe(true);

    const status = git(fix, ['status', '--porcelain']);
    expect(status.stdout).toContain('leak.ts');
    const log = git(fix, ['log', '--oneline']);
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('holds on protected branches', () => {
    fix = makeFixture({ devin: true, branch: 'main' });
    enable(fix);
    writeFileSync(join(fix.repo, 'x.ts'), 'export {};\n');
    const result = cliJson(fix, ['ship']);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'branch')).toBe(true);
  });

  it('holds when the branch does not match blueprint branch_prefix', () => {
    fix = makeFixture({ devin: true, branch: 'devin/test' });
    enable(fix);
    mkdirSync(join(fix.repo, '.devin'));
    writeFileSync(
      join(fix.repo, '.devin/blueprint.yaml'),
      'conventions:\n  branch_prefix: demo/\n',
    );
    writeFileSync(join(fix.repo, 'x.ts'), 'export {};\n');
    const result = cliJson(fix, ['ship']);
    expect(result['held']).toBe(true);
    expect(result['result']).toBe('held');
    expect(result['reason']).toBe('branch-prefix');
    const holds = result['holds'] as Array<{ gate: string; reason: string }>;
    expect(holds[0]?.reason).toContain('does not match allowed prefix "demo/"');
  });

  it('holds on the size cap', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    fix.env['DEVIN_AUTOGIT_MAX_FILES'] = '2';
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(fix.repo, `f${i}.ts`), 'export {};\n');
    }
    const result = cliJson(fix, ['ship']);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'size')).toBe(true);
  });

  it('holds a Stripe live key in a source file', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    // Assembled at runtime so no key-shaped literal lands in the repo.
    const key = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
    writeFileSync(join(fix.repo, 'payments.ts'), `const stripeKey = "${key}";\n`);
    const result = cliJson(fix, ['ship']);
    expect(result['shipped']).toBe(false);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'secrets')).toBe(true);
  });

  it('holds on the byte cap for a large text file', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'big.txt'), 'x'.repeat(1_100_000) + '\n');
    const result = cliJson(fix, ['ship']);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'size')).toBe(true);
  });

  it('holds on the byte cap for a large binary file', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(join(fix.repo, 'big.bin'), Buffer.alloc(1_100_000, 0));
    const result = cliJson(fix, ['ship']);
    expect(result['held']).toBe(true);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'size')).toBe(true);
  });

  it('refuses --force-secrets in autonomous (Devin, non-TTY) mode', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    writeFileSync(
      join(fix.repo, 'leak.ts'),
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    );
    const result = cliJson(fix, ['ship', '--force-secrets']);
    expect(result['shipped']).toBe(false);
    const holds = result['holds'] as Array<{ gate: string }>;
    expect(holds.some((h) => h.gate === 'force-secrets')).toBe(true);
  });

  it('hold exits 0 (never breaks an agent turn)', () => {
    fix = makeFixture({ devin: true, branch: 'main' });
    enable(fix);
    writeFileSync(join(fix.repo, 'x.ts'), 'export {};\n');
    const res = cli(fix, ['ship']);
    expect(res.code).toBe(0);
  });

  it('recovers from non-fast-forward with fetch + rebase + retry', () => {
    fix = makeFixture({ devin: true });
    enable(fix);

    const other = join(fix.root, 'other');
    git(fix, ['clone', fix.origin, other], fix.root);
    git(fix, ['checkout', 'devin/test/work'], other);
    writeFileSync(join(other, 'other.ts'), 'export const other = 1;\n');
    git(fix, ['add', '-A'], other);
    git(fix, ['commit', '-m', 'other agent commit'], other);
    git(fix, ['push', 'origin', 'devin/test/work'], other);

    writeFileSync(join(fix.repo, 'mine.ts'), 'export const mine = 1;\n');
    const result = cliJson(fix, ['ship', '-m', 'My change']);
    expect(result['shipped']).toBe(true);
    expect(result['pushed']).toBe(true);
    expect(result['rebased']).toBe(true);

    const log = git(fix, ['log', '--format=%s']);
    expect(log.stdout).toContain('My change');
    expect(log.stdout).toContain('other agent commit');
  });
});
