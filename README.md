# Forge

Your entire local dev stack — processes, ports, and shared services — started with one command.

Working across multiple repos means juggling terminals, remembering which project owns port 3000, manually starting Docker containers, and re-doing it all after a reboot. Forge runs a background daemon that handles all of it so you don't have to think about it.

- **Automatic port allocation** — picks ports from a candidate list, re-validates on every `forge up`, no more conflicts
- **On-demand shared services** — Mongo, Redis, Postgres, RabbitMQ start when a project needs them, stop when nothing does
- **Live dashboard** at `localhost:2525` — terminal output for every process, start/stop/restart controls, no extra terminals
- **Full PTY processes** — colors, readline, and interactive tools work as expected
- **Multi-repo support** — `forge extend` merges another project's processes and services into your config
- **Survives reboots** — runs as a launchd agent (macOS), systemd user service (Linux), or Task Scheduler logon task (Windows) — always ready after login

## Requirements

- macOS, Linux (systemd user session), or Windows 10+ (PowerShell or cmd)
- Node.js ≥ 20
- Docker Desktop (macOS, Windows) or Docker Engine (Linux) — required for shared services (Mongo, Redis)
- A C/C++ toolchain — required by `node-pty` for terminal emulation.
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt install build-essential`
  - Windows: Visual Studio Build Tools (installed automatically via `npm install --global windows-build-tools` or already present if you have Visual Studio)

## Install

```bash
npm install -g @brutalsystems/forge
forge install
```

`forge install` registers the daemon to start automatically on login and listen on port 2525. The mechanism differs by OS:

### macOS

The daemon is registered as a launchd agent at `~/Library/LaunchAgents/com.forge.daemon.plist`.

### Linux (systemd)

The daemon is registered as a systemd **user** service at `~/.config/systemd/user/forge.service`. To keep the daemon running after you log out (recommended for headless boxes):

```bash
loginctl enable-linger $USER
```

Without `enable-linger`, the systemd user manager — and therefore the forge daemon — terminates when your last session ends.

Logs go to `~/.forge/daemon.log` and `~/.forge/daemon.error.log`. systemd start/stop events are viewable via `journalctl --user -u forge.service` (daemon stdout itself is in the log files, not the journal).

### Windows

The daemon is registered as a Task Scheduler task named `\Forge\ForgeDaemon` that runs at user logon. The XML config lives at `%LOCALAPPDATA%\Forge\forge-task.xml`. Logs go to `%USERPROFILE%\.forge\daemon.log` and `%USERPROFILE%\.forge\daemon.error.log`.

To inspect the task: open `taskschd.msc` and navigate to Task Scheduler Library → Forge, or run:

```cmd
schtasks /Query /TN \Forge\ForgeDaemon /V /FO LIST
```

Acknowledged limitation: the task triggers at logon and stops when you log out. There's no Windows analog to systemd's `enable-linger`. Headless servers can configure the task to "Run whether user is logged on or not" via Task Scheduler GUI; doing so requires storing your Windows password in the task config.

## Quick start

```bash
# 1. In your project directory, scaffold a config
cd ~/projects/my-app
forge init

# 2. Edit .forge/config.json to describe your processes and services
#    (see Configuration reference below)

# 3. Register the project with the daemon
forge add

# 4. Start all processes
forge up

