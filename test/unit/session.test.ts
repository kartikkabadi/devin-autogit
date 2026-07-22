import { describe, expect, it } from 'vitest';
import { detectDevinSession } from '../../src/devin/session.js';

describe('detectDevinSession', () => {
  it('detects via DEVIN_SESSION_ID env var', () => {
    const d = detectDevinSession({
      env: { DEVIN_SESSION_ID: 'devin-abc' },
      fsExists: () => false,
      isTty: false,
    });
    expect(d.isDevin).toBe(true);
    expect(d.sessionId).toBe('devin-abc');
    expect(d.autonomous).toBe(true);
    expect(d.signals).toContain('env:DEVIN_SESSION_ID');
  });

  it('detects via .devin directory in the repo', () => {
    const d = detectDevinSession({
      env: {},
      repoRoot: '/repo',
      fsExists: (p) => p === '/repo/.devin',
      isTty: false,
    });
    expect(d.isDevin).toBe(true);
    expect(d.sessionId).toBeNull();
    expect(d.signals).toContain('repo:.devin');
  });

  it('detects via VM marker', () => {
    const d = detectDevinSession({ env: {}, fsExists: (p) => p === '/opt/.devin', isTty: false });
    expect(d.isDevin).toBe(true);
    expect(d.signals).toContain('vm:/opt/.devin');
  });

  it('reports non-Devin when no signals', () => {
    const d = detectDevinSession({ env: {}, fsExists: () => false, isTty: false });
    expect(d.isDevin).toBe(false);
    expect(d.autonomous).toBe(false);
  });

  it('is not autonomous with a TTY even when Devin is detected', () => {
    const d = detectDevinSession({
      env: { DEVIN_ID: 'devin-xyz' },
      fsExists: () => false,
      isTty: true,
    });
    expect(d.isDevin).toBe(true);
    expect(d.autonomous).toBe(false);
  });
});
