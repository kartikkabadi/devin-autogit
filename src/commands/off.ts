import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../core/git.js';
import { ConfigError, REPO_CONFIG_FILENAME, loadRepoConfig } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { runHookUninstall } from './hook.js';

export interface OffOptions {
  json: boolean;
  dryRun: boolean;
}

export function runOff(opts: OffOptions, cwd = process.cwd()): number {
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

  const path = join(root, REPO_CONFIG_FILENAME);
  if (!existsSync(path)) {
    out.info('auto-ship was not enabled in this repo');
    out.result({ ok: true, action: 'off', removed: false });
    return EXIT_OK;
  }
  let hadHooks = false;
  try {
    hadHooks = loadRepoConfig(root)?.hooks === true;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    out.warn(`${err.message} — skipping hook uninstall`);
  }
  if (hadHooks) {
    runHookUninstall({ json: false, dryRun: opts.dryRun }, cwd);
  }

  if (!opts.dryRun) unlinkSync(path);
  out.info(`${opts.dryRun ? 'would remove' : 'removed'} ${path} — auto-ship disabled`);
  out.result({ ok: true, action: 'off', removed: true, dryRun: opts.dryRun });
  return EXIT_OK;
}
