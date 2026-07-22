import { Git, buildCommitMessage, deriveSubject, sanitizeRemoteUrl } from '../core/git.js';
import { ConfigError, REPO_CONFIG_FILENAME, resolveConfig } from '../core/config.js';
import { HOOKS_FILE_RELPATH } from '../core/hooks.js';
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
  quiet?: boolean;
  forceSecrets: boolean;
  checkpoint: boolean;
  remote: string;
}

function holdReason(gate: string | undefined): string {
  if (gate === 'llm') return 'llm-gate-unavailable';
  return gate ?? 'policy';
}

export function runShip(opts: ShipOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json, quiet: opts.quiet ?? false });
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

  if (detection.autonomous && metadata.errors.length > 0) {
    for (const err of metadata.errors) {
      out.warn(`invalid Devin metadata: ${err}`);
    }
    out.info('metadata is unparseable — holding (fail-closed in autonomous mode)');
    out.result({
      ok: true,
      action: 'ship',
      shipped: false,
      held: true,
      result: 'held',
      reason: 'invalid-metadata',
      holds: metadata.errors.map((e) => ({ gate: 'metadata', reason: `invalid metadata: ${e}` })),
      autonomous: detection.autonomous,
    });
    return EXIT_OK;
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

  // Defensive: never ship the autogit config or hooks file, even in repos
  // enabled before these were added to .git/info/exclude.
  git.unstage([REPO_CONFIG_FILENAME, HOOKS_FILE_RELPATH]);

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
    git.unstageAll();
    out.info('changes held — nothing committed, everything unstaged, working tree preserved');
    out.result({
      ok: true,
      action: 'ship',
      shipped: false,
      held: true,
      result: 'held',
      reason: holdReason(decision.holds[0]?.gate),
      holds: decision.holds,
      protectedBranches: policy.protectedBranches,
      autonomous: detection.autonomous,
    });
    return EXIT_OK;
  }

  if (opts.forceSecrets && !detection.autonomous && findings.length > 0) {
    out.warn(
      `secrets gate OVERRIDDEN by --force-secrets: ${findings.length} potential secret(s) will be shipped`,
    );
  }

  const sessionId = detection.sessionId ?? metadata.sessionId ?? undefined;
  const task = detection.task ?? metadata.task ?? undefined;
  const subject = deriveSubject(opts.message, task, stagedFiles);
  const message = buildCommitMessage(subject, {
    session: sessionId,
    task: task ? taskSlug(task) : undefined,
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

  const {
    result: push,
    rebased,
    rebaseConflict,
  } = git.pushWithRebaseRetry(opts.remote, branch as string);
  if (!push.ok) {
    if (rebaseConflict) {
      out.warn('rebase conflict — cannot auto-resolve, holding (fail-closed)');
      out.info('rebase aborted; commit is local — resolve manually or retry after pulling');
      out.result({
        ok: true,
        action: 'ship',
        shipped: true,
        pushed: false,
        held: true,
        result: 'held',
        reason: 'rebase-conflict',
        holds: [{ gate: 'push', reason: 'rebase-conflict' }],
        subject,
        branch,
        sha: git.headSha(),
      });
      return EXIT_OK;
    }
    out.warn(`push failed: ${sanitizeRemoteUrl(push.stderr.trim())}`);
    out.info('commit is local — held for retry on next ship');
    out.result({
      ok: true,
      action: 'ship',
      shipped: true,
      pushed: false,
      held: true,
      result: 'held',
      reason: 'push-failed',
      holds: [{ gate: 'push', reason: sanitizeRemoteUrl(push.stderr.trim()) }],
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
    protectedBranches: policy.protectedBranches,
  });
  return EXIT_OK;
}
