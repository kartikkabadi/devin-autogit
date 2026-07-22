#!/usr/bin/env node
import { Command } from 'commander';
import { runSetup } from './commands/setup.js';
import { runOn } from './commands/on.js';
import { runOff } from './commands/off.js';
import { runShip } from './commands/ship.js';
import { runUndo } from './commands/undo.js';
import { runStatus, packageVersion } from './commands/status.js';
import { runCheckpoint } from './commands/checkpoint.js';
import { runSwarmInit, runSwarmCollect } from './commands/swarm.js';
import { runDoctor } from './commands/doctor.js';
import { runHookInstall, runHookUninstall } from './commands/hook.js';

const program = new Command();

program
  .name('devin-autogit')
  .description('Devin-aware auto stage → secrets scan → commit → push CLI for AI coding agents')
  .version(packageVersion())
  .option('--json', 'emit machine-readable JSON results on stdout')
  .option('--dry-run', 'show what would happen without making changes');

interface GlobalOpts {
  json: boolean;
  dryRun: boolean;
}

function globalOpts(): GlobalOpts {
  const opts = program.opts<{ json?: boolean; dryRun?: boolean }>();
  return { json: opts.json ?? false, dryRun: opts.dryRun ?? false };
}

program
  .command('setup')
  .description('Detect environment and write global config')
  .action(() => {
    process.exitCode = runSetup(globalOpts());
  });

program
  .command('on')
  .description('Enable auto-ship in the current repo')
  .option('--policy <file>', 'policy file to use')
  .option('--public-ok', 'allow enabling on a public repo')
  .option('--with-hooks', 'also install the Devin CLI Stop hook to auto-ship each turn')
  .action((opts: { policy?: string; publicOk?: boolean; withHooks?: boolean }) => {
    process.exitCode = runOn({
      ...globalOpts(),
      policy: opts.policy,
      publicOk: opts.publicOk ?? false,
      withHooks: opts.withHooks ?? false,
    });
  });

program
  .command('off')
  .description('Disable auto-ship in the current repo')
  .action(() => {
    process.exitCode = runOff(globalOpts());
  });

program
  .command('ship')
  .description('Stage → secrets scan → policy gate → commit → push')
  .option('-m, --message <msg>', 'commit message')
  .option('--quiet', 'suppress non-error stderr output (for use inside hooks)')
  .option('--force-secrets', 'override a secrets hold (refused in autonomous mode)')
  .option('--checkpoint', 'record a checkpoint ref before pushing')
  .option('--remote <name>', 'remote to push to', 'origin')
  .action(
    (opts: {
      message?: string;
      quiet?: boolean;
      forceSecrets?: boolean;
      checkpoint?: boolean;
      remote: string;
    }) => {
      process.exitCode = runShip({
        ...globalOpts(),
        message: opts.message,
        quiet: opts.quiet ?? false,
        forceSecrets: opts.forceSecrets ?? false,
        checkpoint: opts.checkpoint ?? false,
        remote: opts.remote,
      });
    },
  );

program
  .command('undo')
  .description('Take back the last devin-autogit commit')
  .option('--remote <name>', 'remote to rewind', 'origin')
  .action((opts: { remote: string }) => {
    process.exitCode = runUndo({ ...globalOpts(), remote: opts.remote });
  });

program
  .command('status')
  .description('Report version, repo enablement, and Devin session detection')
  .action(() => {
    process.exitCode = runStatus(globalOpts());
  });

program
  .command('checkpoint')
  .description('Record a lightweight local checkpoint ref')
  .argument('[label]', 'optional checkpoint label')
  .action((label: string | undefined) => {
    process.exitCode = runCheckpoint({ ...globalOpts(), label });
  });

const swarm = program
  .command('swarm')
  .description('Per-subagent worktree and branch workflows (init/collect)');

swarm
  .command('init')
  .description('Create per-subagent worktrees and branches')
  .argument('<task>', 'task description for the swarm')
  .option('--agents <n>', 'number of subagents', (v) => Number.parseInt(v, 10), 2)
  .option('--session <id>', 'Devin session ID (defaults to detected session)')
  .action((task: string, opts: { agents: number; session?: string }) => {
    process.exitCode = runSwarmInit(task, {
      ...globalOpts(),
      agents: opts.agents,
      session: opts.session,
    });
  });

swarm
  .command('collect')
  .description('Merge completed subagent branches into an integration branch')
  .option('--into <branch>', 'integration branch name')
  .option('--session <id>', 'Devin session ID (defaults to detected session)')
  .action((opts: { into?: string; session?: string }) => {
    process.exitCode = runSwarmCollect({
      ...globalOpts(),
      into: opts.into,
      session: opts.session,
    });
  });

const hook = program
  .command('hook')
  .description('Manage the Devin CLI hook that auto-ships after each assistant turn');

hook
  .command('install')
  .description('Install the Stop/SessionEnd auto-ship hook into .devin/hooks.v1.json')
  .option('--bin <path>', 'command to invoke devin-autogit from the hook')
  .option('--file <path>', 'hooks file to write (default: <repoRoot>/.devin/hooks.v1.json)')
  .action((opts: { bin?: string; file?: string }) => {
    process.exitCode = runHookInstall({ ...globalOpts(), bin: opts.bin, file: opts.file });
  });

hook
  .command('uninstall')
  .description('Remove the devin-autogit auto-ship hook entries')
  .option('--file <path>', 'hooks file to edit (default: <repoRoot>/.devin/hooks.v1.json)')
  .action((opts: { file?: string }) => {
    process.exitCode = runHookUninstall({ ...globalOpts(), file: opts.file });
  });

program
  .command('doctor')
  .description('Diagnose git auth, remote access, Devin env detection, config validity')
  .option('--remote <name>', 'remote to check', 'origin')
  .action((opts: { remote: string }) => {
    process.exitCode = runDoctor({ json: globalOpts().json, remote: opts.remote });
  });

program.parse();
