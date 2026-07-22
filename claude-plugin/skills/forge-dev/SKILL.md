---
name: forge-dev
description: Day-to-day operation of a forge dev stack — start/stop/restart, logs, config changes, port discovery, what not to commit. Use for routine "run the stack", "check the logs", "add a process", or "change a port" requests in a forge-managed project.
---

# Forge daily operation

All commands are CWD-aware: run from the project root to scope to that project.

| Intent | Command |
|---|---|
| Start / stop / restart the stack | `forge up` · `forge down` · `forge restart` |
| One process's live output | `forge logs <process> -f` (`-n 200` for more history) |
| What's running, which ports | `forge status` |
| Web dashboard (all terminals, controls) | `forge open` → localhost:2525 |
| Env vars forge injects | `forge env` |
| Shared container health | `forge service` |

## Rules that prevent lost afternoons

- **After any `.forge/config.json` edit, run `forge reload`.** Restart alone
  does not re-read the config or reallocate ports/services.
- **Never commit `.env.forge`** — machine-specific, regenerated on every sync.
  It should already be gitignored; keep it that way.
- **Write commands portably**: `$PORT`/`${PORT}` in config commands is expanded
  by forge itself on every OS — never hand-write `%PORT%` for Windows.
  Use `corepack yarn` (not bare `yarn`) when the repo pins a yarn version.
- **Ports come from `.env.forge`, not from memory.** Sibling processes discover
  each other via `portExportEnv` names (e.g. `WMW_API_PORT`) — read the file
  instead of assuming 3000/8000 defaults.
- **Codegen after API changes**: check the project's CLAUDE.md for regeneration
  steps (e.g. regenerating a typed client from the backend's OpenAPI spec after
  changing routes) — stale clients fail at runtime, not build time.
- Adding a process: give it `ports` candidates + a unique `portExportEnv` if
  siblings need to find it; `dependsOn`/`waitFor` only when startup order truly
  matters.

## Verifying "it works"

`forge status` says processes are alive, not that the app works. The cheap
end-to-end check is one real request through the front door (dev-server proxy →
API → database), e.g. the project's dev login. Run `scripts/verify-stack.js`
from this plugin for a port-level sweep.
