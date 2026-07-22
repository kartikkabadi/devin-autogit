import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, enable, git, makeFixture, type Fixture } from './helpers.js';

let fix: Fixture;

afterEach(() => {
  rmSync(fix.root, { recursive: true, force: true });
});

describe('swarm (integration)', () => {
  it('init creates per-subagent worktrees and branches', () => {
    fix = makeFixture({ devin: true });
    const result = cliJson(fix, ['swarm', 'init', 'Split the work', '--agents', '2']);
    expect(result['branches']).toEqual([
      'devin/devin-test-session/agent-1',
      'devin/devin-test-session/agent-2',
    ]);
    const worktrees = result['worktrees'] as string[];
    expect(worktrees).toHaveLength(2);
    for (const wt of worktrees) expect(existsSync(wt)).toBe(true);
  });

  it('collect merges shipped subagent branches into an integration branch', () => {
    fix = makeFixture({ devin: true });
    enable(fix);
    const init = cliJson(fix, ['swarm', 'init', 'Split the work', '--agents', '2']);
    const worktrees = init['worktrees'] as string[];

    // agent-1 ships via devin-autogit (gets the trailer)
    writeFileSync(join(worktrees[0] as string, 'agent1.ts'), 'export const a1 = 1;\n');
    git(fix, ['add', '-A'], worktrees[0]);
    git(fix, ['commit', '-m', 'agent 1 work\n\nShipped-by: devin-autogit'], worktrees[0]);

    // agent-2 commits without the trailer (not shipped) — must be skipped
    writeFileSync(join(worktrees[1] as string, 'agent2.ts'), 'export const a2 = 1;\n');
    git(fix, ['add', '-A'], worktrees[1]);
    git(fix, ['commit', '-m', 'agent 2 unfinished'], worktrees[1]);

    const result = cliJson(fix, ['swarm', 'collect', '--into', 'devin/integration']);
    expect(result['merged']).toEqual(['devin/devin-test-session/agent-1']);
    const skipped = result['skipped'] as Array<{ branch: string }>;
    expect(skipped.map((s) => s.branch)).toContain('devin/devin-test-session/agent-2');

    git(fix, ['checkout', 'devin/integration']);
    expect(existsSync(join(fix.repo, 'agent1.ts'))).toBe(true);
    expect(existsSync(join(fix.repo, 'agent2.ts'))).toBe(false);
  });

  it('collect fails closed on merge conflicts', () => {
    fix = makeFixture({ devin: true });
    const init = cliJson(fix, ['swarm', 'init', 'Conflicting work', '--agents', '2']);
    const worktrees = init['worktrees'] as string[];

    for (const [i, wt] of worktrees.entries()) {
      writeFileSync(join(wt, 'README.md'), `# agent ${i} version\n`);
      git(fix, ['add', '-A'], wt);
      git(fix, ['commit', '-m', `agent ${i}\n\nShipped-by: devin-autogit`], wt);
    }

    const result = cliJson(fix, ['swarm', 'collect', '--into', 'devin/integration']);
    expect(result['merged']).toEqual(['devin/devin-test-session/agent-1']);
    expect(result['conflicts']).toEqual(['devin/devin-test-session/agent-2']);
    // merge was aborted — no conflict markers left behind
    const status = git(fix, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
  });

  it('init requires a session id', () => {
    fix = makeFixture();
    const res = cli(fix, ['swarm', 'init', 'No session']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('session');
  });
});
