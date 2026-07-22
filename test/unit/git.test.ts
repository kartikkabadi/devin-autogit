import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Git,
  addToInfoExclude,
  buildCommitMessage,
  deriveSubject,
  formatTrailers,
  hasShippedByTrailer,
  truncateSubject,
} from '../../src/core/git.js';

describe('trailers', () => {
  it('formats all trailers', () => {
    expect(formatTrailers({ session: 'devin-1', task: 'fix-parser' })).toBe(
      'Devin-Session: devin-1\nDevin-Task: fix-parser\nShipped-by: devin-autogit',
    );
  });

  it('omits absent trailers but always includes Shipped-by', () => {
    expect(formatTrailers({})).toBe('Shipped-by: devin-autogit');
  });

  it('builds a full commit message', () => {
    const msg = buildCommitMessage('Fix parser', { session: 'devin-1' });
    expect(msg).toBe('Fix parser\n\nDevin-Session: devin-1\nShipped-by: devin-autogit\n');
  });

  it('detects the Shipped-by trailer', () => {
    expect(hasShippedByTrailer('subj\n\nShipped-by: devin-autogit\n')).toBe(true);
    expect(hasShippedByTrailer('subj\n\nShipped-by: someone-else\n')).toBe(false);
    expect(hasShippedByTrailer('mentions Shipped-by: devin-autogit inline text')).toBe(false);
  });
});

describe('deriveSubject', () => {
  it('prefers the explicit -m message', () => {
    expect(deriveSubject('My message', 'Devin task', ['a.ts'])).toBe('My message');
  });

  it('falls back to the Devin task', () => {
    expect(deriveSubject(undefined, 'Devin task', ['a.ts'])).toBe('Devin task');
  });

  it('falls back to the file list', () => {
    expect(deriveSubject(undefined, undefined, ['a.ts', 'b.ts'])).toBe('Update a.ts, b.ts');
    expect(deriveSubject(undefined, undefined, ['a', 'b', 'c', 'd', 'e'])).toBe(
      'Update a, b, c (+2 more)',
    );
  });

  it('flattens whitespace and caps at 72 chars', () => {
    expect(deriveSubject('line1\nline2\t end', undefined, [])).toBe('line1 line2 end');
    const long = 'x'.repeat(100);
    expect(deriveSubject(long, undefined, []).length).toBe(72);
    expect(truncateSubject(long).endsWith('...')).toBe(true);
  });

  it('has a last-resort subject for empty inputs', () => {
    expect(deriveSubject(undefined, undefined, [])).toBe('devin-autogit: update');
  });
});

describe('addToInfoExclude', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a pattern once, idempotently', () => {
    dir = mkdtempSync(join(tmpdir(), 'devin-autogit-exclude-'));
    execSync('git init', { cwd: dir });
    const git = new Git(dir);
    expect(addToInfoExclude(git, dir, '/.devin-autogit.json')).toBe(true);
    expect(addToInfoExclude(git, dir, '/.devin-autogit.json')).toBe(true);
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\/\.devin-autogit\.json/g)).toHaveLength(1);
    expect(exclude.endsWith('/.devin-autogit.json\n')).toBe(true);
  });
});
