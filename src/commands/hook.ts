import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Git, addToInfoExclude } from '../core/git.js';
import { ConfigError } from '../core/config.js';
import {
  hooksFilePath,
  installStopHook,
  readHooksFile,
  uninstallStopHook,
  writeHooksFile,
} from '../core/hooks.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';

export interface HookInstallOptions {
  json: boolean;
  dryRun: boolean;
  bin?: string;
  file?: string;
}

export interface HookUninstallOptions {
  json: boolean;
  dryRun: boolean;
  file?: string;
}

/** Resolve the command string used to invoke `devin-autogit` from a hook. */
export function resolveHookCommand(binOverride?: string): string | null {
  if (binOverride) return `${binOverride} ship --quiet --json --from-hook`;
  const which = spawnSync('which', ['devin-autogit'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim().length > 0) {
    return 'devin-autogit ship --quiet --json --from-hook';
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../cli.js'), resolve(here, '../../dist/cli.js')]) {
    if (existsSync(candidate)) return `node ${candidate} ship --quiet --json --from-hook`;
  }
  return null;
}

function resolveHooksFile(
  out: Output,
  cwd: string,
  file?: string,
): { path: string } | { error: number } {
  if (file) return { path: resolve(cwd, file) };
  const git = new Git(cwd);
  const root = git.isRepo() ? git.repoRoot() : null;
  if (root === null) {
    out.error('not inside a git repository (use --file to target a hooks file directly)');
    return { error: EXIT_CONFIG_ERROR };
  }
  return { path: hooksFilePath(root) };
}

export function runHookInstall(opts: HookInstallOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const target = resolveHooksFile(out, cwd, opts.file);
  if ('error' in target) return target.error;

  const command = resolveHookCommand(opts.bin);
  if (command === null) {
    out.error(
      'cannot resolve the devin-autogit executable — run `npm link` (or `npm install -g`) ' +
        'so it is on PATH, or pass --bin <path>',
    );
    return EXIT_CONFIG_ERROR;
  }

  let hooks;
  try {
    hooks = readHooksFile(target.path);
  } catch (err) {
    if (err instanceof ConfigError) {
      out.error(err.message);
      return EXIT_CONFIG_ERROR;
    }
    throw err;
  }

  const { hooks: next, installed } = installStopHook(hooks, command, {
    events: ['Stop', 'SessionEnd'],
  });
  if (installed.length === 0) {
    out.info(`hook already installed in ${target.path}`);
    out.result({ ok: true, action: 'hook-install', installed: [], path: target.path, command });
    return EXIT_OK;
  }
  if (!opts.dryRun) {
    writeHooksFile(target.path, next);
    excludeHooksFileFromTracking(cwd, target.path);
  }
  out.info(
    `${opts.dryRun ? 'would install' : 'installed'} ${installed.join(', ')} hook(s) in ${target.path}`,
  );
  out.result({
    ok: true,
    action: 'hook-install',
    installed,
    path: target.path,
    command,
    dryRun: opts.dryRun,
  });
  return EXIT_OK;
}

/** Keep the hooks file local-only via .git/info/exclude when it lives inside the repo. */
function excludeHooksFileFromTracking(cwd: string, hooksPath: string): void {
  const git = new Git(cwd);
  const root = git.isRepo() ? git.repoRoot() : null;
  if (root === null) return;
  const rel = relative(root, hooksPath);
  if (rel.startsWith('..') || rel.length === 0) return;
  addToInfoExclude(git, root, `/${rel.split(sep).join('/')}`);
}

export function runHookUninstall(opts: HookUninstallOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const target = resolveHooksFile(out, cwd, opts.file);
  if ('error' in target) return target.error;

  if (!existsSync(target.path)) {
    out.info(`no hooks file at ${target.path} — nothing to do`);
    out.result({ ok: true, action: 'hook-uninstall', removed: [], path: target.path });
    return EXIT_OK;
  }

  let hooks;
  try {
    hooks = readHooksFile(target.path);
  } catch (err) {
    if (err instanceof ConfigError) {
      out.error(err.message);
      return EXIT_CONFIG_ERROR;
    }
    throw err;
  }

  const { hooks: next, removed } = uninstallStopHook(hooks);
  const empty = Object.keys(next).length === 0;
  if (!opts.dryRun) {
    if (empty) {
      unlinkSync(target.path);
    } else {
      writeHooksFile(target.path, next);
    }
  }
  out.info(
    removed.length === 0
      ? `no devin-autogit hooks found in ${target.path}`
      : `${opts.dryRun ? 'would remove' : 'removed'} ${removed.join(', ')} hook(s) from ${target.path}${empty ? ' (file deleted)' : ''}`,
  );
  out.result({
    ok: true,
    action: 'hook-uninstall',
    removed,
    path: target.path,
    deleted: empty && removed.length > 0,
    dryRun: opts.dryRun,
  });
  return EXIT_OK;
}
