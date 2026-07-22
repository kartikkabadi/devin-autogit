# Devin-AutoGit

A Devin-aware CLI that automates stage → secrets scan → commit → push for AI coding agents.
See [DESIGN.md](DESIGN.md) for the full design.

## Install

```bash
npm install
npm run build
node bin/devin-autogit --help
```

Or link it globally:

```bash
npm link   # makes `devin-autogit` available on PATH
```

Requires Node ≥ 20 and git.

## Quick Start

```bash
devin-autogit setup            # detect environment, write ~/.devin-autogit/config.json
cd your-repo
devin-autogit on --public-ok   # opt this repo in (writes .devin-autogit.json)
devin-autogit ship -m "msg"    # stage → scan → gate → commit → push
```

## Commands

| Command                                                    | Description                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `setup`                                                    | Detect environment (Devin vs. generic) and write the global config                    |
| `on [--policy <file>] [--public-ok] [--with-hooks]`        | Enable auto-ship in the current repo; `--with-hooks` also installs the Devin CLI hook |
| `off`                                                      | Disable auto-ship (removes `.devin-autogit.json` and any installed Devin CLI hook)    |
| `ship [-m msg] [--quiet] [--checkpoint] [--force-secrets]` | Stage → secrets scan → policy gate → commit (Devin trailers) → push with rebase-retry |
| `hook install [--bin <path>] [--file <path>]`              | Install a Devin CLI `Stop`/`SessionEnd` hook that runs `ship` after each turn         |
| `hook uninstall [--file <path>]`                           | Remove the devin-autogit hook entries from `.devin/hooks.v1.json`                     |
| `undo`                                                     | Rewind the last devin-autogit commit (remote force-with-lease + local mixed reset)    |
| `status`                                                   | Version, enablement, Devin detection, policy summary, swarm info (`--json` supported) |
| `checkpoint [label]`                                       | Record a `refs/devin-autogit/checkpoints/<timestamp>[-label]` ref                     |
| `swarm init [task] [--agents N]`                           | Create per-subagent worktrees + branches `devin/<task-slug>/agent-<n>`                |
| `swarm collect [--into <branch>]`                          | Merge shipped subagent branches into an integration branch, fail-closed on conflicts  |
| `doctor`                                                   | Diagnose git auth, remote access, Devin env detection, config validity                |

Global flags: `--json` (machine-readable result on stdout; all logs go to stderr) and
`--dry-run` (show what would happen without changing anything).

## How `ship` works

1. Silent no-op unless the repo is opted in via `.devin-autogit.json`.
2. `git add -A`, then a secrets scan over the staged **added lines** (AWS/OpenAI/Anthropic/
   GitHub/Slack/Google keys, private key blocks, JWTs, sensitive filenames) with
   template-file (`.example/.sample/.template/.dist`) and placeholder exemptions.
3. Policy gate: protected branches (`main`/`master` by default), deny-path globs
   (`**/.env*`, `**/*.pem`, …), size caps (300 files / 1 MB by default).
4. Commit subject from `-m` > Devin task metadata > file list (72-char cap), with trailers:

   ```
   Devin-Session: devin-<id>
   Devin-Task: <task-slug>
   Shipped-by: devin-autogit
   ```

5. Push; on non-fast-forward rejection, fetch + rebase + retry once.

If **any** gate fails, the changes are **held** — nothing is committed or discarded, the
working tree is preserved, a `--json` explanation is printed, and the exit code is **0**
so an agent's turn is never broken. Exit code 1 is reserved for configuration/user errors.

## Safety Model (fail-closed)

Devin-AutoGit detects Devin sessions via env vars (`DEVIN_SESSION_ID`, `DEVIN_ID`), a
`.devin/` directory, or VM markers. In a detected Devin session **without a TTY**
(autonomous mode), every gate fails closed:

- Any secrets hit, policy violation, protected branch, or oversized diff → **hold**.
- `--force-secrets` is **refused** in autonomous mode — a human TTY is required.
- The optional LLM gate holds (rather than ships) when it is unavailable.
- `undo` refuses commits without the `Shipped-by: devin-autogit` trailer and refuses to
  rewind a remote that has moved past the shipped commit.

## Configuration

- Repo: `.devin-autogit.json` (written by `on`), validated with Zod.
- Global: `~/.devin-autogit/config.json` (written by `setup`).
- Env overrides: `DEVIN_AUTOGIT_PROTECTED_BRANCHES`, `DEVIN_AUTOGIT_MAX_FILES`,
  `DEVIN_AUTOGIT_MAX_BYTES`, `DEVIN_AUTOGIT_ENABLED`, `DEVIN_AUTOGIT_HOME`.
- Precedence: env > repo > global > defaults.
- `.devin/session.json` and `.devin/blueprint.yaml` (if present) contribute session ID,
  task title, and branch/protection conventions.

## Development

```bash
npm run build      # tsc → dist/
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest (unit + temp-repo integration tests; builds first)
```
