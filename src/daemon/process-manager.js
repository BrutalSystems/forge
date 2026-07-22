// src/daemon/process-manager.js
const path = require('path');
const net = require('net');
const http = require('http');
const { parseEnvFile } = require('../parse-env-file');
const { runEnvCommand } = require('./decrypt-env');
const { buildStartOrder } = require('./dependency-resolver');
const { killProcessTree, isProcessTreeAlive, waitForProcessTreeDead } = require('./process-kill');

const MAX_BUFFER = 200;

function getDefaultShell(platform = process.platform) {
  // Skip $SHELL on Windows: Git Bash / WSL set SHELL to /usr/bin/bash, but
  // getShellInvokeFlag() returns `/c` on win32 — producing `bash /c "..."`
  // which is wrong (bash wants -c). Mixing /c and -c would require coupling
  // the flag to the resolved shell binary; for v0.8 we just pin Windows to
  // COMSPEC/cmd.exe and document that SHELL override is POSIX-only.
  if (platform === 'win32') return process.env.COMSPEC || 'cmd.exe';

  // Honor $SHELL on POSIX — UNLESS it's zsh. zsh silently strips env vars
  // whose names aren't valid POSIX identifiers (anything with hyphens, dots,
  // etc.) at startup, which breaks .NET-style `ConnectionStrings__Foo-Bar`
  // overrides and any other dotted/hyphenated config key passed via
  // envFileCommand. bash and sh both propagate such names correctly.
  // macOS defaults SHELL to /bin/zsh, so most macOS users hit this — skip it.
  const userShell = process.env.SHELL;
  if (userShell && !/(^|\/)zsh$/.test(userShell)) return userShell;

  // POSIX fallback: /bin/sh is universally present, POSIX-compliant, and
  // matches Node's own `child_process.spawn(cmd, { shell: true })` default.
  return '/bin/sh';
}

function getShellInvokeFlag(platform = process.platform) {
  return platform === 'win32' ? '/c' : '-c';
}

// Expand ${VAR}, $VAR, and %VAR% in a command string from the given env map,
// BEFORE the command reaches the shell. This is what makes one config file
// portable: cmd.exe never expands $PORT and POSIX shells never expand %PORT%,
// so configs written on one OS silently break on the other. Only names present
// in the map are replaced — anything else (e.g. $(subshell), $UNKNOWN) is left
// untouched for the shell to handle.
function expandCommandVars(command, env) {
  return command.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g,
    (match, braced, bare, winStyle) => {
      const name = braced ?? bare ?? winStyle;
      return Object.prototype.hasOwnProperty.call(env, name) ? String(env[name]) : match;
    },
  );
}

function defaultPollPort(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() >= deadline) return resolve(false);
      const socket = net.createConnection({ port, host: 'localhost' });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => {
        socket.destroy();
        const remaining = deadline - Date.now();
        if (remaining <= 0) return resolve(false);
        setTimeout(attempt, Math.min(250, remaining));
      });
    }
    attempt();
  });
}

// Polls http://localhost:{port}/ until status < 500 (i.e. the HTTP stack is ready).
// A 4xx (e.g. 404 or 401) is fine — it means the server is up and routing requests.
// Connection errors and 5xx responses are retried until timeout.
function defaultPollHttp(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() >= deadline) return resolve(false);
      const req = http.request({ host: 'localhost', port, method: 'GET', path: '/' }, res => {
        resolve(res.statusCode < 500);
        res.resume(); // drain to free the socket
      });
      req.on('error', () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return resolve(false);
        setTimeout(attempt, Math.min(250, remaining));
      });
      req.end();
    }
    attempt();
  });
}

function defaultWaitForExit(ptyProc, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(false); }
    }, timeoutMs);
    ptyProc.onExit(({ exitCode }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(exitCode === 0);
      }
    });
  });
}

