import { Git } from '../core/git.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';
import { readDevinMetadata, taskSlug } from '../devin/metadata.js';
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

/** Branch base precedence: task slug > session ID > timestamp default. */
function resolveSwarmBase(task: string | undefined, sessionId: string | null): string {
  if (task && taskSlug(task).length > 0) return taskSlug(task);
  if (sessionId !== null) return sessionId;
  return `swarm-${Date.now().toString(36)}`;
}

export function runSwarmInit(
  task: string | undefined,
  opts: SwarmInitOptions,
  cwd = process.cwd(),
): number {
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
  const base = resolveSwarmBase(task, sessionId);

  if (opts.dryRun) {
    out.info(`dry-run: would create ${opts.agents} worktree(s) under devin/${base}/`);
    out.result({
      ok: true,
      action: 'swarm-init',
      dryRun: true,
      base,
      sessionId,
      agents: opts.agents,
    });
    return EXIT_OK;
  }

  const result = swarmInit(git, root, base, opts.agents);
  for (const wt of result.worktrees) out.info(`worktree: ${wt}`);
  for (const b of result.branches) out.info(`branch: ${b}`);
  for (const e of result.errors) out.warn(e);
  out.result({
    ok: result.errors.length === 0,
    action: 'swarm-init',
    task: task ?? null,
    base,
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
  task?: string;
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
  if (opts.task === undefined && sessionId === null) {
    out.error('no swarm base found — pass --task <task>, --session <id>, or set DEVIN_SESSION_ID');
    return EXIT_CONFIG_ERROR;
  }
  const base = resolveSwarmBase(opts.task, sessionId);
  const into = opts.into ?? `devin/${base}/integration`;

  if (opts.dryRun) {
    out.info(`dry-run: would collect swarm branches for ${base} into ${into}`);
    out.result({ ok: true, action: 'swarm-collect', dryRun: true, base, sessionId, into });
    return EXIT_OK;
  }

  const result = swarmCollect(git, base, into);
  for (const b of result.merged) out.info(`merged: ${b}`);
  for (const s of result.skipped) out.warn(`skipped ${s.branch}: ${s.reason}`);
  for (const c of result.conflicts) out.warn(`conflict (aborted, fail-closed): ${c}`);
  out.result({
    ok: result.conflicts.length === 0,
    action: 'swarm-collect',
    base,
    sessionId,
    integrationBranch: result.integrationBranch,
    merged: result.merged,
    skipped: result.skipped,
    conflicts: result.conflicts,
  });
  return EXIT_OK;
}
