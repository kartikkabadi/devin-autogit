import { Git } from '../core/git.js';
import { ConfigError, resolveConfig } from '../core/config.js';
import { Output, EXIT_OK, EXIT_CONFIG_ERROR } from '../core/output.js';
import { detectDevinSession } from '../devin/session.js';

export interface DoctorOptions {
  json: boolean;
  remote: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDoctor(opts: DoctorOptions, cwd = process.cwd()): number {
  const out = new Output({ json: opts.json });
  const git = new Git(cwd);
  const checks: Check[] = [];

  const gitVersion = git.exec(['--version']);
  checks.push({
    name: 'git-installed',
    ok: gitVersion.ok,
    detail: gitVersion.ok ? gitVersion.stdout.trim() : 'git not found on PATH',
  });

  const inRepo = git.isRepo();
  checks.push({
    name: 'in-repo',
    ok: inRepo,
    detail: inRepo ? (git.repoRoot() ?? '') : 'not inside a git repository',
  });

  if (inRepo) {
    const identityName = git.exec(['config', 'user.name']);
    const identityEmail = git.exec(['config', 'user.email']);
    checks.push({
      name: 'git-identity',
      ok: identityName.ok && identityEmail.ok,
      detail:
        identityName.ok && identityEmail.ok
          ? `${identityName.stdout.trim()} <${identityEmail.stdout.trim()}>`
          : 'user.name / user.email not configured',
    });

    const hasRemote = git.hasRemote(opts.remote);
    checks.push({
      name: 'remote-configured',
      ok: hasRemote,
      detail: hasRemote
        ? (git.remoteUrl(opts.remote) ?? '')
        : `remote "${opts.remote}" not configured`,
    });

    if (hasRemote) {
      const lsRemote = git.exec(['ls-remote', '--heads', opts.remote]);
      checks.push({
        name: 'remote-access',
        ok: lsRemote.ok,
        detail: lsRemote.ok ? 'remote reachable and readable' : lsRemote.stderr.trim(),
      });
    }

    const root = git.repoRoot();
    if (root !== null) {
      try {
        const config = resolveConfig(root);
        checks.push({
          name: 'config-valid',
          ok: true,
          detail: config.enabled ? 'enabled' : 'valid but not enabled (run `devin-autogit on`)',
        });
      } catch (err) {
        if (err instanceof ConfigError) {
          checks.push({ name: 'config-valid', ok: false, detail: err.message });
        } else {
          throw err;
        }
      }
    }
  }

  const detection = detectDevinSession({ repoRoot: inRepo ? git.repoRoot() : null });
  checks.push({
    name: 'devin-detection',
    ok: true,
    detail: detection.isDevin
      ? `Devin detected (${detection.signals.join(', ')}) — ${
          detection.autonomous ? 'autonomous fail-closed mode' : 'interactive mode'
        }`
      : 'no Devin environment detected — interactive defaults',
  });

  for (const check of checks) {
    out.info(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  out.result({ ok: allOk, action: 'doctor', checks });
  return allOk ? EXIT_OK : EXIT_CONFIG_ERROR;
}
