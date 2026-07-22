import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, makeFixture, run, type Fixture } from './helpers.js';

let fix: Fixture;

afterEach(() => {
  rmSync(fix.root, { recursive: true, force: true });
});

describe('status (integration)', () => {
  it('outside a git repository exits 0 with a disabled JSON result', () => {
    fix = makeFixture();
    const outside = mkdtempSync(join(tmpdir(), 'devin-autogit-outside-'));
    try {
      const res = cli(fix, ['--json', 'status'], outside);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('not inside a git repository');
      const result = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
      expect(result['ok']).toBe(true);
      expect(result['enabled']).toBe(false);
      expect(result['devinDetected']).toBe(false);
      expect(result['repo']).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('in a bare repository reports that a work tree is required', () => {
    fix = makeFixture();
    const bare = join(fix.root, 'bare.git');
    mkdirSync(bare);
    run('git', ['init', '--bare', bare], fix.root, fix.env);

    const status = cli(fix, ['status'], bare);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain('work tree required');

    const ship = cli(fix, ['ship'], bare);
    expect(ship.code).toBe(1);
    expect(ship.stderr).toContain('work tree required');
  });
});
