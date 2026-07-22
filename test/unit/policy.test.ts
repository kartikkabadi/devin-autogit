import { describe, expect, it } from 'vitest';
import { policyConfigSchema } from '../../src/core/config.js';
import {
  evaluatePolicy,
  globToRegExp,
  matchesAnyGlob,
  matchesBranchPrefix,
} from '../../src/core/policy.js';
import type { PolicyInput } from '../../src/core/policy.js';

const policy = policyConfigSchema.parse({});

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    branch: 'devin/session-1/agent-1',
    stagedFiles: ['src/a.ts'],
    diffBytes: 100,
    secretFindings: [],
    autonomous: true,
    forceSecrets: false,
    ...overrides,
  };
}

describe('glob matching', () => {
  it('supports **, *, and ?', () => {
    expect(globToRegExp('**/.env').test('.env')).toBe(true);
    expect(globToRegExp('**/.env').test('config/.env')).toBe(true);
    expect(globToRegExp('**/*.pem').test('certs/server.pem')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/a.ts')).toBe(false);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(matchesAnyGlob('infra/main.tf', ['infra/**'])).toBe(true);
  });
});

describe('policy engine', () => {
  it('allows a clean ship on an unprotected branch', () => {
    const decision = evaluatePolicy(input(), policy);
    expect(decision.allowed).toBe(true);
    expect(decision.holds).toEqual([]);
  });

  it('holds on protected branches', () => {
    const decision = evaluatePolicy(input({ branch: 'main' }), policy);
    expect(decision.allowed).toBe(false);
    expect(decision.holds[0]?.gate).toBe('branch');
  });

  it('holds in autonomous mode when the branch does not match branch_prefix', () => {
    const decision = evaluatePolicy(input({ branch: 'devin/test', branchPrefix: 'demo/' }), policy);
    expect(decision.allowed).toBe(false);
    const hold = decision.holds.find((h) => h.gate === 'branch-prefix');
    expect(hold?.reason).toBe('branch "devin/test" does not match allowed prefix "demo/"');
  });

  it('allows a branch matching branch_prefix (literal and glob)', () => {
    expect(
      evaluatePolicy(input({ branch: 'demo/x', branchPrefix: 'demo/' }), policy).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(input({ branch: 'demo/x', branchPrefix: 'demo/*' }), policy).allowed,
    ).toBe(true);
    expect(matchesBranchPrefix('demo/a/b', 'demo/')).toBe(true);
    expect(matchesBranchPrefix('devin/test', 'demo/')).toBe(false);
  });

  it('skips the branch-prefix gate when the prefix is missing or empty', () => {
    expect(evaluatePolicy(input({ branchPrefix: null }), policy).allowed).toBe(true);
    expect(evaluatePolicy(input({ branchPrefix: '' }), policy).allowed).toBe(true);
  });

  it('skips the branch-prefix gate in interactive mode', () => {
    const decision = evaluatePolicy(
      input({ branch: 'devin/test', branchPrefix: 'demo/', autonomous: false }),
      policy,
    );
    expect(decision.holds.some((h) => h.gate === 'branch-prefix')).toBe(false);
  });

  it('holds on detached HEAD', () => {
    const decision = evaluatePolicy(input({ branch: null }), policy);
    expect(decision.holds.some((h) => h.gate === 'branch')).toBe(true);
  });

  it('holds on denied paths', () => {
    const decision = evaluatePolicy(input({ stagedFiles: ['src/a.ts', 'certs/key.pem'] }), policy);
    expect(decision.holds.some((h) => h.gate === 'path')).toBe(true);
  });

  it('holds on secret findings', () => {
    const decision = evaluatePolicy(
      input({ secretFindings: [{ file: 'a.ts', kind: 'jwt', match: 'eyJ...' }] }),
      policy,
    );
    expect(decision.holds.some((h) => h.gate === 'secrets')).toBe(true);
  });

  it('refuses --force-secrets in autonomous mode', () => {
    const decision = evaluatePolicy(
      input({
        forceSecrets: true,
        autonomous: true,
        secretFindings: [{ file: 'a.ts', kind: 'jwt', match: 'eyJ...' }],
      }),
      policy,
    );
    expect(decision.holds.some((h) => h.gate === 'force-secrets')).toBe(true);
    expect(decision.holds.some((h) => h.gate === 'secrets')).toBe(true);
  });

  it('honors --force-secrets in interactive mode', () => {
    const decision = evaluatePolicy(
      input({
        forceSecrets: true,
        autonomous: false,
        secretFindings: [{ file: 'a.ts', kind: 'jwt', match: 'eyJ...' }],
      }),
      policy,
    );
    expect(decision.holds.some((h) => h.gate === 'secrets')).toBe(false);
    expect(decision.holds.some((h) => h.gate === 'force-secrets')).toBe(false);
  });

  it('holds on file-count and byte-size caps', () => {
    const manyFiles = Array.from({ length: 301 }, (_, i) => `src/f${i}.ts`);
    expect(
      evaluatePolicy(input({ stagedFiles: manyFiles }), policy).holds.some(
        (h) => h.gate === 'size',
      ),
    ).toBe(true);
    expect(
      evaluatePolicy(input({ diffBytes: 2 * 1024 * 1024 }), policy).holds.some(
        (h) => h.gate === 'size',
      ),
    ).toBe(true);
  });

  it('fails closed when the LLM gate is enabled but unavailable', () => {
    const gated = policyConfigSchema.parse({ llmGate: { enabled: true } });
    const decision = evaluatePolicy(input({ llmGateAvailable: undefined }), gated);
    expect(decision.holds.some((h) => h.gate === 'llm')).toBe(true);
    const available = evaluatePolicy(input({ llmGateAvailable: true }), gated);
    expect(available.holds.some((h) => h.gate === 'llm')).toBe(false);
  });
});
