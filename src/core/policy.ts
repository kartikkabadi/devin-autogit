import { minimatch } from 'minimatch';
import type { PolicyConfig } from './config.js';
import { isTemplatePath, type SecretFinding } from './secrets.js';

export interface PolicyInput {
  branch: string | null;
  stagedFiles: string[];
  diffBytes: number;
  secretFindings: SecretFinding[];
  autonomous: boolean;
  forceSecrets: boolean;
  llmGateAvailable?: boolean;
}

export interface Hold {
  gate: 'branch' | 'path' | 'secrets' | 'size' | 'llm' | 'force-secrets';
  reason: string;
  details?: unknown;
}

export interface PolicyDecision {
  allowed: boolean;
  holds: Hold[];
}

/** Minimal glob matcher supporting `**`, `*`, and `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += (c as string).replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(path, g, { dot: true }));
}

/** Protected-branch patterns are matched as globs (e.g. `release/*`). */
export function isProtectedBranch(branch: string, patterns: string[]): boolean {
  return patterns.some((p) => branch === p || minimatch(branch, p, { dot: true }));
}

/**
 * Fail-closed gate engine: evaluates all gates and collects every hold so the
 * agent gets a complete picture. In autonomous mode every doubt is a hold.
 */
export function evaluatePolicy(input: PolicyInput, policy: PolicyConfig): PolicyDecision {
  const holds: Hold[] = [];

  if (input.forceSecrets && input.autonomous) {
    holds.push({
      gate: 'force-secrets',
      reason: '--force-secrets is refused in autonomous mode; a human TTY is required',
    });
  }

  if (input.branch !== null && isProtectedBranch(input.branch, policy.protectedBranches)) {
    holds.push({
      gate: 'branch',
      reason: `branch "${input.branch}" is protected`,
      details: { branch: input.branch, protectedBranches: policy.protectedBranches },
    });
  } else if (input.branch === null) {
    holds.push({ gate: 'branch', reason: 'detached HEAD — cannot determine branch' });
  }

  const deniedFiles = input.stagedFiles.filter(
    (f) => matchesAnyGlob(f, policy.denyPaths) && !isTemplatePath(f),
  );
  const allowFiltered =
    policy.allowPaths.length > 0
      ? input.stagedFiles.filter((f) => !matchesAnyGlob(f, policy.allowPaths))
      : [];
  const blockedFiles = [...new Set([...deniedFiles, ...allowFiltered])];
  if (blockedFiles.length > 0) {
    holds.push({
      gate: 'path',
      reason: `staged paths violate path policy: ${blockedFiles.slice(0, 5).join(', ')}`,
      details: { files: blockedFiles },
    });
  }

  if (input.secretFindings.length > 0 && !(input.forceSecrets && !input.autonomous)) {
    holds.push({
      gate: 'secrets',
      reason: `secrets scan found ${input.secretFindings.length} potential secret(s)`,
      details: { findings: input.secretFindings },
    });
  }

  if (input.stagedFiles.length > policy.maxFiles) {
    holds.push({
      gate: 'size',
      reason: `staged file count ${input.stagedFiles.length} exceeds cap ${policy.maxFiles}`,
    });
  }
  if (input.diffBytes > policy.maxBytes) {
    holds.push({
      gate: 'size',
      reason: `staged diff size ${input.diffBytes} bytes exceeds cap ${policy.maxBytes}`,
    });
  }

  if (policy.llmGate.enabled && input.llmGateAvailable !== true) {
    holds.push({
      gate: 'llm',
      reason: 'LLM gate is enabled but unavailable — failing closed',
    });
  }

  return { allowed: holds.length === 0, holds };
}
