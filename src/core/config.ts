import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const REPO_CONFIG_FILENAME = '.devin-autogit.json';

export const policyConfigSchema = z
  .object({
    protectedBranches: z.array(z.string()).default(['main', 'master']),
    denyPaths: z
      .array(z.string())
      .default(['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa', '**/id_ed25519']),
    /** Alias for denyPaths; merged into denyPaths at resolve time. */
    denyGlobs: z.array(z.string()).optional(),
    allowPaths: z.array(z.string()).default([]),
    maxFiles: z.number().int().positive().default(300),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    llmGate: z
      .object({
        enabled: z.boolean().default(false),
        apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
        model: z.string().default('openai/gpt-4o-mini'),
        timeoutMs: z.number().int().positive().default(15000),
      })
      .default({}),
  })
  .strict();

export const repoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    publicOk: z.boolean().default(false),
    policy: policyConfigSchema.default({}),
  })
  .strict();

export const globalConfigSchema = z
  .object({
    defaultBranchPrefix: z.string().default('devin/'),
    policy: policyConfigSchema.default({}),
  })
  .strict();

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export interface EffectiveConfig {
  enabled: boolean;
  publicOk: boolean;
  branchPrefix: string;
  policy: PolicyConfig;
  repoConfigPath: string | null;
}

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['DEVIN_AUTOGIT_HOME'] ?? join(homedir(), '.devin-autogit');
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'config.json');
}

export class ConfigError extends Error {}

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`invalid JSON in ${path}`);
  }
}

export function loadRepoConfig(repoRoot: string): RepoConfig | null {
  const path = join(repoRoot, REPO_CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  const parsed = repoConfigSchema.safeParse(readJsonFile(path));
  if (!parsed.success) {
    throw new ConfigError(`invalid ${REPO_CONFIG_FILENAME}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const path = globalConfigPath(env);
  if (!existsSync(path)) return globalConfigSchema.parse({});
  const parsed = globalConfigSchema.safeParse(readJsonFile(path));
  if (!parsed.success) {
    throw new ConfigError(`invalid global config ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseIntEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseListEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Precedence: env > repo > global > defaults. */
export function resolveConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  const globalCfg = loadGlobalConfig(env);
  const repoCfg = loadRepoConfig(repoRoot);

  const basePolicy = policyConfigSchema.parse({});
  const policy: PolicyConfig = {
    ...basePolicy,
    ...globalCfg.policy,
    ...(repoCfg?.policy ?? {}),
  };

  if (policy.denyGlobs) {
    policy.denyPaths = [...new Set([...policy.denyPaths, ...policy.denyGlobs])];
  }

  const envProtected = parseListEnv(env['DEVIN_AUTOGIT_PROTECTED_BRANCHES']);
  if (envProtected) policy.protectedBranches = envProtected;
  const envMaxFiles = parseIntEnv(env['DEVIN_AUTOGIT_MAX_FILES']);
  if (envMaxFiles !== undefined) policy.maxFiles = envMaxFiles;
  const envMaxBytes = parseIntEnv(env['DEVIN_AUTOGIT_MAX_BYTES']);
  if (envMaxBytes !== undefined) policy.maxBytes = envMaxBytes;

  let enabled = repoCfg?.enabled ?? false;
  if (env['DEVIN_AUTOGIT_ENABLED'] === '0') enabled = false;
  if (env['DEVIN_AUTOGIT_ENABLED'] === '1' && repoCfg !== null) enabled = true;

  return {
    enabled,
    publicOk: repoCfg?.publicOk ?? false,
    branchPrefix: env['DEVIN_AUTOGIT_BRANCH_PREFIX'] ?? globalCfg.defaultBranchPrefix,
    policy,
    repoConfigPath: repoCfg ? join(repoRoot, REPO_CONFIG_FILENAME) : null,
  };
}
