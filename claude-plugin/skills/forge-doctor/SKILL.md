---
name: forge-doctor
description: Diagnose a broken or misbehaving forge dev stack — crashed processes, silent provisioning failures, port conflicts, daemon problems, orphaned processes. Use when "forge up" worked before but something is now failing, a process is crashlooping, or the app can't reach a backing service.
---

# Forge stack diagnosis

Diagnose before mutating. Gather these first, in order — they localize ~90% of
failures:

```
forge version                 # daemon running? CLI/daemon version mismatch?
forge status                  # which process is crashed/stopped?
forge logs <process> -n 40    # the actual error
forge service                 # container health
docker ps -a                  # what ACTUALLY owns the containers/ports
```

## Symptom → cause map

**A process is `crashed`** → `forge logs <process>` and match:

| Log signature | Cause → fix |
|---|---|
| Literal `$PORT` / `%PORT%` in the failing command | Daemon older than command-var expansion. Update forge, restart the daemon (not `forge restart` — that only restarts project processes). |
| `RuntimeError: <X>_JWT_PRIVATE_KEY env var required` | m2m token minting needs the issuer's private key duplicated under that env var in the project `.env`. Same PEM as the API's JWT key. |
| AMQP: `one of ['Connection.OpenOk']` + reconnect loop | The vhost doesn't exist. Verify: `docker exec forge-rabbitmq rabbitmqctl list_vhosts`. Fix: `add_vhost <v>` + `set_permissions -p <v> guest '.*' '.*' '.*'`, or update forge (new versions verify provisioning). |
| `This project's package.json defines packageManager: yarn@X` | Global yarn shadows corepack. Prefix the command with `corepack`. |
| Mongo: connection hangs with `?replicaSet=rs0` | Container isn't in replica-set mode. `forge service configure mongo --replica-set`, then `docker rm -f forge-mongo` and restart the daemon (options bake in at creation). |
| Prompt hangs forever (password/seed CLI) | Windows `getpass` reads the console, not stdin — pipes don't work. Set the value via the project's service layer in a script. |

**A service looks healthy but the app can't use it** → the port may be owned by
a foreign container/process (old forge's TCP-only health check can't tell).
`docker ps` + `netstat -ano | grep :<port>`. Decide with the user: stop the
squatter or move the forge service to a custom port.

**`forge` says daemon not running / `fetch failed`** →

1. `netstat -ano | grep :2525` — nothing listening means the daemon died.
2. Check `~/.forge/daemon.error.log` and `daemon.log`.
3. Windows: `schtasks /Query /TN \Forge\ForgeDaemon`; not registered → run the
   elevated create commands from `forge install`'s error message. Interim:
   start detached via `Start-Process node ... -WindowStyle Hidden`.
4. macOS: `launchctl list | grep forge` · Linux: `systemctl --user status forge.service`.

**Daemon died and ports are still busy** → PTY children survive daemon death as
orphans. Find and kill them: `netstat -ano | grep :<port>` → `taskkill //F //PID <pid>`
(Windows) or `lsof -i :<port>` → `kill` (POSIX). Then `forge up`.

**Vite/dev server: "Port X is in use, trying another one"** → an orphan holds
the allocated port; the new instance silently drifts to X+1 while proxies still
point at X. Kill the orphan, `forge restart <project>`.

**After editing `.forge/config.json`** → changes do nothing until `forge reload`
(port/service changes) — a plain restart is not enough.

## Escalation rule

If the same class of failure has bitten twice, it belongs in forge itself —
file it against the fork rather than patching the workaround into more scripts.