# 5. Open the web dashboard
forge open
```

## Why Forge?

**Too many terminals.** Running a modern app means juggling an API server, a frontend dev server, a background worker, and a job queue — each in its own tab. Forge puts live terminal output for all of them in one dashboard, with per-process start, stop, and restart controls.

**Port conflict hell.** Every project defaults to port 3000. Forge assigns ports from a candidate list at registration time and re-validates on every `forge up` — if something else has claimed a port since last time, it auto-reallocates and rewrites `.env.forge` before spawning.

**Service startup ceremony.** Remembering to start Docker, then Mongo, then Redis — in the right order, every morning — is friction. Forge starts shared containers on demand when a project comes up, stops them when nothing needs them, and recreates them automatically if they're removed externally.

**Multi-repo complexity.** When your frontend depends on an API from another repo, you need both sets of processes and services running, with the right env vars wiring them together. `forge extend` merges a dependency's config into yours — ports, services, and env injection included.

## Core concepts

### The daemon

Forge runs a persistent background daemon registered as a launchd agent on macOS (`~/Library/LaunchAgents/com.forge.daemon.plist`), a systemd user service on Linux (`~/.config/systemd/user/forge.service`), or a Task Scheduler logon task on Windows (`\Forge\ForgeDaemon`). The daemon:

- Listens on port 2525 for CLI commands and dashboard connections
- Manages process lifecycles — spawning PTY processes, capturing output, restarting on failure
- Maintains the project registry at `~/.forge/registry.json`
- Starts and stops shared Docker containers as projects come up and down

All `forge` CLI commands communicate with this daemon over HTTP. If the daemon is not running, most commands will fail with a connection error.

### Process management

Each process in your config is spawned as a PTY (pseudo-terminal), which means interactive tools, colored output, and readline all work as expected. Forge:

- Allocates ports from each process's `ports` candidate list at registration time (`forge add`) — first available wins
- Injects env vars into the PTY environment at spawn time
- Buffers terminal output for retrieval via `forge logs` or the dashboard
- Accepts input to the PTY for interactive processes

Port allocations persist in `~/.forge/registry.json`. At `forge up` time the daemon re-validates each registered port: if the port has been claimed by another process since registration, forge automatically re-allocates to the next available candidate from the `ports` list and rewrites `.env.forge` before spawning. Allocations only reset explicitly when you run `forge remove` + `forge add`, or `forge reload` after changing the `ports` list.

### Env injection

At spawn time, forge injects env vars into each process's PTY environment in this priority order (later wins):

1. Service connection strings from `.env.forge` (e.g. `MONGODB_URL`, `REDIS_URL`)
2. Static `env` from the process config
3. Port allocation for this specific process (`portEnv`)

`.env.forge` is written to disk at the project root on `forge add` and `forge sync`. It contains:

- Service connection strings declared via `services[name].env`
- Sibling port exports declared via `portExportEnv` on other processes

```bash
# .env.forge — generated by forge, do not edit
MONGODB_URL=mongodb://localhost:27017/my-app-dev
REDIS_URL=redis://localhost:6379/3
API_SERVICE_PORT=8200
```

`.env.forge` is automatically added to `.gitignore` on `forge add` and `forge sync`. It is machine-specific and regenerated on each sync. Do not commit it.

Port env vars that use generic names like `PORT` are NOT written to `.env.forge` — they would conflict across processes. To export a port so sibling processes can discover it, use `portExportEnv` with a unique name (see `portExportEnv` in the config reference below).

### Shared services

Forge manages shared Docker containers for four services on demand. Containers start automatically on `forge up` and stop when no registered project needs them on `forge down`.

| Service | Container | Image | Port |
|---|---|---|---|
| `mongo` | `forge-mongo` | `mongo:8.0.23` | 27017 |
| `redis` | `forge-redis` | `redis:7` | 6379 |
| `postgres` | `forge-postgres` | `postgres:16` | 5432 |
| `rabbitmq` | `forge-rabbitmq` | `rabbitmq:3` | 5672 |

Each project gets an isolated allocation:

- **Mongo**: its own named database within the shared container
- **Redis**: its own database number (1–63), auto-assigned per registered project
- **Postgres**: its own named database, created automatically on `forge add`
- **RabbitMQ**: its own virtual host, created automatically on `forge add`

If a container is externally removed while the daemon is running, forge detects the health failure and recreates it automatically.

### Service ownership

Service declarations belong in the project that **owns** the data, not the project that consumes it.

When project B extends project A via `forge extend`, it inherits A's service declarations. Forge allocates independently per registered project, so each consumer project gets its own isolated allocation even though the service is declared in the source.

- `api-service/.forge/config.json` declares `mongo` with `"db": "api-service"` — api-service always connects to its own database regardless of which project extends it
- `realtime/.forge/config.json` declares `redis` — each project that extends realtime gets its own isolated Redis DB number
- `web-app` declares no services — it inherits both via `forge extend`

See [docs/multi-project.md](docs/multi-project.md) for a full walkthrough of this pattern.

## Named Service Instances

By default, forge runs one container per service type on the well-known port. You can add named instances to run multiple configurations side by side — useful when some projects need MongoDB replica set mode (required for transactions/sessions) while others do not.

### Managing instances

```bash
# Add a replica-set enabled MongoDB instance (port auto-assigned)
forge service add mongo rs --replica-set

# Add a second Postgres on a specific port
forge service add postgres analytics --port 5433

# List all custom instances
forge service list

# Update an instance's options
forge service configure mongo rs --replica-set

