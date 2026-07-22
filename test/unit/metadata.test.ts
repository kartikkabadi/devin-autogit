import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDevinMetadata, taskSlug } from '../../src/devin/metadata.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devin-autogit-meta-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readDevinMetadata', () => {
  it('returns empty metadata when .devin is absent', () => {
    const meta = readDevinMetadata(dir);
    expect(meta.sessionId).toBeNull();
    expect(meta.task).toBeNull();
    expect(meta.sources).toEqual([]);
  });

  it('reads session.json', () => {
    mkdirSync(join(dir, '.devin'));
    writeFileSync(
      join(dir, '.devin', 'session.json'),
      JSON.stringify({ session_id: 'devin-123', task: 'Fix the parser' }),
    );
    const meta = readDevinMetadata(dir);
    expect(meta.sessionId).toBe('devin-123');
    expect(meta.task).toBe('Fix the parser');
    expect(meta.sources).toContain('.devin/session.json');
  });

  it('reads blueprint.yaml conventions', () => {
    mkdirSync(join(dir, '.devin'));
    writeFileSync(
      join(dir, '.devin', 'blueprint.yaml'),
      [
        'name: my-project',
        'task: Ship the feature',
        'conventions:',
        '  branch_prefix: devin/',
        '  protected_branches:',
        '    - main',
        '    - release',
      ].join('\n'),
    );
    const meta = readDevinMetadata(dir);
    expect(meta.task).toBe('Ship the feature');
    expect(meta.branchPrefix).toBe('devin/');
    expect(meta.protectedBranches).toEqual(['main', 'release']);
  });

  it('session.json task wins over blueprint task', () => {
    mkdirSync(join(dir, '.devin'));
    writeFileSync(join(dir, '.devin', 'session.json'), JSON.stringify({ task: 'From session' }));
    writeFileSync(join(dir, '.devin', 'blueprint.yaml'), 'task: From blueprint');
    expect(readDevinMetadata(dir).task).toBe('From session');
  });

  it('ignores unparseable files', () => {
    mkdirSync(join(dir, '.devin'));
    writeFileSync(join(dir, '.devin', 'session.json'), '{broken');
    const meta = readDevinMetadata(dir);
    expect(meta.sessionId).toBeNull();
  });
});

describe('taskSlug', () => {
  it('slugifies and caps length', () => {
    expect(taskSlug('Fix the Parser!! Now')).toBe('fix-the-parser-now');
    expect(taskSlug('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});
