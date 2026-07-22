import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  (args: string[], cwd?: string): GitResult;
}

export function runGit(args: string[], cwd?: string): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Reject user-supplied values that could be parsed as git options. */
export function isSafeGitArg(value: string): boolean {
  return value.length > 0 && !value.startsWith('-');
}

function unsafeArgResult(what: string, value: string): GitResult {
  return { ok: false, code: -1, stdout: '', stderr: `refusing unsafe ${what}: "${value}"` };
}

/** Strip userinfo (credentials) from URLs embedded in text. */
export function sanitizeRemoteUrl(text: string): string {
  return text.replace(/(\/\/)[^@/\s]+@/g, '$1');
}

export class Git {
  constructor(
    private readonly cwd: string,
    private readonly run: GitRunner = runGit,
  ) {}

  exec(args: string[]): GitResult {
    return this.run(args, this.cwd);
  }

  isRepo(): boolean {
    return this.exec(['rev-parse', '--is-inside-work-tree']).ok;
  }

  repoRoot(): string | null {
    const res = this.exec(['rev-parse', '--show-toplevel']);
    return res.ok ? res.stdout.trim() : null;
  }

  gitDir(): string | null {
    const res = this.exec(['rev-parse', '--git-common-dir']);
    return res.ok ? res.stdout.trim() : null;
  }

