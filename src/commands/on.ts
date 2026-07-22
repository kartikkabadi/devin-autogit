import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Git, sanitizeRemoteUrl } from '../core/git.js';
import { ConfigError, REPO_CONFIG_FILENAME, repoConfigSchema } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { runHookInstall } from './hook.js';

export interface OnOptions {
  json: boolean;
  dryRun: boolean;
  policy?: string;
  publicOk: boolean;
  withHooks?: boolean;
}

function looksPublic(remoteUrl: string | null): boolean {
  // Heuristic: we cannot know visibility offline; treat github.com/gitlab.com
  // remotes as potentially public and require --public-ok to skip the warning.
  return remoteUrl !== null && /github\.com|gitlab\.com|bitbucket\.org/.test(remoteUrl);
}

export function runOn(opts: OnOptions, cwd = process.cwd()): number {
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

  let policyOverride: unknown = undefined;
  if (opts.policy) {
    try {
      policyOverride = JSON.parse(readFileSync(opts.policy, 'utf8'));
    } catch (err) {
      out.error(`cannot read policy file ${opts.policy}: ${(err as Error).message}`);
      return EXIT_CONFIG_ERROR;
    }
  }

  const remoteUrl = git.remoteUrl('origin');
  if (looksPublic(remoteUrl) && !opts.publicOk) {
    out.warn(`remote ${sanitizeRemoteUrl(remoteUrl ?? '')} may be a public repo`);
    out.warn('auto-shipping to a public repo can leak work in progress or secrets');
    out.warn('re-run with --public-ok to confirm');
    out.result({ ok: false, action: 'on', held: true, reason: 'public-repo-guard' });
    return EXIT_CONFIG_ERROR;
  }

  const config = repoConfigSchema.safeParse({
    enabled: true,
    publicOk: opts.publicOk,
    ...(opts.withHooks ? { hooks: true } : {}),
    ...(policyOverride !== undefined ? { policy: policyOverride } : {}),
  });
  if (!config.success) {
    out.error(new ConfigError(`invalid policy: ${config.error.message}`).message);
    return EXIT_CONFIG_ERROR;
  }

  const path = join(root, REPO_CONFIG_FILENAME);
  const existed = existsSync(path);
  if (!opts.dryRun) {
    writeFileSync(path, JSON.stringify(config.data, null, 2) + '\n');
  }
  out.info(
    `${opts.dryRun ? 'would write' : existed ? 'updated' : 'wrote'} ${path} — auto-ship enabled`,
  );

  if (opts.withHooks) {
    const hookCode = runHookInstall({ json: false, dryRun: opts.dryRun }, cwd);
    if (hookCode !== EXIT_OK) {
      out.result({ ok: false, action: 'on', configPath: path, hooks: false });
      return hookCode;
    }
  }

  out.result({
    ok: true,
    action: 'on',
    configPath: path,
    hooks: opts.withHooks ?? false,
    dryRun: opts.dryRun,
  });
  return EXIT_OK;
}
