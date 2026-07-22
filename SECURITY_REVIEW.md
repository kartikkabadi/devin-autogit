# Security Review — devin-autogit

Reviewed: PR #1 (`feat/full-implementation`, commit `6b250c8`) on 2026-07-22.
Scope: git command construction, secrets scanning/reporting, `undo` / force-with-lease,
config parsing (Zod), `ship --force-secrets` in autonomous mode, `swarm` worktrees/branches,
LLM gate handling.

**Verdict: 7 issues found (4 medium, 3 low). No critical or high-severity issues.**

## Positives

- All git invocations use `spawnSync('git', args)` with argument arrays and no shell
  (`src/core/git.ts:14-19`) — no shell-injection surface.
- `undo` uses `--force-with-lease=refs/heads/<branch>:<expectedSha>` with an explicit
  expected SHA (`src/core/git.ts:154-166`) and refuses to rewind when the remote has moved
  (`src/commands/undo.ts:41-47`), and only undoes commits carrying the
  `Shipped-by: devin-autogit` trailer (`src/commands/undo.ts:25-29`).
- `--force-secrets` is refused in autonomous (Devin + no TTY) mode
  (`src/core/policy.ts:66-71`, detection in `src/devin/session.ts:49`).
- LLM gate is not implemented as a client; when `llmGate.enabled` is set and unavailable
  the policy fails closed (`src/core/policy.ts:118-123`). No diff or API key is ever sent
  anywhere.
- Repo/global config and `.devin` metadata are parsed with strict/validated Zod schemas
  (`src/core/config.ts:8-45`, `src/devin/metadata.ts:6-27`).
- Secret matches are redacted before being reported (`src/core/secrets.ts:85-88`).

## Issues

### 1. (Medium) Unvalidated session ID flows into branch names, refs, and worktree paths

- `subagentBranch()` interpolates `sessionId` directly into branch names
  (`src/devin/swarm.ts:4-6`), which then flow into refspecs like
  `HEAD:refs/heads/${branch}` (`src/core/git.ts:104,134,162`).
- The worktree path is `join(repoRoot, '..', `${sessionId}-agent-${i}`)`
  (`src/devin/swarm.ts:36`). A session ID containing `/` or `..` (from `--session`,
  `DEVIN_SESSION_ID`, or the repo-committed `.devin/session.json` — attacker-controllable
  in a cloned repo) enables path traversal: worktrees can be created at arbitrary
  filesystem locations, and arbitrary ref names can be created/pushed.
- Recommendation: validate session IDs against a strict pattern (e.g.
  `^[A-Za-z0-9._-]+$`) and validate branch names with
  `git check-ref-format --branch` before use.

### 2. (Medium) Git argument injection via values beginning with `-`

- User/config-controlled values (`--remote`, `--into`, branch names, session IDs) are
  passed as positional git arguments without a `--` separator or validation, e.g.
  `checkout <into>` / `checkout -b <into>` (`src/devin/swarm.ts:78-80`),
  `merge --no-ff --no-edit <branch>` (`src/devin/swarm.ts:95`),
  `push <remote> ...` (`src/core/git.ts:103-105`),
  `ls-remote <remote> ...` (`src/core/git.ts:134`).
  A value like `--upload-pack=<cmd>` passed as the remote to `ls-remote`/`push`
  can execute arbitrary commands.
- Recommendation: reject values starting with `-`, and use `--` separators where git
  supports them.

### 3. (Medium) Repo-committed `.devin-autogit.json` can silently weaken policy

- Policy resolution is a shallow spread: `{...base, ...global.policy, ...repo.policy}`
  (`src/core/config.ts:127-131`). Because Zod fills defaults, any repo config with a
  `policy` key fully replaces global `denyPaths`, `protectedBranches`, `maxBytes`, and
  `llmGate` — a committed repo file can disable org-level guards (e.g. `denyPaths: []`,
  `llmGate.enabled: false`).
- `enabled` defaults to `true` (`src/core/config.ts:34`), so merely committing an empty
  `{}` `.devin-autogit.json` to a repo enables auto-ship for anyone who clones it.
- Recommendation: default `enabled` to `false`; treat global policy as a floor that repo
  config can only tighten (union deny lists, min of size caps, never disable llmGate).

### 4. (Medium) `undo` ignores protected branches when rewinding the remote

- `runUndo` never loads config or checks `protectedBranches`
  (`src/commands/undo.ts:39-59`). If a shipped commit is at the tip of `main` (e.g.
  policy weakened per issue 3, or env override), `undo` will force-with-lease rewind
  the remote default branch — remote history rewrite on a protected branch.
- Recommendation: evaluate the branch gate in `undo` as well, and refuse remote rewinds
  on protected branches without an explicit interactive override.

### 5. (Low) Redaction reveals up to 12 characters of a detected secret

- `redact()` keeps the first 8 and last 4 characters (`src/core/secrets.ts:85-88`), and
  findings (including the redacted match) are emitted in warnings and in the `--json`
  `holds[].details.findings` payload (`src/core/policy.ts:97-103`,
  `src/commands/ship.ts:92-103`), which agents commonly log. For short tokens this
  leaks a meaningful fraction of the secret.
- Recommendation: report only kind + file + line number; if a sample is needed, show at
  most the first 4 characters or a hash.

### 6. (Low) Environment variables can weaken policy in autonomous contexts

- `DEVIN_AUTOGIT_PROTECTED_BRANCHES` *replaces* (rather than extends) the protected list,
  and `DEVIN_AUTOGIT_ENABLED=1` force-enables shipping (`src/core/config.ts:133-142`).
  An autonomous agent controls its own environment, so these overrides bypass the
  fail-closed posture the tool otherwise enforces.
- Recommendation: make env overrides tightening-only (union protected branches; allow
  `=0` to disable but not `=1` to enable) or ignore weakening overrides when
  `detection.autonomous` is true.

### 7. (Low) Raw git stderr / remote URLs echoed to output

- Push failures echo raw `stderr` (`src/commands/ship.ts:155,163`) and `doctor` prints
  `remote get-url` output verbatim (`src/commands/doctor.ts:53`). Remote URLs with
  embedded credentials (`https://user:token@host/...`) would leak into agent logs.
- Recommendation: strip userinfo from URLs before printing (both in doctor output and in
  any git stderr that is surfaced).

## Summary

| # | Severity | Area |
|---|----------|------|
| 1 | Medium | swarm: session-ID injection into branches/refs/worktree paths |
| 2 | Medium | git argument injection via `-`-prefixed values |
| 3 | Medium | repo config can weaken global policy; `enabled` defaults true |
| 4 | Medium | `undo` can force-rewind protected branches |
| 5 | Low | secret redaction reveals up to 12 chars in logs/JSON |
| 6 | Low | env overrides can weaken policy autonomously |
| 7 | Low | credentialed remote URLs may leak via stderr/doctor |