  currentBranch(): string | null {
    const res = this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!res.ok) return null;
    const name = res.stdout.trim();
    return name === 'HEAD' ? null : name;
  }

  stageAll(): GitResult {
    return this.exec(['add', '-A']);
  }

  unstageAll(): GitResult {
    return this.exec(['reset']);
  }

  unstage(paths: string[]): GitResult {
    return this.exec(['reset', '--', ...paths]);
  }

  stagedFiles(): string[] {
    const res = this.exec(['diff', '--cached', '--name-only', '-z']);
    if (!res.ok) return [];
    return res.stdout.split('\0').filter((f) => f.length > 0);
  }

  /** Added lines from the staged diff, with new-file line numbers. */
  stagedAddedLines(): Array<{ file: string; line: string; lineNumber: number }> {
    const res = this.exec(['diff', '--cached', '--unified=0']);
    if (!res.ok) return [];
    const out: Array<{ file: string; line: string; lineNumber: number }> = [];
    let currentFile = '';
    let lineNumber = 0;
    for (const raw of res.stdout.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      if (raw.startsWith('+++ b/')) {
        currentFile = raw.slice(6);
      } else if (hunk) {
        lineNumber = Number.parseInt(hunk[1] as string, 10);
      } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
        out.push({ file: currentFile, line: raw.slice(1), lineNumber });
        lineNumber += 1;
      }
    }
    return out;
  }

  stagedDiffBytes(): number {
    const res = this.exec(['diff', '--cached']);
    return res.ok ? Buffer.byteLength(res.stdout, 'utf8') : 0;
  }

  hasStagedChanges(): boolean {
    return !this.exec(['diff', '--cached', '--quiet']).ok;
  }

  hasAnyChanges(): boolean {
    const res = this.exec(['status', '--porcelain']);
    return res.ok && res.stdout.trim().length > 0;
  }

  commit(message: string): GitResult {
    return this.exec(['commit', '-m', message]);
  }

  push(remote: string, branch: string): GitResult {
    if (!isSafeGitArg(remote)) return unsafeArgResult('remote', remote);
    if (!isSafeGitArg(branch)) return unsafeArgResult('branch', branch);
    return this.exec(['push', '--', remote, `HEAD:refs/heads/${branch}`]);
  }

  /** Push with a single fetch + rebase + retry on non-fast-forward rejection. */
  pushWithRebaseRetry(
    remote: string,
    branch: string,
  ): { result: GitResult; rebased: boolean; rebaseConflict: boolean } {
    const first = this.push(remote, branch);
    if (first.ok) return { result: first, rebased: false, rebaseConflict: false };
    const rejected = /non-fast-forward|fetch first|\[rejected\]/i.test(first.stderr + first.stdout);
    if (!rejected) return { result: first, rebased: false, rebaseConflict: false };
    const fetch = this.exec(['fetch', '--', remote, branch]);
    if (!fetch.ok) return { result: first, rebased: false, rebaseConflict: false };
    const rebase = this.exec(['rebase', `${remote}/${branch}`]);
    if (!rebase.ok) {
      this.exec(['rebase', '--abort']);
      return { result: first, rebased: false, rebaseConflict: true };
    }
    return { result: this.push(remote, branch), rebased: true, rebaseConflict: false };
  }

  headSha(): string | null {
    const res = this.exec(['rev-parse', 'HEAD']);
    return res.ok ? res.stdout.trim() : null;
  }

  commitMessage(ref: string): string | null {
    const res = this.exec(['log', '-1', '--format=%B', ref]);
    return res.ok ? res.stdout : null;
  }

  remoteHeadSha(remote: string, branch: string): string | null {
    if (!isSafeGitArg(remote) || !isSafeGitArg(branch)) return null;
    const res = this.exec(['ls-remote', '--', remote, `refs/heads/${branch}`]);
    if (!res.ok) return null;
    const sha = res.stdout.split('\t')[0]?.trim();
    return sha && sha.length > 0 ? sha : null;
  }

  hasRemote(remote: string): boolean {
    const res = this.exec(['remote']);
    return res.ok && res.stdout.split('\n').includes(remote);
  }

  remoteUrl(remote: string): string | null {
    const res = this.exec(['remote', 'get-url', remote]);
    return res.ok ? res.stdout.trim() : null;
  }

  updateRef(ref: string, sha: string): GitResult {
    return this.exec(['update-ref', ref, sha]);
  }

  forceWithLeasePush(
    remote: string,
    branch: string,
    expectedSha: string,
    newSha: string,
  ): GitResult {
    if (!isSafeGitArg(remote)) return unsafeArgResult('remote', remote);
    if (!isSafeGitArg(branch)) return unsafeArgResult('branch', branch);
    return this.exec([
      'push',
      `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
      '--',
      remote,
      `${newSha}:refs/heads/${branch}`,
    ]);
  }

  /** Validate a branch name with git's own rules. */
  isValidBranchName(branch: string): boolean {
    return isSafeGitArg(branch) && this.exec(['check-ref-format', '--branch', branch]).ok;
  }

  mixedReset(ref: string): GitResult {
    return this.exec(['reset', '--mixed', ref]);
  }
}

/** Append a pattern to <git-common-dir>/info/exclude. Idempotent; returns false on failure. */
export function addToInfoExclude(git: Git, workdir: string, pattern: string): boolean {
  const common = git.gitDir();
  if (common === null) return false;
  const infoDir = resolve(workdir, common, 'info');
  const excludePath = join(infoDir, 'exclude');
  try {
    mkdirSync(infoDir, { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (current.split('\n').includes(pattern)) return true;
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface Trailers {
  session?: string;
  task?: string;
}

export const SHIPPED_BY_TRAILER = 'Shipped-by: devin-autogit';

export function formatTrailers(trailers: Trailers): string {
  const lines: string[] = [];
  if (trailers.session) lines.push(`Devin-Session: ${trailers.session}`);
  if (trailers.task) lines.push(`Devin-Task: ${trailers.task}`);
  lines.push(SHIPPED_BY_TRAILER);
  return lines.join('\n');
}

export function buildCommitMessage(subject: string, trailers: Trailers): string {
  return `${subject}\n\n${formatTrailers(trailers)}\n`;
}

const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*: \S.*$/;

/**
 * Parse the git trailer block: the final paragraph of the commit message,
 * separated from the body by a blank line, where every line is a
 * `Key: value` trailer (or an indented continuation line).
 */
export function parseTrailers(message: string): string[] {
  const lines = message.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const lastBlank = lines.lastIndexOf('');
  if (lastBlank <= 0 || lastBlank === lines.length - 1) return [];
  const block = lines.slice(lastBlank + 1);
  const isTrailerBlock = block.every(
    (line) => TRAILER_LINE.test(line) || /^[ \t]/.test(line),
  );
  return isTrailerBlock ? block.filter((line) => TRAILER_LINE.test(line)) : [];
}

export function hasShippedByTrailer(message: string): boolean {
  return parseTrailers(message).some((line) => line.trim() === SHIPPED_BY_TRAILER);
}

/** Subject precedence: -m flag > Devin task > file-list fallback. Flattened, 72-char cap. */
export function deriveSubject(
  explicit: string | undefined,
  devinTask: string | undefined,
  files: string[],
): string {
  const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (explicit && flatten(explicit).length > 0) return truncateSubject(flatten(explicit));
  if (devinTask && flatten(devinTask).length > 0) return truncateSubject(flatten(devinTask));
  if (files.length === 0) return 'devin-autogit: update';
  const list = files.slice(0, 3).join(', ');
  const extra = files.length > 3 ? ` (+${files.length - 3} more)` : '';
  return truncateSubject(`Update ${list}${extra}`);
}

export function truncateSubject(subject: string): string {
  return subject.length <= 72 ? subject : subject.slice(0, 69) + '...';
}
