import { Git, buildCommitMessage, deriveSubject } from '../core/git.js';
import { ConfigError, resolveConfig } from '../core/config.js';
import { evaluatePolicy } from '../core/policy.js';
import { scanAddedLines } from '../core/secrets.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';
import { readDevinMetadata, taskSlug } from '../devin/metadata.js';
import { writeCheckpointRef } from './checkpoint.js';

export interface ShipOptions {
  json: boolean;
  dryRun: boolean;
  message?: string;
  forceSecrets: boolean;
  checkpoint: boolean;
  remote: string;
}

export function runShip(opts: ShipOptions, cwd = process.cwd()): number {
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

  let config;
  try {
    config = resolveConfig(root);
  } catch (err) {
    if (err instanceof ConfigError) {
      out.error(err.message);
      return EXIT_CONFIG_ERROR;
    }
    throw err;
  }

  if (!config.enabled) {
    out.info('auto-ship not enabled in this repo (run `devin-autogit on`) — no-op');
    out.result({ ok: true, action: 'ship', shipped: false, reason: 'not-enabled' });
    return EXIT_OK;
  }

  const detection = detectDevinSession({ repoRoot: root });
  const metadata = readDevinMetadata(root);
  const policy = { ...config.policy };
  if (metadata.protectedBranches) {
    policy.protectedBranches = [
      ...new Set([...policy.protectedBranches, ...metadata.protectedBranches]),
    ];
  }

  if (!git.hasAnyChanges() && !git.hasStagedChanges()) {
    out.info('working tree clean — nothing to ship');
    out.result({ ok: true, action: 'ship', shipped: false, reason: 'clean' });
    return EXIT_OK;
  }

  const stage = git.stageAll();
  if (!stage.ok) {
    out.error(`git add failed: ${stage.stderr.trim()}`);
    return EXIT_CONFIG_ERROR;
  }

  const stagedFiles = git.stagedFiles();
  if (stagedFiles.length === 0) {
    out.info('nothing staged — nothing to ship');
    out.result({ ok: true, action: 'ship', shipped: false, reason: 'clean' });
    return EXIT_OK;
  }

  const findings = scanAddedLines(git.stagedAddedLines(), stagedFiles);
  const branch = git.currentBranch();
  const decision = evaluatePolicy(
    {
      branch,
      stagedFiles,
      diffBytes: git.stagedDiffBytes(),
      secretFindings: findings,
      autonomous: detection.autonomous,
      forceSecrets: opts.forceSecrets,
    },
    policy,
  );

  if (!decision.allowed) {
    for (const hold of decision.holds) {
      out.warn(`hold (${hold.gate}): ${hold.reason}`);
    }
    out.info('changes held — nothing committed, working tree preserved');
    out.result({
      ok: true,
      action: 'ship',
      shipped: false,
      held: true,
      holds: decision.holds,
      autonomous: detection.autonomous,
    });
    return EXIT_OK;
  }

  const sessionId = detection.sessionId ?? metadata.sessionId ?? undefined;
  const subject = deriveSubject(opts.message, metadata.task ?? undefined, stagedFiles);
  const message = buildCommitMessage(subject, {
    session: sessionId,
    task: metadata.task ? taskSlug(metadata.task) : undefined,
  });

  if (opts.dryRun) {
    out.info(`dry-run: would commit "${subject}" and push to ${opts.remote}/${branch}`);
    out.result({
      ok: true,
      action: 'ship',
      shipped: false,
      dryRun: true,
      subject,
      branch,
      files: stagedFiles,
    });
    return EXIT_OK;
  }

  if (opts.checkpoint) {
    const ref = writeCheckpointRef(git, 'pre-ship');
    if (ref) out.info(`checkpoint recorded: ${ref}`);
  }

  const commit = git.commit(message);
  if (!commit.ok) {
    out.error(`git commit failed: ${commit.stderr.trim()}`);
    return EXIT_CONFIG_ERROR;
  }

  if (!git.hasRemote(opts.remote)) {
    out.warn(`remote "${opts.remote}" not configured — committed locally only`);
    out.result({
      ok: true,
      action: 'ship',
      shipped: true,
      pushed: false,
      subject,
      branch,
      sha: git.headSha(),
    });
    return EXIT_OK;
  }

  const { result: push, rebased } = git.pushWithRebaseRetry(opts.remote, branch as string);
  if (!push.ok) {
    out.warn(`push failed: ${push.stderr.trim()}`);
    out.info('commit is local — held for retry on next ship');
    out.result({
      ok: true,
      action: 'ship',
      shipped: true,
      pushed: false,
      held: true,
      holds: [{ gate: 'push', reason: push.stderr.trim() }],
      subject,
      branch,
      sha: git.headSha(),
    });
    return EXIT_OK;
  }

  out.info(`shipped "${subject}" to ${opts.remote}/${branch}${rebased ? ' (after rebase)' : ''}`);
  out.result({
    ok: true,
    action: 'ship',
    shipped: true,
    pushed: true,
    rebased,
    subject,
    branch,
    sha: git.headSha(),
    files: stagedFiles,
  });
  return EXIT_OK;
}
