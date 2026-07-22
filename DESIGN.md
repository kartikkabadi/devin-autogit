# Devin-AutoGit — Design Document

A Devin-aware clone and improvement of [AutoGit](https://github.com/davidondrej/autogit): a Node.js/TypeScript CLI that automates stage → secrets scan → commit → push for AI coding agents, purpose-built for Devin sessions and agent-swarm workflows.

## 1. Goals

- Keep AutoGit's core value: every completed agent turn ships automatically, with a secrets scan and one-command undo.
- Make it Devin-native: detect Devin sessions, read Devin metadata, generate session-traceable commit messages, and integrate with Devin checkpoints/worktrees.
- Flip the safety default for autonomous runs: **fail-closed** (hold, don't ship) whenever anything is uncertain — the opposite of AutoGit's fail-open agent mode, which is the right default for interactive humans but wrong for unattended Devin swarms.
- Stay minimal and maintainable: small TypeScript codebase, few well-chosen dependencies, thorough unit tests.

## 2. What AutoGit Does Today (Reference Analysis)

From the upstream source (`index.js`, ~1200 lines, zero-dependency ESM Node ≥18):

- **Commands**: `setup` (wire Claude Code / Codex / Cursor / Pi lifecycle hooks globally), `on`/`off` (per-repo opt-in via `.autogit.json`), `ship` (stage → scan → commit → push), `undo` (rewind last autogit commit, remote + local), `busy` (mid-turn marker), `status`, `update`.
- **Safety model**: per-repo opt-in; secrets scan on staged added lines (AWS/OpenAI/Anthropic/GitHub/Slack/Google keys, private key blocks, `.env` filenames, JWTs) with template-file and placeholder exemptions; public-repo warning at `on`; multi-account pinning; `Shipped-by: autogit` trailer enabling `undo`; non-fast-forward self-heal via fetch+rebase+retry.
- **Agent mode**: optional LLM gate (OpenRouter) reviews each diff and decides ship-or-hold; **fails open** on any API trouble.
- **Parallel agents**: busy markers under `<git-dir>/autogit-busy/<session-id>` with PID-liveness + TTL backstop; last finisher ships everything; worktrees isolate markers per checkout.
- **Commit subjects**: `-m` > LLM message > the turn's user prompt (secret-scanned) > agent final message > file-list fallback; 72-char flattened; all output on stderr so hook stdout parsing never breaks.

## 3. What Devin-AutoGit Improves

| Area | AutoGit | Devin-AutoGit |
| --- | --- | --- |
| Target agents | Claude Code, Codex, Cursor, Pi (local hooks) | Devin sessions first; generic agents via `ship` CLI |
| Failure posture | Fails open (ship on doubt) | **Fails closed** (hold on doubt) in autonomous mode |
| Language | Untyped JS single file | TypeScript, modular `src/`, typed config via Zod |
| Session context | Hook payload prompt scraping | Devin session ID/task from env + `.devin/` metadata |
| Commit traceability | `Shipped-by: autogit` trailer | `Devin-Session:`, `Devin-Task:`, `Shipped-by: devin-autogit` trailers |
| Multi-agent | Busy markers in one checkout | First-class branch-per-subagent swarm workflow + worktree helpers |
| Approval | Optional LLM gate | Policy engine: allow/deny globs, size caps, protected branches, optional LLM gate |

## 4. Architecture

Minimalist layered TypeScript CLI:

```
bin/devin-autogit  →  src/cli.ts (Commander.js command registry)
                         │
                         ▼
                   src/commands/*.ts   one file per command, thin orchestration
                         │
        ┌────────────────┼──────────────────┐
        ▼                ▼                  ▼
  src/core/git.ts   src/core/policy.ts  src/devin/*.ts
  (child_process    (fail-closed        (session detection,
   git wrapper,      approval engine)    metadata, checkpoints,
   trailers, undo)                       swarm/worktrees)
        ▼                ▼
  src/core/secrets.ts  src/core/config.ts (Zod schemas: repo .devin-autogit.json
  (pattern scan,        + global ~/.devin-autogit/config.json + env overrides)
   ported from autogit)
```

Principles:
- **Pure core, thin shell**: `core/` and `devin/` modules are pure functions over injected exec/fs interfaces → trivially unit-testable without a real repo.
- **child_process git** (like upstream) rather than simple-git: keeps the dependency surface tiny, output handling explicit, and behavior identical to what agents run manually.
- **Everything informational on stderr**, machine-readable results (`--json`) on stdout — same discipline as upstream so hook consumers can parse stdout safely.
- **Exit codes**: 0 = shipped or clean no-op/held (never break the agent's turn), 1 = configuration/user error, 2 reserved (never used — some hosts treat exit 2 specially).

## 5. Commands

| Command | Description |
| --- | --- |
| `devin-autogit setup` | Detect environment (Devin vs. generic), write global config, print how to wire the ship step (e.g. as a Devin blueprint/AGENTS instruction or a post-turn hook). |
| `devin-autogit on [--policy <file>] [--public-ok]` | Enable auto-ship in the current repo (writes `.devin-autogit.json`); public-repo guard; fail-closed policy defaults for non-TTY (agent) invocations. |
| `devin-autogit off` | Disable auto-ship in the repo. |
| `devin-autogit ship [-m msg] [--dry-run] [--json]` | Stage → secrets scan → policy gate → commit (Devin trailers) → push, with non-fast-forward rebase-retry. Fail-closed: any gate failure holds (exit 0, changes kept). |
| `devin-autogit undo` | Take back the last devin-autogit commit — remote rewind (force-with-lease of parent) then local mixed reset; refuses foreign commits. |
| `devin-autogit status [--json]` | Version, repo enablement, Devin session detection, policy summary, held-changes state, swarm branch info. |
| `devin-autogit checkpoint [label]` | Record a lightweight local checkpoint ref (`refs/devin-autogit/checkpoints/<ts>`) before risky operations; aligns with Devin's checkpoint concept. |
| `devin-autogit swarm init <task> [--agents N]` | Create per-subagent worktrees + branches (`devin/<session>/<agent-n>`), each pre-enabled with its own config. |
| `devin-autogit swarm collect [--into <branch>]` | Merge/rebase completed subagent branches into an integration branch, fail-closed on conflicts. |
| `devin-autogit doctor` | Diagnose git auth, remote access, Devin env detection, config validity. |

## 6. Devin-Specific Features

1. **Session detection** (`src/devin/session.ts`): treat the run as a Devin session when any of these are present — `DEVIN_SESSION_ID`/`DEVIN_ID`-style env vars, a `.devin/` directory in the repo, or known Devin VM markers (e.g. `/opt/.devin`, home-dir layout). Detection result drives defaults: autonomous (fail-closed, non-interactive) vs. interactive.
2. **Metadata ingestion** (`src/devin/metadata.ts`): if `.devin/blueprint.yaml` or `.devin/session.json` exists, parse it (YAML via `yaml` pkg, validated with Zod) for session ID, task title, and repo conventions (branch naming, protected branches) — merged into effective config.
3. **Session-traceable commits**: subject derived from the Devin task/step description when available (secret-scanned first, 72-char cap), body carries trailers:
   ```
   Devin-Session: devin-<id>
   Devin-Task: <short task slug>
   Shipped-by: devin-autogit
   ```
   `undo` and `swarm collect` key off these trailers.
4. **Checkpoint integration**: `checkpoint` writes namespaced refs so a Devin session (or its parent) can roll back to any pre-ship state without touching the reflog; `ship --checkpoint` auto-checkpoints before pushing.
5. **Worktree/swarm support**: `swarm init` creates isolated worktrees per subagent with per-worktree config and busy markers (inherited design from upstream — markers live under the resolved git dir, so worktrees never block each other); `swarm collect` integrates branches fail-closed.
6. **Fail-closed autonomous policy**: in a detected Devin session with no TTY, any ambiguity (policy violation, secrets hit, protected branch, oversized diff, LLM gate unavailable) results in **hold** — changes stay staged-pending in the working tree with a machine-readable `--json` explanation the agent can react to. Nothing ships silently on error.

## 7. Safety / Approval Model

Layered gates, all evaluated before any commit is created (order: cheapest → most expensive):

1. **Opt-in**: no `.devin-autogit.json` → silent no-op (exit 0), exactly like upstream.
2. **Branch policy**: never push to configured protected branches (default: `main`, `master` when in autonomous mode — subagents must use `devin/*` branches); configurable via Zod-validated config.
3. **Path policy**: allow/deny globs (e.g. deny `**/.env*`, `**/*.pem`, `infra/**` by default-deny lists); a denied staged path holds the whole ship.
4. **Secrets scan**: ported pattern set from upstream (AWS/OpenAI/Anthropic/GitHub/Slack/Google, private key blocks, JWTs, sensitive filenames) with template-file (`.example/.sample/.template/.dist`) and placeholder-token exemptions. A hit unstages everything and holds. `--force-secrets` exists but is **refused in autonomous mode** — a human TTY is required to override.
5. **Size cap**: diffs above a configurable threshold (default 300 files / 1 MB) hold for review — autonomous mass-changes are the highest-risk failure mode.
6. **Optional LLM gate**: like upstream agent mode, but **fail-closed**: no key, timeout, or unparseable reply → hold with a stderr + `--json` note (upstream fails open; that is safe for a human at a terminal but not for an unattended swarm). Secrets scan always runs before the diff leaves the machine.
7. **Undo & trailers**: every commit carries trailers; `undo` refuses commits it didn't make and remotes that have moved past the shipped commit.

Held changes are never discarded: they remain in the working tree, are re-staged on the next ship, and re-evaluated with the fuller diff.

## 8. Tech Stack

- **TypeScript** (strict), ESM, Node ≥ 20; compiled with `tsc` to `dist/`.
- **Commander.js** for the CLI surface.
- **child_process (`spawnSync`) git calls** wrapped in one typed module (no simple-git — smaller surface, upstream-proven approach).
- **Zod** for repo/global config and `.devin/` metadata validation; **yaml** for `blueprint.yaml` parsing.
- **Vitest** for tests (unit + temp-repo integration).
- Dev tooling: ESLint + Prettier, GitHub Actions CI (lint, typecheck, test on Node 20/22).

## 9. Testing Strategy

- **Unit tests (Vitest)** for pure modules: secrets patterns (real-looking keys blocked, placeholders/templates exempt), policy engine decisions, config precedence (env > repo > global > defaults), commit-subject derivation and trailer formatting, Devin session detection matrix (env var / `.devin` dir / none).
- **Integration tests** against throwaway `git init` repos in temp dirs (with a local bare "origin" remote): full `ship` happy path, hold paths (secrets, protected branch, size cap), `undo` local+remote rewind, non-fast-forward rebase-retry, `swarm init`/`collect` worktree lifecycle.
- **Fail-closed contract tests**: simulate LLM gate outage/timeouts and assert hold-not-ship; assert `--force-secrets` is rejected in autonomous (non-TTY + Devin-detected) mode.
- **Golden `--json` output tests** so agent consumers can rely on the machine-readable schema.
- CI runs lint, `tsc --noEmit`, and the full suite on every PR.

## 10. File Plan

| Path | Purpose |
| --- | --- |
| `package.json` | Package manifest, `bin` entry, scripts (`build`, `test`, `lint`, `typecheck`). |
| `tsconfig.json` | Strict TS config, ESM, `dist/` output. |
| `src/cli.ts` | Commander program: registers all commands, global flags (`--json`, `--dry-run`). |
| `src/commands/setup.ts` | Environment detection + global config bootstrap. |
| `src/commands/on.ts` / `src/commands/off.ts` | Per-repo enable/disable, public-repo guard. |
| `src/commands/ship.ts` | Orchestrates stage → gates → commit → push → rebase-retry. |
| `src/commands/undo.ts` | Trailer-verified remote rewind + local reset. |
| `src/commands/status.ts` | Human + `--json` status report. |
| `src/commands/checkpoint.ts` | Namespaced checkpoint refs. |
| `src/commands/swarm.ts` | `swarm init` / `swarm collect` worktree + branch workflows. |
| `src/commands/doctor.ts` | Diagnostics. |
| `src/core/git.ts` | Typed `spawnSync` git wrapper, trailers, push/rebase helpers. |
| `src/core/secrets.ts` | Secret patterns, template/placeholder exemptions, staged-diff scan. |
| `src/core/policy.ts` | Fail-closed gate engine (branch, path, size, LLM gate). |
| `src/core/config.ts` | Zod schemas + precedence merge (env > repo > global > defaults). |
| `src/core/output.ts` | stderr logging + stdout `--json` result emitter, exit-code discipline. |
| `src/devin/session.ts` | Devin environment detection heuristics. |
| `src/devin/metadata.ts` | `.devin/blueprint.yaml` / `session.json` parsing (yaml + Zod). |
| `src/devin/swarm.ts` | Worktree/branch naming, busy-marker isolation, collect logic. |
| `test/unit/*.test.ts` | Vitest unit tests per core module. |
| `test/integration/*.test.ts` | Temp-repo end-to-end tests (ship/undo/swarm/fail-closed). |
| `.github/workflows/ci.yml` | Lint, typecheck, test on Node 20/22. |
| `README.md` | User-facing docs (quick start, commands, safety). |
| `DESIGN.md` | This document. |
| `LICENSE` | MIT. |
