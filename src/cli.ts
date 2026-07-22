#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('devin-autogit')
  .description('Devin-aware auto stage → secrets scan → commit → push CLI for AI coding agents')
  .version('0.1.0')
  .option('--json', 'emit machine-readable JSON results on stdout')
  .option('--dry-run', 'show what would happen without making changes');

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`Not implemented: ${name}`);
  };
}

program
  .command('setup')
  .description('Detect environment and write global config')
  .action(notImplemented('setup'));

program
  .command('on')
  .description('Enable auto-ship in the current repo')
  .option('--policy <file>', 'policy file to use')
  .option('--public-ok', 'allow enabling on a public repo')
  .action(notImplemented('on'));

program
  .command('off')
  .description('Disable auto-ship in the current repo')
  .action(notImplemented('off'));

program
  .command('ship')
  .description('Stage → secrets scan → policy gate → commit → push')
  .option('-m, --message <msg>', 'commit message')
  .action(notImplemented('ship'));

program
  .command('undo')
  .description('Take back the last devin-autogit commit')
  .action(notImplemented('undo'));

program
  .command('status')
  .description('Report version, repo enablement, and Devin session detection')
  .action(notImplemented('status'));

program
  .command('checkpoint')
  .description('Record a lightweight local checkpoint ref')
  .argument('[label]', 'optional checkpoint label')
  .action(notImplemented('checkpoint'));

program
  .command('swarm')
  .description('Per-subagent worktree and branch workflows (init/collect)')
  .argument('<subcommand>', 'init | collect')
  .action(notImplemented('swarm'));

program
  .command('doctor')
  .description('Diagnose git auth, remote access, Devin env detection, config validity')
  .action(notImplemented('doctor'));

program.parse();