# Remove an instance
forge service remove mongo rs
```

### Referencing an instance in a project

In `.forge/config.json`, use `"type:instance"` as the service key:

```json
{
  "name": "api-service",
  "services": {
    "mongo:rs": {
      "db": "api-service",
      "env": "MONGODB_URL"
    }
  }
}
```

The connection string written to `.env.forge` will include `?replicaSet=rs0` automatically when the instance was created with `--replica-set`.

### MongoDB replica set (transactions and sessions)

A single-node replica set satisfies Mongo's requirement for multi-document transactions and change streams without the overhead of a real multi-member replica set:

```bash
forge service add mongo rs --replica-set
```

forge starts the container with `--replSet rs0 --bind_ip_all` and runs `rs.initiate()` automatically after the container is healthy.

## Configuration reference

`forge init` creates `.forge/config.json` at the project root. Example:

```json
{
  "name": "my-app",
  "processes": [
    {
      "name": "api",
      "command": "npm start",
      "cwd": ".",
      "ports": [3000, 3001, 3002],
      "portEnv": "PORT",
      "portExportEnv": "MY_APP_API_PORT",
      "env": {
        "NODE_ENV": "development"
      }
    },
    {
      "name": "ui",
      "command": "npm run dev",
      "cwd": "packages/ui",
      "ports": [5173, 5174, 5175],
      "portEnv": "VITE_PORT"
    }
  ],
  "services": {
    "mongo": {
      "db": "my-app-dev",
      "env": "MONGODB_URL"
    },
    "redis": {
      "env": "REDIS_URL"
    }
  }
}
```

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Project name. Used as prefix in multi-repo setups and as the default Mongo database name if `services.mongo.db` is omitted. |
| `processes` | array | List of process definitions. |
| `services` | object | Shared service declarations. Keys are `mongo` and/or `redis`. |

### Process fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Process name, unique within the project. |
| `command` | string | Shell command to run. `${VAR}`, `$VAR`, and `%VAR%` references to forge-injected env vars (e.g. `portEnv`, service URLs, `.env.forge` exports) are expanded by forge **before** the shell sees the command, so one config file works on macOS, Linux, and Windows. Unknown names are left for the shell. |
| `cwd` | string | Working directory, relative to the project root. Defaults to `.`. |
| `ports` | array | Candidate port numbers tried in order. Forge picks the first available at registration time. Omit or use `[]` for processes that don't bind a port. |
| `portEnv` | string | Env var injected into **this process only** with its allocated port (e.g. `"PORT"`). Not written to `.env.forge`. |
| `portExportEnv` | string | Env var written to `.env.forge` under this name so **sibling processes** can discover this process's port. Use when `portEnv` is too generic (e.g. `PORT`) to be safely shared. See the sibling port discovery section below. |
| `env` | object | Static env vars injected into this process at spawn time. Written as-is; no substitution. |
| `dependsOn` | array | Names of processes that must be ready before this one starts. Processes are started in topological order — a cycle throws an error. |
| `waitFor` | object | Readiness condition used by dependent processes. `{ "port": true }` polls TCP on this process's allocated port. `{ "exit": true }` waits for exit code 0. Add `"timeoutSeconds": N` to override the 30-second default. Omit for immediate readiness (current default). |

### Service fields

#### MongoDB

| Field | Type | Description |
|---|---|---|
| `db` | string | Database name. Use a stable name tied to the service identity (e.g. `"api-service"`). Intentionally the same across all consumer projects — they connect to the same database. Defaults to the project `name` if omitted. |
| `env` | string | Env var name written to `.env.forge` with the full connection string (`mongodb://localhost:27017/<db>`). |

#### Redis

| Field | Type | Description |
|---|---|---|
| `env` | string | Env var name written to `.env.forge` with the full connection string (`redis://localhost:6379/<db>`). The `<db>` number is auto-assigned per registered project — do not hardcode it. |

#### PostgreSQL

| Field | Type | Description |
|---|---|---|
| `db` | string | Database name. Forge creates the database if it does not exist. Defaults to a sanitized form of the project `name`. |
| `env` | string | Env var name written to `.env.forge` with the full connection string (`postgresql://postgres:forge@localhost:5432/<db>`). |

#### RabbitMQ

| Field | Type | Description |
|---|---|---|
| `vhost` | string | Virtual host name. Forge creates the vhost and grants `guest` full permissions if it does not exist. Defaults to a sanitized form of the project `name`. |
| `env` | string | Env var name written to `.env.forge` with the full connection string (`amqp://guest:guest@localhost:5672/<vhost>`). |

### Sibling port discovery

