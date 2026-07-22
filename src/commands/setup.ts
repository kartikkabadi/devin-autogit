import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Git } from '../core/git.js';
import { globalConfigDir, globalConfigPath, loadGlobalConfig } from '../core/config.js';
import { Output, EXIT_OK } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';

export interface SetupOptions {
  json: boolean;
  dryRun: boolean;
}

export function runSetup(opts: SetupOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  const detection = detectDevinSession({ repoRoot: git.isRepo() ? git.repoRoot() : null });

  const environment = `${detection.isDevin ? 'devin' : 'generic'}/${
    detection.autonomous ? 'autonomous' : 'interactive'
  }`;

  const dir = globalConfigDir();
  const path = globalConfigPath();
  const created = !existsSync(path);
  if (!opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    const config = { ...loadGlobalConfig(), environment };
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }

  out.info(`environment: ${environment}`);
  if (detection.sessionId) out.info(`session: ${detection.sessionId}`);
  out.info(
    created
      ? `${opts.dryRun ? 'would write' : 'wrote'} global config ${path}`
      : `global config already exists at ${path}`,
  );
  out.info('next steps:');
  out.info('  1. run `devin-autogit on` inside each repo you want auto-shipped');
  out.info('  2. add `devin-autogit ship` as a post-turn step (e.g. in AGENTS.md or a blueprint)');

  out.result({
    ok: true,
    action: 'setup',
    devinDetected: detection.isDevin,
    environment,
    sessionId: detection.sessionId,
    autonomous: detection.autonomous,
    globalConfigPath: path,
    created,
    dryRun: opts.dryRun,
  });
  return EXIT_OK;
}
