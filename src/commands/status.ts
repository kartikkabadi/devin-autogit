import { createRequire } from 'node:module';
import { Git } from '../core/git.js';
import { ConfigError, resolveConfig } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';
import { readDevinMetadata } from '../devin/metadata.js';
import { listSwarmBranches } from '../devin/swarm.js';

const require = createRequire(import.meta.url);

export function packageVersion(): string {
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

export interface StatusOptions {
  json: boolean;
}

export function runStatus(opts: StatusOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  const version = packageVersion();
  const inRepo = git.isRepo();
  const root = inRepo ? git.repoRoot() : null;
  if (root === null) {
    out.error('not inside a git repository');
    out.result({ ok: false, action: 'status', version, repo: null });
    return EXIT_CONFIG_ERROR;
  }
  const detection = detectDevinSession({ repoRoot: root });

  let enabled = false;
  let policySummary: unknown = null;
  let configError: string | null = null;
  if (root !== null) {
    try {
      const config = resolveConfig(root);
      enabled = config.enabled;
      policySummary = {
        protectedBranches: config.policy.protectedBranches,
        denyPaths: config.policy.denyPaths,
        maxFiles: config.policy.maxFiles,
        maxBytes: config.policy.maxBytes,
        llmGateEnabled: config.policy.llmGate.enabled,
      };
    } catch (err) {
      if (err instanceof ConfigError) configError = err.message;
      else throw err;
    }
  }

  const metadata = root !== null ? readDevinMetadata(root) : null;
  const sessionId = detection.sessionId ?? metadata?.sessionId ?? null;
  const swarmBranches =
    root !== null && sessionId !== null ? listSwarmBranches(git, sessionId) : [];
  const held = root !== null && git.hasAnyChanges();

  out.info(`devin-autogit v${version}`);
  out.info(`repo: ${root ?? 'not in a git repository'}`);
  out.info(`enabled: ${enabled}`);
  if (configError) out.warn(configError);
  out.info(
    `devin: ${detection.isDevin ? `detected (${detection.signals.join(', ')})` : 'not detected'}`,
  );
  out.info(`mode: ${detection.autonomous ? 'autonomous (fail-closed)' : 'interactive'}`);
  if (sessionId) out.info(`session: ${sessionId}`);
  if (policySummary) out.info(`policy: ${JSON.stringify(policySummary)}`);
  out.info(`pending changes: ${held ? 'yes' : 'no'}`);
  if (swarmBranches.length > 0) out.info(`swarm branches: ${swarmBranches.join(', ')}`);

  out.result({
    ok: configError === null,
    action: 'status',
    version,
    repo: root,
    enabled,
    devinDetected: detection.isDevin,
    autonomous: detection.autonomous,
    sessionId,
    signals: detection.signals,
    policy: policySummary,
    configError,
    pendingChanges: held,
    swarmBranches,
  });
  return configError === null ? EXIT_OK : EXIT_CONFIG_ERROR;
}