Problem: a Vite dev server needs to know what port the API is running on to configure its proxy. Each process only gets its own port injected via `portEnv`.

Solution: set `portExportEnv` on the API process with a unique name. Forge writes that port to `.env.forge` under that name, and all processes read `.env.forge` at spawn time.

Example: the API process has `"portEnv": "PORT", "portExportEnv": "API_SERVICE_PORT"`.

- `PORT=8200` is injected only into the API process
- `API_SERVICE_PORT=8200` is written to `.env.forge` and therefore available to the Vite process (and any other process) via `process.env.API_SERVICE_PORT`

## Process startup ordering with `dependsOn`

By default all processes in a project start in parallel. For most setups this is fine: `.env.forge` is written with correct port values before any process spawns. When you need stricter ordering, use `dependsOn` and `waitFor`:

```json
{
  "processes": [
    {
      "name": "migrate",
      "command": "node migrate.js",
      "waitFor": { "exit": true, "timeoutSeconds": 60 }
    },
    {
      "name": "api",
      "command": "node server.js",
      "ports": [3000],
      "portEnv": "PORT",
      "dependsOn": ["migrate"],
      "waitFor": { "port": true, "timeoutSeconds": 30 }
    },
    {
      "name": "app",
      "command": "yarn dev",
      "dependsOn": ["api"]
    }
  ]
}
```

`waitFor` lives on the **dependency** (the process being waited on) and describes when it is considered ready:

- `{ "port": true }` — polls TCP on this process's own allocated port until it accepts connections. If the process has no allocated port, forge treats it as ready immediately and emits a warning.
- `{ "exit": true }` — waits for the process to exit with code 0
- `"timeoutSeconds"` — how long to wait before warning and proceeding (default 30)

`dependsOn` is a list of process names that must be ready before this process starts. A cycle in the dependency graph is an error — forge refuses to start and prints the cycle path.

`forge up <name>` also respects `dependsOn`: it starts all transitive dependencies first.

## forge extend — multi-repo setup

`forge extend <path>` merges processes and services from another project's `.forge/config.json` into the current one.

```bash
cd ~/projects/web-app
forge extend ../api-service
forge extend ../realtime
forge reload   # if the project is already registered
```

What extend does:

1. Reads the target's `.forge/config.json`
2. Appends processes not already present, prefixed with the source project name (e.g. `realtime:server`)
3. Merges services — current project wins on collision
4. Copies `portExportEnv`, `env`, and port ranges from each source process

Already-present processes are skipped (the count is reported). Services already declared in the current config are not overwritten.

After `forge extend`, run `forge reload` if the project is already registered with the daemon. This reallocates ports and provisions any new services.

See [docs/multi-project.md](docs/multi-project.md) for patterns and pitfalls.

## Multi-instance services

When two different projects each extend `realtime`, forge provisions them independently:

- Each gets a different port from the `[8101, 8102, 8103]` candidate list — forge picks the first available per project
- Each gets a different Redis DB number — forge allocates independently per registered project
- The static `env` on the realtime process (`"REALTIME_AUTO_START_REDIS": "false"`) is inherited by both consumers, telling realtime not to start its own Docker container (forge manages it)

Example source config (`realtime/.forge/config.json`):

```json
{
  "name": "realtime",
  "processes": [{
    "name": "server",
    "command": "uv run realtime",
    "ports": [8101, 8102, 8103],
    "portEnv": "REALTIME_PORT",
    "portExportEnv": "REALTIME_PORT",
    "env": { "REALTIME_AUTO_START_REDIS": "false" }
  }],
  "services": {
    "redis": { "env": "REALTIME_REDIS_URL" }
  }
}
```

Both web-app and any other consumer each get their own port and their own `REALTIME_REDIS_URL` pointing to a different Redis DB number.

## CLI reference

