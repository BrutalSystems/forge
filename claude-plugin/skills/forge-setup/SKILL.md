---
name: forge-setup
description: Set up a forge-orchestrated multi-repo dev stack from scratch on macOS, Linux, or Windows — preflight checks, daemon install, sibling repo assembly, env bootstrap, service provisioning verification, and end-to-end smoke test. Use when onboarding a machine to a forge project, when "forge up" has never worked on this machine, or when the user asks to set up the dev stack.
---

# Forge stack setup

Walk the machine from zero to a verified running stack. **Verify each step before
moving on** — most forge setup failures are silent, and the cost surfaces two
steps later. Do not report the setup complete until the final smoke test passes.

## 0. Read the project first

From the target project root, read:

- `.forge/config.json` — the source of truth. Note every process `cwd` that
  points outside the repo (`../something`): each is a **sibling repo that must
  be cloned**. Note the `services` block: each entry is a shared container that
  will be provisioned.
- `CLAUDE.md` / `README.md` — project-specific env bootstrap (JWT keys, seed
  scripts, dev logins). The project docs win over this skill on specifics.

## 1. Preflight

Check all of these before touching anything (run them; don't assume):

| Check | Command | Requirement |
|---|---|---|
| Node | `node --version` | ≥ 20 |
| corepack (Yarn/pnpm projects) | `command -v corepack` | required whenever any package.json declares `"packageManager": "yarn@X"` or similar. Homebrew's Node 25 ships WITHOUT corepack — install with `npm i -g corepack@latest && corepack enable`, then `corepack prepare yarn@<version> --activate`. Skip on Node ≤ 24 (bundled). |
| Docker daemon | `docker ps` | must succeed, not just be installed |
| uv (Python projects) | `uv --version` | present if any process uses `uv run` |
| GitHub access | `gh auth status` | for cloning private sibling repos |
| Port squatters | `docker ps -a` + `netstat -ano \| grep -E ':(27017\|5672\|6379\|5432\|2525)'` | see below |

**Port squatters are the one genuine decision point.** If an existing container
or process owns a port a forge service needs (27017/5672/6379/5432), STOP and
ask the user: stop the existing container (data survives in its volume), or run
the forge service on a custom port (supported; the connection strings in
`.env.forge` follow automatically). Never stop a container you didn't create
without explicit approval — check what's in it first (`docker exec <c> ...`).

## 2. Install forge + daemon

```
npm install -g @brutalsystems/forge    # or: npm install -g . from a forge checkout
forge install
forge version                          # must print "daemon running"
```

- **Windows**: if `forge install` reports the logon task was denied, it prints
  the exact two `schtasks` commands to run once from an Administrator
  PowerShell. Until that's done, start the daemon detached:
  `Start-Process node -ArgumentList "<forge>/src/daemon/server.js" -WindowStyle Hidden`
  — do NOT leave it as a foreground/session child; if the daemon dies its PTY
  children become orphans that squat on ports.
- **Linux**: `loginctl enable-linger $USER` if the daemon must survive logout.

## 3. Assemble sibling repos

Clone every repo referenced by a `cwd: "../x"` in the config, as siblings of
the project. Prefer `gh repo clone org/x` over SSH URLs — it works with token
auth when SSH keys aren't set up. Verify: every `cwd` path in the config must
resolve to an existing directory.

## 4. Project env bootstrap

Follow the project docs. Generic patterns that recur:

- `.env` from `.env.example` — start clean; watch for "append, don't replace"
  key-generation steps (duplicate keys = whichever loads last wins).
- RSA dev keypairs without `make`:
  `openssl genrsa -out private.pem 2048 && openssl rsa -in private.pem -pubout -out public.pem`
- If a warm worker / jobs client is involved, the m2m signing key env var
  (e.g. `JOBS_JWT_PRIVATE_KEY`) usually needs the **same PEM** as the API's JWT
  key — the consumer validates against the issuer's JWKS. `.env.example` may
  not mention it; the worker crashloop names the missing var.
- JS deps: respect `packageManager` in package.json — use `corepack yarn ...`
  rather than a globally installed yarn.

## 5. Register and start

```
forge add        # from the project root — allocates ports, writes .env.forge
forge up <project>
forge status     # every process "running"
```

Read `.env.forge` after `forge add` and sanity-check the connection strings
(e.g. Mongo replica-set suffix if the project expects one — enable with
`forge service configure mongo --replica-set` BEFORE first `forge up`;
options bake in at container creation).

If you already ran `forge add` before configuring, the recovery is:
`forge service down mongo` → `docker rm forge-mongo` → restart the daemon
(`forge uninstall && forge install`) → then `forge reload` in each project
that uses mongo. The reload re-provisions and rewrites `.env.forge` with
the updated URI (e.g. `?replicaSet=rs0`); without it the file stays stale
even though the container was recreated with the new options.

## 6. Verify provisioning — do not trust silence

`forge status` showing "running" is not proof. Check what was actually provisioned:

- RabbitMQ: `docker exec forge-rabbitmq rabbitmqctl list_vhosts` — the project's
  vhost must be listed. Consumers connected: `rabbitmqctl list_connections vhost user state`.
- Postgres: `docker exec forge-postgres psql -U postgres -lqt` — database exists.
- Mongo replica set: connection with `?replicaSet=rs0` must not hang;
  `docker exec forge-mongo mongosh --quiet --eval "rs.status().ok"` → 1.
- Run `scripts/verify-stack.js` from this plugin in the project root — it
  probes every port and URL in `.env.forge`.

## 7. Seed and smoke test

Run the project's seed scripts (tenants/users). If a CLI password prompt hangs
on Windows, it's `getpass` reading the console instead of stdin — set the
password through the project's service layer in a short script instead.

The pass/fail gate is a real end-to-end request, e.g. login through the dev
server's proxy (`curl -X POST http://localhost:<app-port>/api/.../login ...`
→ 200 with a token). Report the exact commands and results.

## Known failure signatures

| Symptom | Cause → fix |
|---|---|
| Process crashloops, log mentions the literal string `$PORT` | Daemon predates command-var expansion — update forge, restart daemon |
| `schtasks ... unable to switch the encoding` | Old forge wrote UTF-8 task XML — update forge |
| `npm install -g` recurses / PATH overflow | Old forge `prepare` script — update forge, or strip `prepare` from package.json, install, restore |
| AMQP `Connection.OpenOk` crashloop | vhost missing — old forge provisioned silently against a booting broker; create vhost manually or update forge |
| Service "healthy" but app can't authenticate to it | Foreign container on the service's port — the TCP probe lies on old forge; `docker ps` and compare |
| Vite: "Port X is in use, trying another one" | Orphaned process from a dead daemon holds the port — `netstat -ano \| grep <port>`, `taskkill //F //PID <pid>` |
