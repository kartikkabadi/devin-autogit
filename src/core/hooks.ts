import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './config.js';

export const HOOKS_FILE_RELPATH = join('.devin', 'hooks.v1.json');
export const HOOK_COMMAND_MARKER = 'devin-autogit ship';

export const hookEntrySchema = z
  .object({
    type: z.literal('command'),
    command: z.string(),
    timeout: z.number().int().positive().optional(),
  })
  .passthrough();

export const matcherEntrySchema = z
  .object({
    matcher: z.string().default(''),
    hooks: z.array(hookEntrySchema).default([]),
  })
  .passthrough();

export const hooksFileSchema = z.record(z.string(), z.array(matcherEntrySchema));

export type HookEntry = z.infer<typeof hookEntrySchema>;
export type MatcherEntry = z.infer<typeof matcherEntrySchema>;
export type HooksFile = z.infer<typeof hooksFileSchema>;

export function hooksFilePath(repoRoot: string): string {
  return join(repoRoot, HOOKS_FILE_RELPATH);
}

export function readHooksFile(filePath: string): HooksFile {
  if (!existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${filePath}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`invalid JSON in ${filePath}`);
  }
  const parsed = hooksFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`invalid hooks file ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Write atomically: write to a temp file in the same directory, then rename. */
export function writeHooksFile(filePath: string, hooks: HooksFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(hooks, null, 2) + '\n');
  renameSync(tmp, filePath);
}

export interface InstallHookOptions {
  events?: string[];
  timeout?: number;
}

/** A hook is ours if it invokes `devin-autogit ship` directly or via a node path. */
export function isOurHookCommand(command: string, marker: string = HOOK_COMMAND_MARKER): boolean {
  return command.includes(marker) || / ship --quiet( --json)?$/.test(command.trim());
}

function hasOurHook(entries: MatcherEntry[], marker: string): boolean {
  return entries.some((entry) =>
    entry.hooks.some((hook) => isOurHookCommand(hook.command, marker)),
  );
}

/**
 * Add a matcher entry running `command` for each event (default: Stop).
 * Idempotent: skips events that already contain a hook matching the marker.
 * All other hooks and events are preserved.
 */
export function installStopHook(
  hooks: HooksFile,
  command: string,
  options: InstallHookOptions = {},
): { hooks: HooksFile; installed: string[] } {
  const events = options.events ?? ['Stop'];
  const timeout = options.timeout ?? 120;
  const next: HooksFile = { ...hooks };
  const installed: string[] = [];
  for (const event of events) {
    const entries = next[event] ?? [];
    if (hasOurHook(entries, HOOK_COMMAND_MARKER)) continue;
    next[event] = [...entries, { matcher: '', hooks: [{ type: 'command', command, timeout }] }];
    installed.push(event);
  }
  return { hooks: next, installed };
}

/**
 * Remove entries whose hooks contain `commandMarker` from every event.
 * Entries with a mix of ours and other hooks keep the other hooks.
 */
export function uninstallStopHook(
  hooks: HooksFile,
  commandMarker: string = HOOK_COMMAND_MARKER,
): { hooks: HooksFile; removed: string[] } {
  const next: HooksFile = {};
  const removed: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    const kept: MatcherEntry[] = [];
    for (const entry of entries) {
      const otherHooks = entry.hooks.filter(
        (hook) => !isOurHookCommand(hook.command, commandMarker),
      );
      if (otherHooks.length === entry.hooks.length) {
        kept.push(entry);
      } else {
        removed.push(event);
        if (otherHooks.length > 0) kept.push({ ...entry, hooks: otherHooks });
      }
    }
    if (kept.length > 0) next[event] = kept;
  }
  return { hooks: next, removed };
}
