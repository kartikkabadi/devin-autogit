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

  it('flags Stripe keys in real files but exempts template files', () => {
    // Assembled at runtime so no key-shaped literal lands in the repo.
    const body = 'abcdefghijklmnopqrstuvwx';
    const keys = ['sk', 'pk', 'rk'].flatMap((prefix) =>
      ['live', 'test'].map((mode) => [prefix, mode, body].join('_')),
    );
    for (const key of keys) {
      expect(scanLine('src/payments.ts', `const stripeKey = "${key}";`)?.kind, key).toBe(
        'stripe-key',
      );
      expect(scanLine('.env.example', `STRIPE_KEY=${key}`)).toBeNull();
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
    expect(isTemplatePath('README.example.md')).toBe(true);
    expect(isTemplatePath('templates/config.json')).toBe(true);
    expect(isTemplatePath('docs/examples/setup.md')).toBe(true);
    expect(isTemplatePath('.env')).toBe(false);
    expect(isTemplatePath('src/secrets.ts')).toBe(false);
    expect(scanLine('.env.example', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBeNull();
    expect(scanLine('.env.example', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')).toBeNull();
  });

  it('does not exempt secrets in real files just because the value looks like an example', () => {
    expect(scanLine('.env', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')?.kind).toBe(
      'aws-access-key',
    );
    expect(scanLine('src/config.ts', 'api_key = "EXAMPLEq7Rf2LmXa9Bc4Dw8Ez1G"')?.kind).toBe(
      'generic-assignment',
    );
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

  it('scanAddedLines flags an example-looking AWS key in a real .env file', () => {
    const findings = scanAddedLines(
      [{ file: '.env', line: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' }],
      ['.env'],
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(['aws-access-key', 'sensitive-filename']);
  });

  it('scanAddedLines exempts the same value in .env.example', () => {
    const findings = scanAddedLines(
      [{ file: '.env.example', line: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' }],
      ['.env.example'],
    );
    expect(findings).toEqual([]);
  });

  it('scanAddedLines combines filename and content findings', () => {
    const findings = scanAddedLines(
      [{ file: 'src/x.ts', line: 'token = ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
      ['src/x.ts', '.env'],
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(['github-token', 'sensitive-filename']);
  });

  it('never includes the matched secret text in findings', () => {
    const findings = scanAddedLines(
      [{ file: 'a.ts', line: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', lineNumber: 7 }],
      ['a.ts'],
    );
    expect(findings[0]?.kind).toBe('github-token');
    expect(findings[0]?.line).toBe(7);
    expect(JSON.stringify(findings)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