| Command | Description |
|---|---|
| `forge install` | Register daemon as a user service (launchd on macOS, systemd on Linux, Task Scheduler on Windows) and start it |
| `forge uninstall` | Stop daemon and remove the user service / task |
| `forge init` | Scaffold `.forge/config.json` in the current directory (auto-detects name from `package.json`) |
| `forge add` | Register the current project: allocate ports, provision services, write `.env.forge` |
| `forge reload` | Re-read `.forge/config.json` and apply changes to the daemon. Run after any config edit. (`forge sync` is a backwards-compatible alias.) |
| `forge up [project]` | Start all processes. CWD-aware when no project given. |
| `forge down [project]` | Stop all processes. CWD-aware when no project given. |
| `forge restart [project]` | Stop then start processes for a project. CWD-aware when no project given. |
| `forge status` | Show all registered projects and process statuses |
| `forge logs <process> [project]` | Show buffered output for a process. `--follow`/`-f` to stream live. `-n <lines>` controls how many lines (default 100). Project resolved from CWD if omitted. |
| `forge env [project]` | Show all env vars forge will inject for a project. Sections: Services and Processes. Project resolved from CWD if omitted. |
| `forge open` | Open the web dashboard in the default browser |
| `forge service` | Show shared service health |
| `forge service up [name]` | Start one or all shared services |
| `forge service down [name]` | Stop one or all shared services |
| `forge service list` | List all named service instances |
| `forge service add <type> <name>` | Add a named service instance |
| `forge service remove <type> <name>` | Remove a named service instance |
| `forge service configure <type> [name]` | Update options for a service instance |
| `forge extend <path>` | Merge processes and services from another project into current `.forge/config.json` |
| `forge remove [project]` | Unregister a project and release its allocations. CWD-aware when no project given. |
| `forge version` | Show forge version and daemon status |

### CWD-aware commands

`forge up`, `forge down`, `forge restart`, and `forge remove` without a project name check the current working directory. If CWD matches a registered project's path, only that project is affected. Otherwise all registered projects are affected (for process commands) or an error is returned (for `forge remove`).

```bash
cd ~/projects/web-app
forge up       # starts only web-app
forge down     # stops only web-app
forge restart  # restarts only web-app
forge remove   # unregisters web-app

cd ~
forge up    # starts all registered projects
forge down  # stops all registered projects
```

## Dashboard

The web dashboard is available at `http://localhost:2525` after `forge install`.

- All registered projects in tabs
- Live terminal output per process via xterm.js over WebSocket
- Per-process start, stop, and restart controls
- Process input support — interactive terminals work
- Shared services section — enable or disable per project (writes back to `.forge/config.json` and `.env.forge`)

## Troubleshooting

**Daemon didn't start**
```bash
cat ~/.forge/daemon.error.log
```

**Check daemon status**

macOS:
```bash
launchctl list | grep forge
```

Linux:
```bash
systemctl --user status forge.service
```

Windows (cmd or PowerShell):
```cmd
schtasks /Query /TN \Forge\ForgeDaemon
```

**Windows: "Registering the logon task was denied"**
Some machines require elevation to create scheduled tasks. Run the two `schtasks` commands printed in the error from an Administrator PowerShell — this is a one-time step; the daemon then starts at every logon.

**node-pty build error**
Xcode Command Line Tools are required. Run:
```bash
xcode-select --install
npm_config_build_from_source=true npm rebuild node-pty
```

**Port conflict**
Forge automatically re-allocates at `forge up` time if a registered port is occupied. If it still fails (all candidates are taken), add more candidate ports to the `ports` array for the affected process and run `forge reload`.

**Service won't start**
Forge uses Docker to run Mongo and Redis. Make sure Docker Desktop is running:
```bash
docker ps
forge services
```

**Container removed externally while daemon is running**
```bash
forge down && forge up
```
Forge detects the health failure and recreates the container.

**Reset a project's allocations**
```bash
forge remove my-app
forge add
```

## Development

```bash
git clone https://github.com/BrutalSystems/forge.git
cd forge
npm install
npm run build:web   # build the dashboard
npm test            # run the test suite
```

To develop the dashboard with HMR, run the daemon and Vite dev server in parallel:

```bash
node src/daemon/server.js &   # start the daemon directly
npm run dev:web               # Vite dev server at localhost:5173
```

The Vite dev server proxies API and WebSocket requests to the running daemon at port 2525.

### Keeping the `forge` CLI in sync

The `forge` command resolves to the globally installed package, not the local source. After pulling changes, if `forge --version` shows a stale version, reinstall from your local checkout:

```bash
npm install -g .
```

## Contributing

Contributions are welcome! Forge is an open source project and outside pull
requests are encouraged.

The short version:

1. **Fork** the repo and clone your fork.
2. Create a branch, make your change, and add or update tests where it makes sense.
3. Run `npm test` and make sure it passes.
4. Push to your fork and open a **pull request** against `main`.

CI runs across macOS, Linux, and Windows on every PR, and a maintainer reviews
before merging. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide,
including dev setup and what to expect from the review process. Bug reports and
feature requests are welcome via [issues](https://github.com/BrutalSystems/forge/issues).

## License

[MIT](./LICENSE)
