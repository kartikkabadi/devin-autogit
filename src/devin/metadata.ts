import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const sessionJsonSchema = z
  .object({
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    task: z.string().optional(),
    task_title: z.string().optional(),
  })
  .passthrough();

export const blueprintSchema = z
  .object({
    name: z.string().optional(),
    task: z.string().optional(),
    conventions: z
      .object({
        branch_prefix: z.string().optional(),
        protected_branches: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface DevinMetadata {
  sessionId: string | null;
  task: string | null;
  branchPrefix: string | null;
  protectedBranches: string[] | null;
  sources: string[];
}

export function emptyMetadata(): DevinMetadata {
  return { sessionId: null, task: null, branchPrefix: null, protectedBranches: null, sources: [] };
}

export function readDevinMetadata(repoRoot: string): DevinMetadata {
  const meta = emptyMetadata();
  const devinDir = join(repoRoot, '.devin');

  const sessionPath = join(devinDir, 'session.json');
  if (existsSync(sessionPath)) {
    try {
      const parsed = sessionJsonSchema.safeParse(JSON.parse(readFileSync(sessionPath, 'utf8')));
      if (parsed.success) {
        meta.sessionId = parsed.data.session_id ?? parsed.data.sessionId ?? null;
        meta.task = parsed.data.task ?? parsed.data.task_title ?? null;
        meta.sources.push('.devin/session.json');
      }
    } catch {
      // fail-closed elsewhere; unreadable metadata is simply ignored here
    }
  }

  const blueprintPath = join(devinDir, 'blueprint.yaml');
  if (existsSync(blueprintPath)) {
    try {
      const parsed = blueprintSchema.safeParse(parseYaml(readFileSync(blueprintPath, 'utf8')));
      if (parsed.success) {
        if (meta.task === null && parsed.data.task) meta.task = parsed.data.task;
        if (parsed.data.conventions?.branch_prefix) {
          meta.branchPrefix = parsed.data.conventions.branch_prefix;
        }
        if (parsed.data.conventions?.protected_branches) {
          meta.protectedBranches = parsed.data.conventions.protected_branches;
        }
        meta.sources.push('.devin/blueprint.yaml');
      }
    } catch {
      // ignore unparseable blueprint
    }
  }

  return meta;
}

/** Short, commit-trailer-safe slug for a task title. */
export function taskSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
