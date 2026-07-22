# Devin-AutoGit

A Devin-aware CLI that automates stage → secrets scan → commit → push for AI coding agents.
See [DESIGN.md](DESIGN.md) for the full design.

## Install

```bash
npm install
npm run build
node dist/cli.js --help
```

## Commands

| Command      | Description                                           |
| ------------ | ----------------------------------------------------- |
| `setup`      | Detect environment and write global config            |
| `on` / `off` | Enable/disable auto-ship in the current repo          |
| `ship`       | Stage → secrets scan → policy gate → commit → push    |
| `undo`       | Take back the last devin-autogit commit               |
| `status`     | Version, repo enablement, Devin session detection     |
| `checkpoint` | Record a lightweight local checkpoint ref             |
| `swarm`      | Per-subagent worktree/branch workflows (init/collect) |
| `doctor`     | Diagnose git auth, remote access, config validity     |

> All commands are currently placeholders (`Not implemented`).

## Safety

Devin-AutoGit is **fail-closed** in autonomous mode: any uncertainty (secrets hit, policy
violation, protected branch, oversized diff, LLM gate unavailable) results in a **hold** —
changes stay in the working tree and nothing ships silently on error.
