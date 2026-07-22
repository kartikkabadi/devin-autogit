import { spawnSync } from 'node:child_process';

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

  stagedFiles(): string[] {
    const res = this.exec(['diff', '--cached', '--name-only', '-z']);
    if (!res.ok) return [];
    return res.stdout.split('\0').filter((f) => f.length > 0);
  }

  /** Added lines from the staged diff, as [file, line] pairs. */
  stagedAddedLines(): Array<{ file: string; line: string }> {
    const res = this.exec(['diff', '--cached', '--unified=0']);
    if (!res.ok) return [];
    const out: Array<{ file: string; line: string }> = [];
    let currentFile = '';
    for (const raw of res.stdout.split('\n')) {
      if (raw.startsWith('+++ b/')) {
        currentFile = raw.slice(6);
      } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
        out.push({ file: currentFile, line: raw.slice(1) });
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
    return this.exec(['push', remote, `HEAD:refs/heads/${branch}`]);
  }

  /** Push with a single fetch + rebase + retry on non-fast-forward rejection. */
  pushWithRebaseRetry(remote: string, branch: string): { result: GitResult; rebased: boolean } {
    const first = this.push(remote, branch);
    if (first.ok) return { result: first, rebased: false };
    const rejected = /non-fast-forward|fetch first|\[rejected\]/i.test(first.stderr + first.stdout);
    if (!rejected) return { result: first, rebased: false };
    const fetch = this.exec(['fetch', remote, branch]);
    if (!fetch.ok) return { result: first, rebased: false };
    const rebase = this.exec(['rebase', `${remote}/${branch}`]);
    if (!rebase.ok) {
      this.exec(['rebase', '--abort']);
      return { result: first, rebased: false };
    }
    return { result: this.push(remote, branch), rebased: true };
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
    const res = this.exec(['ls-remote', remote, `refs/heads/${branch}`]);
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
    return this.exec([
      'push',
      `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
      remote,
      `${newSha}:refs/heads/${branch}`,
    ]);
  }

  mixedReset(ref: string): GitResult {
    return this.exec(['reset', '--mixed', ref]);
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

export function hasShippedByTrailer(message: string): boolean {
  return message.split('\n').some((line) => line.trim() === SHIPPED_BY_TRAILER);
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
