import { describe, expect, it } from 'vitest';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../../src/core/output.js';

describe('Output', () => {
  it('writes informational messages to stderr only', () => {
    const err: string[] = [];
    const outLines: string[] = [];
    const out = new Output({
      json: true,
      stderr: (l) => err.push(l),
      stdout: (l) => outLines.push(l),
    });
    out.info('hello');
    out.warn('careful');
    out.error('boom');
    expect(err).toEqual([
      'devin-autogit: hello',
      'devin-autogit: warning: careful',
      'devin-autogit: error: boom',
    ]);
    expect(outLines).toEqual([]);
  });

  it('emits JSON results on stdout only when json is enabled', () => {
    const outLines: string[] = [];
    const out = new Output({ json: true, stderr: () => {}, stdout: (l) => outLines.push(l) });
    out.result({ ok: true, action: 'ship', shipped: true });
    expect(JSON.parse(outLines[0] as string)).toEqual({ ok: true, action: 'ship', shipped: true });
  });

  it('suppresses JSON results when json is disabled', () => {
    const outLines: string[] = [];
    const out = new Output({ json: false, stderr: () => {}, stdout: (l) => outLines.push(l) });
    out.result({ ok: true, action: 'ship' });
    expect(outLines).toEqual([]);
  });

  it('exports exit-code discipline constants', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_CONFIG_ERROR).toBe(1);
  });
});
