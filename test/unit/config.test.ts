import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  REPO_CONFIG_FILENAME,
  loadRepoConfig,
  policyConfigSchema,
  resolveConfig,
} from '../../src/core/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devin-autogit-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { DEVIN_AUTOGIT_HOME: join(dir, 'no-global'), ...overrides };
}

describe('config', () => {
  it('applies defaults when no config files exist', () => {
    const cfg = resolveConfig(dir, env());
    expect(cfg.enabled).toBe(false);
    expect(cfg.policy.protectedBranches).toEqual(['main', 'master']);
    expect(cfg.policy.maxFiles).toBe(300);
    expect(cfg.policy.maxBytes).toBe(1024 * 1024);
  });

  it('repo config overrides defaults', () => {
    writeFileSync(
      join(dir, REPO_CONFIG_FILENAME),
      JSON.stringify({ enabled: true, policy: { maxFiles: 10 } }),
    );
    const cfg = resolveConfig(dir, env());
    expect(cfg.enabled).toBe(true);
    expect(cfg.policy.maxFiles).toBe(10);
  });

  it('global config is overridden by repo config', () => {
    const globalDir = join(dir, 'global');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({ policy: { maxFiles: 5, maxBytes: 999 } }),
    );
    writeFileSync(
      join(dir, REPO_CONFIG_FILENAME),
      JSON.stringify({ enabled: true, policy: { maxFiles: 50 } }),
    );
    const cfg = resolveConfig(dir, { DEVIN_AUTOGIT_HOME: globalDir });
    expect(cfg.policy.maxFiles).toBe(50);
  });

  it('env overrides repo and global config', () => {
    writeFileSync(
      join(dir, REPO_CONFIG_FILENAME),
      JSON.stringify({ enabled: true, policy: { maxFiles: 50 } }),
    );
    const cfg = resolveConfig(
      dir,
      env({
        DEVIN_AUTOGIT_MAX_FILES: '7',
        DEVIN_AUTOGIT_PROTECTED_BRANCHES: 'main,release',
        DEVIN_AUTOGIT_ENABLED: '0',
      }),
    );
    expect(cfg.policy.maxFiles).toBe(7);
    expect(cfg.policy.protectedBranches).toEqual(['main', 'release']);
    expect(cfg.enabled).toBe(false);
  });

  it('returns null repo config when file is absent', () => {
    expect(loadRepoConfig(dir)).toBeNull();
  });

  it('throws ConfigError on invalid JSON', () => {
    writeFileSync(join(dir, REPO_CONFIG_FILENAME), '{not json');
    expect(() => loadRepoConfig(dir)).toThrow(ConfigError);
  });

  it('throws ConfigError on schema violations', () => {
    writeFileSync(join(dir, REPO_CONFIG_FILENAME), JSON.stringify({ enabled: 'yes' }));
    expect(() => loadRepoConfig(dir)).toThrow(ConfigError);
  });

  it('policy schema fills defaults', () => {
    const policy = policyConfigSchema.parse({});
    expect(policy.denyPaths).toContain('**/.env');
    expect(policy.llmGate.enabled).toBe(false);
  });
});
