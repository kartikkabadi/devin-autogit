import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cliJson, git, makeFixture, type Fixture } from './helpers.js';

let fix: Fixture;

afterEach(() => {
  rmSync(fix.root, { recursive: true, force: true });
});

describe('checkpoint (integration)', () => {
  it('writes a namespaced checkpoint ref pointing at HEAD', () => {
    fix = makeFixture();
    const result = cliJson(fix, ['checkpoint', 'before-risky']);
    const ref = result['ref'] as string;
    expect(ref).toMatch(/^refs\/devin-autogit\/checkpoints\/.*-before-risky$/);

    const head = git(fix, ['rev-parse', 'HEAD']).stdout.trim();
    const refSha = git(fix, ['rev-parse', ref]).stdout.trim();
    expect(refSha).toBe(head);
  });

  it('works without a label', () => {
    fix = makeFixture();
    const result = cliJson(fix, ['checkpoint']);
    expect(result['ref']).toMatch(/^refs\/devin-autogit\/checkpoints\//);
  });
});
