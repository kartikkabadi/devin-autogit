import { createRequire } from 'node:module';
import { Git } from '../core/git.js';
import { ConfigError, resolveConfig } from '../core/config.js';
import { hooksFilePath, isOurHookCommand, readHooksFile } from '../core/hooks.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';
import { readDevinMetadata } from '../devin/metadata.js';
import { listSwarmBranches } from '../devin/swarm.js';

const require = createRequire(import.meta.url);

function hookFileInstalled(repoRoot: string): boolean {
  try {
    const hooksFile = readHooksFile(hooksFilePath(repoRoot));
    return Object.values(hooksFile).some((entries) =>
      entries.some((entry) => entry.hooks.some((hook) => isOurHookCommand(hook.command))),
    );
  } catch {
    return false;
  }
}

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
  if (git.isBareRepo()) {
    out.error('bare repository — work tree required');
    out.result({ ok: false, action: 'status', version, repo: null });
    return EXIT_CONFIG_ERROR;
  }
  const inRepo = git.isRepo();
  const root = inRepo ? git.repoRoot() : null;
  if (root === null) {
    out.error('not inside a git repository');
    out.result({
      ok: true,
      action: 'status',
      version,
      enabled: false,
      devinDetected: false,
      repo: null,
    });
    return EXIT_OK;
  }
  const detection = detectDevinSession({ repoRoot: root });

  let enabled = false;
  let hooks = false;
  let policySummary: unknown = null;
  let protectedBranches: string[] | null = null;
  let configError: string | null = null;
  const metadata = root !== null ? readDevinMetadata(root) : null;
  if (root !== null) {
    try {
      const config = resolveConfig(root);
      enabled = config.enabled;
      hooks = config.hooks && hookFileInstalled(root);
      protectedBranches = [
        ...new Set([
          ...config.policy.protectedBranches,
          ...(metadata?.protectedBranches ?? []),
        ]),
      ];
      policySummary = {
        protectedBranches,
        branchPrefix: metadata?.branchPrefix ?? null,
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

  const sessionId = detection.sessionId ?? metadata?.sessionId ?? null;
  const swarmBranches =
    root !== null && sessionId !== null ? listSwarmBranches(git, sessionId) : [];
  const held = root !== null && git.hasAnyChanges();

  out.info(`devin-autogit v${version}`);
  out.info(`repo: ${root ?? 'not in a git repository'}`);
  out.info(`enabled: ${enabled}`);
  out.info(`hooks: ${hooks}`);
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
    hooks,
    devinDetected: detection.isDevin,
    autonomous: detection.autonomous,
    sessionId,
    signals: detection.signals,
    policy: policySummary,
    protectedBranches,
    configError,
    pendingChanges: held,
    swarmBranches,
  });
  return configError === null ? EXIT_OK : EXIT_CONFIG_ERROR;
}
