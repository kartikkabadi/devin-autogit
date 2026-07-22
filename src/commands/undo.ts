import { Git, hasShippedByTrailer } from '../core/git.js';
import { ConfigError, resolveConfig } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { isProtectedBranch } from '../core/policy.js';

export interface UndoOptions {
  json: boolean;
  dryRun: boolean;
  remote: string;
}

export function runUndo(opts: UndoOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  if (!git.isRepo()) {
    out.error('not inside a git repository');
    return EXIT_CONFIG_ERROR;
  }

  const head = git.headSha();
  if (head === null) {
    out.error('no HEAD commit to undo');
    return EXIT_CONFIG_ERROR;
  }

  const message = git.commitMessage('HEAD');
  if (message === null || !hasShippedByTrailer(message)) {
    out.error('last commit was not shipped by devin-autogit — refusing to undo');
    out.result({ ok: false, action: 'undo', reason: 'foreign-commit' });
    return EXIT_CONFIG_ERROR;
  }

  const parentRes = git.exec(['rev-parse', 'HEAD^']);
  if (!parentRes.ok) {
    out.error('cannot undo the root commit');
    return EXIT_CONFIG_ERROR;
  }
  const parent = parentRes.stdout.trim();
  const branch = git.currentBranch();

  let protectedBranches: string[] = ['main', 'master'];
  const root = git.repoRoot();
  if (root !== null) {
    try {
      protectedBranches = resolveConfig(root).policy.protectedBranches;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
    }
  }

  if (branch !== null && git.hasRemote(opts.remote)) {
    if (isProtectedBranch(branch, protectedBranches)) {
      out.error(`branch "${branch}" is protected — refusing to rewind the remote`);
      out.result({ ok: false, action: 'undo', reason: 'protected-branch', branch });
      return EXIT_CONFIG_ERROR;
    }
    const remoteSha = git.remoteHeadSha(opts.remote, branch);
    if (remoteSha !== null && remoteSha !== head) {
      out.error(
        `remote ${opts.remote}/${branch} has moved past the shipped commit — refusing to rewind`,
      );
      out.result({ ok: false, action: 'undo', reason: 'remote-moved', remoteSha, localSha: head });
      return EXIT_CONFIG_ERROR;
    }
    if (remoteSha === head) {
      if (opts.dryRun) {
        out.info(`dry-run: would force-with-lease rewind ${opts.remote}/${branch} to ${parent}`);
      } else {
        const push = git.forceWithLeasePush(opts.remote, branch, head, parent);
        if (!push.ok) {
          out.error(`remote rewind failed: ${push.stderr.trim()}`);
          return EXIT_CONFIG_ERROR;
        }
        out.info(`remote ${opts.remote}/${branch} rewound to ${parent.slice(0, 12)}`);
      }
    }
  }

  if (opts.dryRun) {
    out.info(`dry-run: would mixed-reset local HEAD to ${parent.slice(0, 12)}`);
    out.result({ ok: true, action: 'undo', dryRun: true, undone: head, parent });
    return EXIT_OK;
  }

  const reset = git.mixedReset(parent);
  if (!reset.ok) {
    out.error(`local reset failed: ${reset.stderr.trim()}`);
    return EXIT_CONFIG_ERROR;
  }
  out.info(`undid commit ${head.slice(0, 12)} — changes preserved in the working tree`);
  out.result({ ok: true, action: 'undo', undone: head, parent });
  return EXIT_OK;
}
