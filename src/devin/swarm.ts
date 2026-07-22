import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Git, hasShippedByTrailer, isSafeGitArg } from '../core/git.js';
import { REPO_CONFIG_FILENAME, repoConfigSchema } from '../core/config.js';

const SWARM_BASE_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidSwarmBase(base: string): boolean {
  return isSafeGitArg(base) && SWARM_BASE_PATTERN.test(base);
}

/** Busy-marker dir under the checkout's own git dir, so worktrees never block each other. */
export function busyMarkerDir(git: Git): string | null {
  const res = git.exec(['rev-parse', '--absolute-git-dir']);
  return res.ok ? join(res.stdout.trim(), 'devin-autogit-busy') : null;
}

export function subagentBranch(base: string, agentIndex: number): string {
  return `devin/${base}/agent-${agentIndex}`;
}

export function swarmBranchPattern(base: string): RegExp {
  return new RegExp(`^devin/${escapeRegExp(base)}/agent-\\d+$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SwarmInitResult {
  branches: string[];
  worktrees: string[];
  errors: string[];
}

export function swarmInit(
  git: Git,
  repoRoot: string,
  base: string,
  agents: number,
): SwarmInitResult {
  const result: SwarmInitResult = { branches: [], worktrees: [], errors: [] };
  if (!isValidSwarmBase(base)) {
    result.errors.push(`invalid swarm base "${base}" — must match ${SWARM_BASE_PATTERN}`);
    return result;
  }
  const baseSha = git.headSha();
  if (baseSha === null) {
    result.errors.push('cannot resolve HEAD — is there at least one commit?');
    return result;
  }
  const parentConfigPath = join(repoRoot, REPO_CONFIG_FILENAME);
  for (let i = 1; i <= agents; i++) {
    const branch = subagentBranch(base, i);
    if (!git.isValidBranchName(branch)) {
      result.errors.push(`agent-${i}: invalid branch name "${branch}"`);
      continue;
    }
    const worktreePath = join(repoRoot, '..', `${base}-agent-${i}`);
    const res = git.exec(['worktree', 'add', '-b', branch, worktreePath, baseSha]);
    if (res.ok) {
      result.branches.push(branch);
      result.worktrees.push(worktreePath);
      enableWorktree(worktreePath, parentConfigPath, result);
    } else {
      result.errors.push(`agent-${i}: ${res.stderr.trim()}`);
    }
  }
  return result;
}

/** Pre-enable a worktree: copy/create its own repo config and isolate its busy markers. */
function enableWorktree(
  worktreePath: string,
  parentConfigPath: string,
  result: SwarmInitResult,
): void {
  const configPath = join(worktreePath, REPO_CONFIG_FILENAME);
  try {
    if (existsSync(parentConfigPath)) {
      copyFileSync(parentConfigPath, configPath);
    } else {
      const config = repoConfigSchema.parse({ enabled: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    }
  } catch (err) {
    result.errors.push(`cannot write ${configPath}: ${(err as Error).message}`);
    return;
  }
  const wtGit = new Git(worktreePath);
  const markerDir = busyMarkerDir(wtGit);
  if (markerDir !== null) {
    try {
      mkdirSync(markerDir, { recursive: true });
    } catch (err) {
      result.errors.push(`cannot create busy-marker dir ${markerDir}: ${(err as Error).message}`);
    }
  }
  excludeConfigFromTracking(wtGit, worktreePath);
}

/** Keep the per-worktree repo config local-only via <common-git-dir>/info/exclude. */
function excludeConfigFromTracking(wtGit: Git, worktreePath: string): void {
  const common = wtGit.gitDir();
  if (common === null) return;
  const infoDir = resolve(worktreePath, common, 'info');
  const excludePath = join(infoDir, 'exclude');
  try {
    mkdirSync(infoDir, { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (!current.split('\n').includes(REPO_CONFIG_FILENAME)) {
      const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      appendFileSync(excludePath, `${prefix}${REPO_CONFIG_FILENAME}\n`);
    }
  } catch {
    // best-effort: tracking the config is safe, just noisier
  }
}

export interface SwarmCollectResult {
  merged: string[];
  skipped: Array<{ branch: string; reason: string }>;
  conflicts: string[];
  integrationBranch: string;
}

export function listSwarmBranches(git: Git, base: string): string[] {
  const res = git.exec(['for-each-ref', '--format=%(refname:short)', 'refs/heads/devin/']);
  if (!res.ok) return [];
  const pattern = swarmBranchPattern(base);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => pattern.test(b));
}

/**
 * Merge completed subagent branches into an integration branch. Fail-closed:
 * a conflicting merge is aborted and reported, never left half-done.
 */
export function swarmCollect(git: Git, base: string, into: string): SwarmCollectResult {
  const result: SwarmCollectResult = {
    merged: [],
    skipped: [],
    conflicts: [],
    integrationBranch: into,
  };
  const branches = listSwarmBranches(git, base);

  if (!isSafeGitArg(into) || !git.isValidBranchName(into)) {
    result.skipped.push({ branch: into, reason: `invalid integration branch name "${into}"` });
    return result;
  }
  const checkout = git.exec(['rev-parse', '--verify', into]).ok
    ? git.exec(['checkout', into])
    : git.exec(['checkout', '-b', into]);
  if (!checkout.ok) {
    result.skipped.push({ branch: into, reason: `cannot checkout: ${checkout.stderr.trim()}` });
    return result;
  }

  for (const branch of branches) {
    const tipMessage = git.commitMessage(branch);
    if (tipMessage === null || !hasShippedByTrailer(tipMessage)) {
      result.skipped.push({
        branch,
        reason: 'tip commit has no Shipped-by: devin-autogit trailer',
      });
      continue;
    }
    const merge = git.exec(['merge', '--no-ff', '--no-edit', branch]);
    if (merge.ok) {
      result.merged.push(branch);
    } else {
      git.exec(['merge', '--abort']);
      result.conflicts.push(branch);
    }
  }
  return result;
}