function createProcessManager({ ptySpawn, pollPort, pollHttp, waitForExit, envCommandRunner = runEnvCommand } = {}) {
  const spawnFn = ptySpawn ?? function(command, env, cwd) {
    const pty = require('node-pty'); // lazy — not loaded in tests that inject ptySpawn
    const shell = getDefaultShell();
    return pty.spawn(shell, [getShellInvokeFlag(), command], {
      name: 'xterm-256color', cols: 120, rows: 30,
      cwd, env: { ...process.env, TERM: 'xterm-256color', ...env },
    });
  };
  const pollPortFn    = pollPort    ?? defaultPollPort;
  const pollHttpFn    = pollHttp    ?? defaultPollHttp;
  const waitForExitFn = waitForExit ?? defaultWaitForExit;

  // "project:process" → { status, startedAt, buffer, pid, ptyProcess }
  const processes = new Map();
  // "project:process" → Set<(event) => void>
  const listeners = new Map();

  const key = (proj, proc) => `${proj}:${proc}`;

  function emit(k, event) {
    for (const cb of (listeners.get(k) ?? [])) { try { cb(event); } catch {} }
  }

  function appendToBuffer(buffer, data) {
    const lines = data.split(/\r?\n/);
    if (buffer.length > 0 && lines.length > 0) buffer[buffer.length - 1] += lines.shift();
    buffer.push(...lines);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  async function startOne(projectName, proc, allocations, projectPath, servicesConfig) {
    const k = key(projectName, proc.name);
    if (processes.get(k)?.status === 'running') return;

    const env = {};
    for (const [svcName, url] of Object.entries(allocations?.services ?? {})) {
      const envVar = (servicesConfig ?? {})[svcName]?.env;
      if (envVar) env[envVar] = url;
    }
    Object.assign(env, proc.env ?? {});
    const port = allocations?.ports?.[proc.name];
    if (port !== undefined && proc.portEnv) env[proc.portEnv] = String(port);

    if (proc.envFile) {
      const overrides = parseEnvFile(path.resolve(projectPath, proc.envFile));
      if (overrides) Object.assign(env, overrides);
    }

    const cwd = path.resolve(projectPath, proc.cwd ?? '.');
    const record = { status: 'running', startedAt: Date.now(), buffer: [], pid: null, ptyProcess: null };
    processes.set(k, record);

    if (proc.envFileCommand) {
      const result = await envCommandRunner(proc.envFileCommand, projectPath);
      // Bail out if killOne ran during the await (record removed from the map).
      // Without this guard, the spawn below would create an orphaned PTY that's
      // invisible to getStatuses/stopProcess and can't be killed by forge.
      if (processes.get(k) !== record) return;
      if (!result.ok) {
        record.status = 'crashed';
        record.startedAt = null;
        // Normalize any embedded newlines to \r\n before writing to the
        // xterm buffer — xterm treats \n as a line-feed only (no column reset),
        // which would render multi-line errors with a jagged left margin.
        const errorText = String(result.error).replace(/\r?\n/g, '\r\n');
        const msg = `\r\n\x1b[31m[forge] envFileCommand failed for "${proc.name}": ${errorText}\x1b[0m\r\n`;
        // Push as a single entry (not through appendToBuffer) so that \r\n
        // sequences within the message are preserved intact for xterm rendering.
        record.buffer.push(msg);
        if (record.buffer.length > MAX_BUFFER) record.buffer.splice(0, record.buffer.length - MAX_BUFFER);
        emit(k, { type: 'status', status: 'crashed' });
        emit(k, { type: 'output', data: msg });
        return;
      }
      Object.assign(env, result.env);
    }

    let ptyProc;
    try {
      // Expand ONLY forge-injected vars (service URLs, proc.env, portEnv,
      // envFile) — controlled values that must work cross-shell (cmd.exe won't
      // expand $PORT, POSIX won't expand %PORT%). Everything else ($HOME,
      // $(subshell), ...) is left for the shell, which expands it against the
      // child's full env (process.env is merged in at spawn, line ~117) the
      // way it always did — crucially WITHOUT re-parsing metacharacters that a
      // textual substitution here would wrongly wake up.
      ptyProc = spawnFn(expandCommandVars(proc.command, env), env, cwd);
    } catch (err) {
      record.status = 'crashed';
      record.startedAt = null;
      const errText = String(err.message ?? err).replace(/\r?\n/g, '\r\n');
      const msg = `\r\n\x1b[31mFailed to start: ${errText}\x1b[0m\r\n`;
      appendToBuffer(record.buffer, msg);
      emit(k, { type: 'status', status: 'crashed' });
      emit(k, { type: 'output', data: msg });
      return;
    }

    record.pid = ptyProc.pid;
    record.ptyProcess = ptyProc;
    emit(k, { type: 'status', status: 'running' });

    ptyProc.onData((data) => {
      appendToBuffer(record.buffer, data);
      emit(k, { type: 'output', data });
    });

    ptyProc.onExit(({ exitCode }) => {
      const current = processes.get(k);
      if (!current || current.ptyProcess !== ptyProc) return;
      const status = exitCode === 0 ? 'stopped' : 'crashed';
      current.status = status;
      current.startedAt = null;
      current.ptyProcess = null;
      emit(k, { type: 'status', status });
    });

    if (proc.waitFor?.http) {
      const timeoutMs = (proc.waitFor.timeoutSeconds ?? 30) * 1000;
      if (port == null) {
        const msg = `[forge] Warning: "${proc.name}" has waitFor.http but no allocated port — treating as ready\r\n`;
        appendToBuffer(record.buffer, msg);
        emit(k, { type: 'output', data: msg });
      } else {
        const ready = await pollHttpFn(port, timeoutMs);
        if (!ready) {
          const msg = `[forge] Warning: "${proc.name}" did not become HTTP-ready within ${proc.waitFor.timeoutSeconds ?? 30}s — starting dependents anyway\r\n`;
          appendToBuffer(record.buffer, msg);
          emit(k, { type: 'output', data: msg });
        }
      }
    } else if (proc.waitFor?.port) {
      const timeoutMs = (proc.waitFor.timeoutSeconds ?? 30) * 1000;
      if (port == null) {
        const msg = `[forge] Warning: "${proc.name}" has waitFor.port but no allocated port — treating as ready\r\n`;
        appendToBuffer(record.buffer, msg);
        emit(k, { type: 'output', data: msg });
      } else {
        const ready = await pollPortFn(port, timeoutMs);
        if (!ready) {
          const msg = `[forge] Warning: "${proc.name}" did not become ready within ${proc.waitFor.timeoutSeconds ?? 30}s — starting dependents anyway\r\n`;
          appendToBuffer(record.buffer, msg);
          emit(k, { type: 'output', data: msg });
        }
      }
    } else if (proc.waitFor?.exit) {
      const timeoutMs = (proc.waitFor.timeoutSeconds ?? 30) * 1000;
      const ready = await waitForExitFn(ptyProc, timeoutMs);
      if (!ready) {
        const msg = `[forge] Warning: "${proc.name}" did not complete successfully within ${proc.waitFor.timeoutSeconds ?? 30}s — starting dependents anyway\r\n`;
        appendToBuffer(record.buffer, msg);
        emit(k, { type: 'output', data: msg });
      }
    }
  }

  function killOne(projectName, processName) {
    const k = key(projectName, processName);
    const record = processes.get(k);
    killProcessTree(record);
    if (record?.ptyProcess) { try { record.ptyProcess.kill(); } catch {} }
    emit(k, { type: 'status', status: 'stopped' });
    processes.delete(k);
  }

  return {
    async up(projectName, processConfigs, allocations, projectPath, servicesConfig) {
      const waves = buildStartOrder(processConfigs ?? []);
      for (const wave of waves) {
        await Promise.all(wave.map(proc =>
          startOne(projectName, proc, allocations ?? {}, projectPath, servicesConfig ?? {})
        ));
      }
    },

    async down(projectName, processConfigs) {
      if (processConfigs?.length) {
        const waves = buildStartOrder(processConfigs);
        for (const wave of [...waves].reverse()) {
          const exitPromises = [];
          for (const proc of wave) {
            const k = key(projectName, proc.name);
            const record = processes.get(k);
            if (!record) continue;
            if (record.ptyProcess) {
              const pgid = record.pid;
              exitPromises.push(new Promise(resolve => {
                const timer = setTimeout(resolve, 5000);
                record.ptyProcess.onExit(async () => {
                  clearTimeout(timer);
                  // Wait for grandchildren (e.g. vite spawned by yarn) to die too —
                  // PTY onExit only fires when the direct child exits, not descendants.
                  if (pgid) await waitForProcessTreeDead(pgid);
                  resolve();
                });
                if (pgid) killProcessTree({ pid: pgid });
                try { record.ptyProcess.kill(); } catch {}
              }));
            }
            emit(k, { type: 'status', status: 'stopped' });
            processes.delete(k);
          }
          if (exitPromises.length > 0) await Promise.all(exitPromises);
        }
        // Sweep: kill any live processes for this project that weren't in the
        // passed config list (e.g. processes removed from config.json since the
        // last refresh). killOne is idempotent on already-deleted keys.
        for (const k of [...processes.keys()]) {
          if (k.startsWith(`${projectName}:`)) {
            killOne(projectName, k.slice(projectName.length + 1));
          }
        }
      } else {
        for (const k of [...processes.keys()]) {
          if (k.startsWith(`${projectName}:`)) {
            killOne(projectName, k.slice(projectName.length + 1));
          }
        }
      }
    },

    async startProcess(projectName, processName, processConfigs, allocations, projectPath, servicesConfig) {
      const all = processConfigs ?? [];
      const proc = all.find(p => p.name === processName);
      if (!proc) return;

      const byName = new Map(all.map(p => [p.name, p]));
      const ancestors = new Set();
      function collectAncestors(name) {
        for (const dep of byName.get(name)?.dependsOn ?? []) {
          if (!ancestors.has(dep)) {
            ancestors.add(dep);
            collectAncestors(dep);
          }
        }
      }
      collectAncestors(processName);

      if (ancestors.size > 0) {
        const ancestorConfigs = all.filter(p => ancestors.has(p.name));
        const depWaves = buildStartOrder(ancestorConfigs);
        for (const wave of depWaves) {
          await Promise.all(wave.map(p =>
            startOne(projectName, p, allocations ?? {}, projectPath, servicesConfig ?? {})
          ));
        }
      }

      await startOne(projectName, proc, allocations ?? {}, projectPath, servicesConfig ?? {});
    },

    stopProcess(projectName, processName) {
      killOne(projectName, processName);
    },

    async restart(projectName, processName, processConfigs, allocations, projectPath, servicesConfig) {
      killOne(projectName, processName);
      const proc = (processConfigs ?? []).find(p => p.name === processName);
      if (proc) await startOne(projectName, proc, allocations ?? {}, projectPath, servicesConfig ?? {});
    },

    getStatuses(projectName, processConfigs) {
      return (processConfigs ?? []).map(proc => {
        const record = processes.get(key(projectName, proc.name));
        return {
          name: proc.name,
          status: record?.status ?? 'stopped',
          pid: record?.pid ?? null,
          uptime: record?.startedAt ? Math.floor((Date.now() - record.startedAt) / 1000) : 0,
        };
      });
    },

    isRunning(projectName, processName) {
      return processes.get(key(projectName, processName))?.status === 'running';
    },

    getBuffer(projectName, processName, lines = 50) {
      return (processes.get(key(projectName, processName))?.buffer ?? []).slice(-lines);
    },

    subscribe(projectName, processName, callback) {
      const k = key(projectName, processName);
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(callback);
    },

    unsubscribe(projectName, processName, callback) {
      listeners.get(key(projectName, processName))?.delete(callback);
    },

    sendInput(projectName, processName, data) {
      processes.get(key(projectName, processName))?.ptyProcess?.write(data);
    },

    resize(projectName, processName, cols, rows) {
      processes.get(key(projectName, processName))?.ptyProcess?.resize(cols, rows);
    },

    killAll() {
      for (const [, record] of processes) {
        killProcessTree(record);
        if (record?.ptyProcess) { try { record.ptyProcess.kill(); } catch {} }
      }
      processes.clear();
    },
  };
}

module.exports = { createProcessManager, getDefaultShell, getShellInvokeFlag, expandCommandVars };
