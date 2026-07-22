import { join } from 'node:path';
import { Git, hasShippedByTrailer } from '../core/git.js';

export function subagentBranch(sessionId: string, agentIndex: number): string {
  return `devin/${sessionId}/agent-${agentIndex}`;
}

export function swarmBranchPattern(sessionId: string): RegExp {
  return new RegExp(`^devin/${escapeRegExp(sessionId)}/agent-\\d+$`);
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
  sessionId: string,
  agents: number,
): SwarmInitResult {
  const result: SwarmInitResult = { branches: [], worktrees: [], errors: [] };
  const base = git.headSha();
  if (base === null) {
    result.errors.push('cannot resolve HEAD — is there at least one commit?');
    return result;
  }
  for (let i = 1; i <= agents; i++) {
    const branch = subagentBranch(sessionId, i);
    const worktreePath = join(repoRoot, '..', `${sessionId}-agent-${i}`);
    const res = git.exec(['worktree', 'add', '-b', branch, worktreePath, base]);
    if (res.ok) {
      result.branches.push(branch);
      result.worktrees.push(worktreePath);
    } else {
      result.errors.push(`agent-${i}: ${res.stderr.trim()}`);
    }
  }
  return result;
}

export interface SwarmCollectResult {
  merged: string[];
  skipped: Array<{ branch: string; reason: string }>;
  conflicts: string[];
  integrationBranch: string;
}

export function listSwarmBranches(git: Git, sessionId: string): string[] {
  const res = git.exec(['for-each-ref', '--format=%(refname:short)', 'refs/heads/devin/']);
  if (!res.ok) return [];
  const pattern = swarmBranchPattern(sessionId);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => pattern.test(b));
}

/**
 * Merge completed subagent branches into an integration branch. Fail-closed:
 * a conflicting merge is aborted and reported, never left half-done.
 */
export function swarmCollect(git: Git, sessionId: string, into: string): SwarmCollectResult {
  const result: SwarmCollectResult = {
    merged: [],
    skipped: [],
    conflicts: [],
    integrationBranch: into,
  };
  const branches = listSwarmBranches(git, sessionId);

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
