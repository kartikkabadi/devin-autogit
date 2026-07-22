import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionDetection {
  isDevin: boolean;
  sessionId: string | null;
  /** Fail-closed autonomous mode: Devin detected and no interactive TTY. */
  autonomous: boolean;
  signals: string[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string | null;
  fsExists?: (path: string) => boolean;
  isTty?: boolean;
}

const SESSION_ENV_VARS = ['DEVIN_SESSION_ID', 'DEVIN_ID', 'DEVIN_SESSION'];
const VM_MARKERS = ['/opt/.devin'];

export function detectDevinSession(opts: DetectOptions = {}): SessionDetection {
  const env = opts.env ?? process.env;
  const fsExists = opts.fsExists ?? existsSync;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const signals: string[] = [];
  let sessionId: string | null = null;

  for (const name of SESSION_ENV_VARS) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      signals.push(`env:${name}`);
      if (sessionId === null) sessionId = value.trim();
    }
  }

  if (opts.repoRoot && fsExists(join(opts.repoRoot, '.devin'))) {
    signals.push('repo:.devin');
  }

  for (const marker of VM_MARKERS) {
    if (fsExists(marker)) signals.push(`vm:${marker}`);
  }

  const isDevin = signals.length > 0;
  return {
    isDevin,
    sessionId,
    autonomous: isDevin && !isTty,
    signals,
  };
}
