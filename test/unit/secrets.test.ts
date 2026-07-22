import { describe, expect, it } from 'vitest';
import {
  isSensitiveFilename,
  isTemplatePath,
  scanAddedLines,
  scanLine,
} from '../../src/core/secrets.js';

describe('secrets scan', () => {
  it('flags real-looking provider keys', () => {
    const cases: Array<[string, string]> = [
      ['aws-access-key', 'key = AKIAIOSFODNN7EXAMPL2'],
      ['openai-key', 'OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx1234'],
      ['anthropic-key', 'sk-ant-abcdefghijklmnopqrstuvwx'],
      ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      ['slack-token', 'xoxb-1234567890-abcdef'],
      ['google-api-key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
      ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----'],
    ];
    for (const [kind, line] of cases) {
      const finding = scanLine('src/app.ts', line);
      expect(finding, line).not.toBeNull();
      expect(finding?.kind).toBe(kind);
    }
  });

  it('flags JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scanLine('src/auth.ts', `const token = '${jwt}';`)?.kind).toBe('jwt');
  });

  it('exempts template files', () => {
    expect(isTemplatePath('.env.example')).toBe(true);
    expect(isTemplatePath('config.sample.json')).toBe(true);
    expect(scanLine('.env.example', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBeNull();
  });

  it('exempts placeholder tokens in generic assignments', () => {
    expect(scanLine('src/config.ts', 'apiKey: "your-api-key-goes-here-please"')).toBeNull();
    expect(scanLine('src/config.ts', 'password = "${DB_PASSWORD_FROM_ENV_X}"')).toBeNull();
  });

  it('flags generic high-entropy assignments', () => {
    expect(scanLine('src/config.ts', 'api_key = "q7Rf2LmXa9Bc4Dw8Ez1GhJkPnQvTs6Yu"')?.kind).toBe(
      'generic-assignment',
    );
  });

  it('flags sensitive filenames but not templates', () => {
    expect(isSensitiveFilename('.env')).toBe(true);
    expect(isSensitiveFilename('config/.env.production')).toBe(true);
    expect(isSensitiveFilename('.env.example')).toBe(false);
    expect(isSensitiveFilename('src/env.ts')).toBe(false);
  });

  it('scanAddedLines combines filename and content findings', () => {
    const findings = scanAddedLines(
      [{ file: 'src/x.ts', line: 'token = ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
      ['src/x.ts', '.env'],
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(['github-token', 'sensitive-filename']);
  });

  it('redacts matches in findings', () => {
    const findings = scanAddedLines(
      [{ file: 'a.ts', line: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
      ['a.ts'],
    );
    expect(findings[0]?.match).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
