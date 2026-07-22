import { Git } from '../core/git.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';
import { readDevinMetadata } from '../devin/metadata.js';
import { swarmCollect, swarmInit } from '../devin/swarm.js';

export interface SwarmInitOptions {
  json: boolean;
  dryRun: boolean;
  agents: number;
  session?: string;
}

function resolveSessionId(root: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const detection = detectDevinSession({ repoRoot: root });
  if (detection.sessionId) return detection.sessionId;
  const metadata = readDevinMetadata(root);
  return metadata.sessionId;
}

export function runSwarmInit(task: string, opts: SwarmInitOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  if (!git.isRepo()) {
    out.error('not inside a git repository');
    return EXIT_CONFIG_ERROR;
  }
  const root = git.repoRoot();
  if (root === null) {
    out.error('cannot resolve repository root');
    return EXIT_CONFIG_ERROR;
  }
  const sessionId = resolveSessionId(root, opts.session);
  if (sessionId === null) {
    out.error('no Devin session ID found — pass --session <id> or set DEVIN_SESSION_ID');
    return EXIT_CONFIG_ERROR;
  }

  if (opts.dryRun) {
    out.info(`dry-run: would create ${opts.agents} worktree(s) for session ${sessionId}`);
    out.result({ ok: true, action: 'swarm-init', dryRun: true, sessionId, agents: opts.agents });
    return EXIT_OK;
  }

  const result = swarmInit(git, root, sessionId, opts.agents);
  for (const wt of result.worktrees) out.info(`worktree: ${wt}`);
  for (const b of result.branches) out.info(`branch: ${b}`);
  for (const e of result.errors) out.warn(e);
  out.result({
    ok: result.errors.length === 0,
    action: 'swarm-init',
    task,
    sessionId,
    branches: result.branches,
    worktrees: result.worktrees,
    errors: result.errors,
  });
  return result.errors.length === 0 ? EXIT_OK : EXIT_CONFIG_ERROR;
}

export interface SwarmCollectOptions {
  json: boolean;
  dryRun: boolean;
  into?: string;
  session?: string;
}

export function runSwarmCollect(opts: SwarmCollectOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  if (!git.isRepo()) {
    out.error('not inside a git repository');
    return EXIT_CONFIG_ERROR;
  }
  const root = git.repoRoot();
  if (root === null) {
    out.error('cannot resolve repository root');
    return EXIT_CONFIG_ERROR;
  }
  const sessionId = resolveSessionId(root, opts.session);
  if (sessionId === null) {
    out.error('no Devin session ID found — pass --session <id> or set DEVIN_SESSION_ID');
    return EXIT_CONFIG_ERROR;
  }
  const into = opts.into ?? `devin/${sessionId}/integration`;

  if (opts.dryRun) {
    out.info(`dry-run: would collect swarm branches for ${sessionId} into ${into}`);
    out.result({ ok: true, action: 'swarm-collect', dryRun: true, sessionId, into });
    return EXIT_OK;
  }

  const result = swarmCollect(git, sessionId, into);
  for (const b of result.merged) out.info(`merged: ${b}`);
  for (const s of result.skipped) out.warn(`skipped ${s.branch}: ${s.reason}`);
  for (const c of result.conflicts) out.warn(`conflict (aborted, fail-closed): ${c}`);
  out.result({
    ok: result.conflicts.length === 0,
    action: 'swarm-collect',
    sessionId,
    integrationBranch: result.integrationBranch,
    merged: result.merged,
    skipped: result.skipped,
    conflicts: result.conflicts,
  });
  return EXIT_OK;
}
