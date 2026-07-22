import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Git, sanitizeRemoteUrl } from '../core/git.js';
import { ConfigError, REPO_CONFIG_FILENAME, repoConfigSchema } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';

export interface OnOptions {
  json: boolean;
  dryRun: boolean;
  policy?: string;
  publicOk: boolean;
}

/** Keep the config file local-only: add it to .git/info/exclude so `git add -A` never stages it. */
function excludeConfigFile(git: Git, root: string): void {
  const gitDir = git.gitDir();
  if (gitDir === null) return;
  const excludePath = join(isAbsolute(gitDir) ? gitDir : resolve(root, gitDir), 'info', 'exclude');
  const entry = `/${REPO_CONFIG_FILENAME}`;
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === entry)) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(excludePath, `${prefix}${entry}\n`);
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
    excludeConfigFile(git, root);
  }
  out.info(
    `${opts.dryRun ? 'would write' : existed ? 'updated' : 'wrote'} ${path} — auto-ship enabled`,
  );
  out.result({ ok: true, action: 'on', configPath: path, dryRun: opts.dryRun });
  return EXIT_OK;
}
