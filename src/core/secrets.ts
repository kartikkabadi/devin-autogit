/**
 * Secrets scan over staged added lines, ported (behaviorally) from AutoGit:
 * provider key patterns, private key blocks, JWTs, sensitive filenames,
 * with template-file and placeholder-token exemptions.
 */

export interface SecretFinding {
  file: string;
  kind: string;
  line?: number;
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { kind: 'aws-access-key', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'aws-secret-key', regex: /\baws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
  { kind: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'openai-key', regex: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'github-token', regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: 'github-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    kind: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'generic-assignment',
    regex: /\b(api[_-]?key|secret|token|password|passwd)\s*[=:]\s*['"][A-Za-z0-9/+_-]{20,}['"]/i,
  },
];

const SENSITIVE_FILENAME = /(^|\/)\.env(\.[A-Za-z0-9._-]+)?$/;
const TEMPLATE_EXT = /\.(example|sample|template|dist|fake|placeholder)(\.[A-Za-z0-9]+)?$/i;
const TEMPLATE_INFIX = /\.(example|sample|template|fake|placeholder)\./i;
const TEMPLATE_DIR = /(^|\/)(examples?|samples?|templates?|fakes?|placeholders?)\//i;

const PLACEHOLDER =
  /\b(your|my|xxx+|dummy|changeme|replace(me)?)\b|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}/i;

/** Example/template files, identified by path only — never by secret value. */
export function isTemplatePath(path: string): boolean {
  return TEMPLATE_EXT.test(path) || TEMPLATE_INFIX.test(path) || TEMPLATE_DIR.test(path);
}

export function isSensitiveFilename(path: string): boolean {
  return SENSITIVE_FILENAME.test(path) && !isTemplatePath(path);
}

export function isPlaceholderLine(line: string): boolean {
  return PLACEHOLDER.test(line);
}

export function scanLine(file: string, line: string, lineNumber?: number): SecretFinding | null {
  if (isTemplatePath(file)) return null;
  for (const pattern of PATTERNS) {
    const m = pattern.regex.exec(line);
    if (m) {
      if (pattern.kind === 'generic-assignment' && isPlaceholderLine(line)) continue;
      return { file, kind: pattern.kind, ...(lineNumber !== undefined ? { line: lineNumber } : {}) };
    }
  }
  return null;
}

export function scanAddedLines(
  addedLines: Array<{ file: string; line: string; lineNumber?: number }>,
  stagedFiles: string[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of stagedFiles) {
    if (isSensitiveFilename(file)) {
      findings.push({ file, kind: 'sensitive-filename' });
    }
  }
  for (const { file, line, lineNumber } of addedLines) {
    const finding = scanLine(file, line, lineNumber);
    if (finding) findings.push(finding);
  }
  return findings;
}
