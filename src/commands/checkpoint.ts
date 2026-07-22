import { Git } from '../core/git.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';

export const CHECKPOINT_REF_PREFIX = 'refs/devin-autogit/checkpoints/';

export function checkpointRefName(label?: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const suffix = label ? `-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return `${CHECKPOINT_REF_PREFIX}${ts}${suffix}`;
}

export function writeCheckpointRef(git: Git, label?: string): string | null {
  const sha = git.headSha();
  if (sha === null) return null;
  const ref = checkpointRefName(label);
  return git.updateRef(ref, sha).ok ? ref : null;
}

export interface CheckpointOptions {
  json: boolean;
  dryRun: boolean;
  label?: string;
}

export function runCheckpoint(opts: CheckpointOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  if (!git.isRepo()) {
    out.error('not inside a git repository');
    return EXIT_CONFIG_ERROR;
  }
  if (opts.dryRun) {
    const ref = checkpointRefName(opts.label);
    out.info(`dry-run: would record checkpoint ${ref}`);
    out.result({ ok: true, action: 'checkpoint', ref, dryRun: true });
    return EXIT_OK;
  }
  const ref = writeCheckpointRef(git, opts.label);
  if (ref === null) {
    out.error('cannot record checkpoint — no HEAD commit?');
    return EXIT_CONFIG_ERROR;
  }
  out.info(`checkpoint recorded: ${ref}`);
  out.result({ ok: true, action: 'checkpoint', ref, sha: git.headSha() });
  return EXIT_OK;
}
