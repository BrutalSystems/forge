const os = require('os');
const fs = require('fs');
const path = require('path');
const { createProcessManager } = require('../src/daemon/process-manager');

function makeMockPty() {
  let dataCb = null;
  let exitCb = null;
  return {
    pid: Math.floor(Math.random() * 9000 + 1000),
    onData(cb) { dataCb = cb; },
    onExit(cb) { exitCb = cb; },
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(() => { exitCb?.({ exitCode: 0 }); }),
    // test helpers
    emit(data) { dataCb?.(data); },
    exit(code = 0) { exitCb?.({ exitCode: code }); },
  };
}

const processConfigs = [
  { name: 'api',    command: 'npm start',       cwd: '.', ports: [3000], portEnv: 'PORT' },
  { name: 'worker', command: 'node worker.js',  cwd: '.', ports: [] },
];
const allocations = { ports: { api: 3000 }, services: {} };

let spawnCalls, pm;

beforeEach(() => {
  spawnCalls = [];
  pm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
  });
});

test('up() spawns one PTY per process config', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  expect(spawnCalls).toHaveLength(2);
});

test('up() injects portEnv into PTY env', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const api = spawnCalls.find(c => c.command === 'npm start');
  expect(api.env.PORT).toBe('3000');
});

test('up() does not inject portEnv when port is absent', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const worker = spawnCalls.find(c => c.command === 'node worker.js');
  expect(worker.env).not.toHaveProperty('PORT');
});

test('up() resolves cwd relative to projectPath', async () => {
  const configs = [{ name: 'api', command: 'npm start', cwd: 'packages/api', ports: [] }];
  await pm.up('sai', configs, {}, '/projects/sai');
  expect(spawnCalls[0].cwd).toBe(path.resolve('/projects/sai', 'packages/api'));
});

test('up() skips already-running processes', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  expect(spawnCalls).toHaveLength(2);
});

test('isRunning() returns true after up()', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  expect(pm.isRunning('sai', 'api')).toBe(true);
});

test('isRunning() returns false before up()', () => {
  expect(pm.isRunning('sai', 'api')).toBe(false);
});

test('down() stops all processes for a project', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  pm.down('sai');
  expect(pm.isRunning('sai', 'api')).toBe(false);
  expect(pm.isRunning('sai', 'worker')).toBe(false);
});

test('down() does not affect other projects', async () => {
  await pm.up('sai',    processConfigs, allocations, '/projects/sai');
  await pm.up('cleome', processConfigs, allocations, '/projects/cleome');
  pm.down('sai');
  expect(pm.isRunning('cleome', 'api')).toBe(true);
});

test('getStatuses() shows running after up()', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const s = pm.getStatuses('sai', processConfigs);
  expect(s.find(p => p.name === 'api').status).toBe('running');
});

test('getStatuses() defaults to stopped for unstarted processes', () => {
  const s = pm.getStatuses('sai', processConfigs);
  expect(s.every(p => p.status === 'stopped')).toBe(true);
});

test('getStatuses() shows stopped after clean exit', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  spawnCalls[0].mock.exit(0);
  const s = pm.getStatuses('sai', processConfigs);
  expect(s.find(p => p.name === 'api').status).toBe('stopped');
});

test('getStatuses() shows crashed after non-zero exit', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  spawnCalls[0].mock.exit(1);
  const s = pm.getStatuses('sai', processConfigs);
  expect(s.find(p => p.name === 'api').status).toBe('crashed');
});

test('getBuffer() includes the error message when pty spawn throws', async () => {
  const failingPm = createProcessManager({
    ptySpawn: () => { throw new Error('posix_spawnp failed.'); },
  });
  await failingPm.up('sai', processConfigs, allocations, '/projects/sai');
  const buf = failingPm.getBuffer('sai', 'api').join('');
  expect(buf).toContain('Failed to start: posix_spawnp failed.');
  expect(failingPm.getStatuses('sai', processConfigs).find(p => p.name === 'api').status).toBe('crashed');
});

test('subscribe() receives output events', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const events = [];
  pm.subscribe('sai', 'api', e => events.push(e));
  spawnCalls[0].mock.emit('hello\n');
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ type: 'output', data: 'hello\n' });
});

test('subscribe() receives status events on exit', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const events = [];
  pm.subscribe('sai', 'api', e => events.push(e));
  spawnCalls[0].mock.exit(0);
  expect(events.some(e => e.type === 'status' && e.status === 'stopped')).toBe(true);
});

test('unsubscribe() stops receiving events', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const events = [];
  const cb = e => events.push(e);
  pm.subscribe('sai', 'api', cb);
  pm.unsubscribe('sai', 'api', cb);
  spawnCalls[0].mock.emit('hello\n');
  expect(events).toHaveLength(0);
});

test('getBuffer() returns buffered output lines', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  spawnCalls[0].mock.emit('line one\nline two\n');
  const buf = pm.getBuffer('sai', 'api');
  expect(buf.join(' ')).toContain('line');
});

test('restart() respawns the process', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  pm.restart('sai', 'api', processConfigs, allocations, '/projects/sai');
  expect(spawnCalls).toHaveLength(3);
  expect(pm.isRunning('sai', 'api')).toBe(true);
});

test('killAll() stops every process across all projects', async () => {
  await pm.up('sai',    processConfigs, allocations, '/projects/sai');
  await pm.up('cleome', processConfigs, allocations, '/projects/cleome');
  pm.killAll();
  expect(pm.isRunning('sai',    'api')).toBe(false);
  expect(pm.isRunning('cleome', 'api')).toBe(false);
});

test('down() emits stopped status event to subscribers', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  const events = [];
  pm.subscribe('sai', 'api', e => events.push(e));
  pm.down('sai');
  expect(events.some(e => e.type === 'status' && e.status === 'stopped')).toBe(true);
});

test('down() sweeps live processes that are no longer in the passed config list', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  expect(pm.isRunning('sai', 'api')).toBe(true);
  expect(pm.isRunning('sai', 'worker')).toBe(true);

  // Caller passes a list that no longer includes "worker" (e.g. config was edited
  // to remove it). The sweep should still kill it.
  const trimmed = processConfigs.filter(p => p.name !== 'worker');
  await pm.down('sai', trimmed);

  expect(pm.isRunning('sai', 'api')).toBe(false);
  expect(pm.isRunning('sai', 'worker')).toBe(false);
});

test('killAll() cleans up listeners so no further events are emitted', async () => {
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  pm.killAll();
  const events = [];
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  pm.subscribe('sai', 'api', e => events.push(e));
  spawnCalls[2].mock.emit('hello\n');
  expect(events).toHaveLength(1);
});

test('envFile vars are injected into the spawned process env', async () => {
  const envFilePath = path.join(os.tmpdir(), `forge-envfile-test-${Date.now()}.env`);
  fs.writeFileSync(envFilePath, 'SECRET_KEY=abc123\nOTHER=xyz\n');
  const configs = [{ name: 'api', command: 'npm start', cwd: '.', ports: [], envFile: envFilePath }];
  await pm.up('sai', configs, {}, '/projects/sai');
  expect(spawnCalls[0].env.SECRET_KEY).toBe('abc123');
  expect(spawnCalls[0].env.OTHER).toBe('xyz');
  fs.unlinkSync(envFilePath);
});

test('envFile vars override proc.env when the same key appears in both', async () => {
  const envFilePath = path.join(os.tmpdir(), `forge-envfile-test-${Date.now()}.env`);
  fs.writeFileSync(envFilePath, 'KEY=from_file\n');
  const configs = [{ name: 'api', command: 'npm start', cwd: '.', ports: [], env: { KEY: 'from_config' }, envFile: envFilePath }];
  await pm.up('sai', configs, {}, '/projects/sai');
  expect(spawnCalls[0].env.KEY).toBe('from_file');
  fs.unlinkSync(envFilePath);
});

test('missing envFile is silently skipped — process still spawns', async () => {
  const configs = [{ name: 'api', command: 'npm start', cwd: '.', ports: [], envFile: '/nonexistent/path.env' }];
  await expect(pm.up('sai', configs, {}, '/projects/sai')).resolves.not.toThrow();
  expect(spawnCalls).toHaveLength(1);
});

test('missing envFile does not inject any extra vars', async () => {
  const configs = [{ name: 'api', command: 'npm start', cwd: '.', ports: [], envFile: '/nonexistent/path.env' }];
  await pm.up('sai', configs, {}, '/projects/sai');
  expect(Object.keys(spawnCalls[0].env)).toHaveLength(0);
});

test('envFile path is resolved relative to projectPath', async () => {
  const projectPath = os.tmpdir();
  const relPath = `forge-envfile-rel-${Date.now()}.env`;
  const absPath = path.join(projectPath, relPath);
  fs.writeFileSync(absPath, 'REL_VAR=resolved\n');
  const configs = [{ name: 'api', command: 'npm start', cwd: '.', ports: [], envFile: relPath }];
  await pm.up('sai', configs, {}, projectPath);
  expect(spawnCalls[0].env.REL_VAR).toBe('resolved');
  fs.unlinkSync(absPath);
});

// ── dependsOn ordering and readiness ─────────────────────────────────────────

test('up() starts processes in dependency order', async () => {
  const order = [];
  const pm2 = createProcessManager({
    ptySpawn: (command) => {
      order.push(command);
      return makeMockPty();
    },
  });
  const configs = [
    { name: 'api', command: 'api' },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  await pm2.up('sai', configs, {}, '/projects/sai');
  expect(order).toEqual(['api', 'app']);
});

test('up() awaits waitFor.port before starting dependent', async () => {
  const order = [];
  let resolvePoll;
  const pollPort = jest.fn().mockReturnValue(new Promise(r => { resolvePoll = r; }));
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    pollPort,
  });
  const configs = [
    { name: 'api', command: 'api', waitFor: { port: true, timeoutSeconds: 5 } },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  const upPromise = pm2.up('sai', configs, { ports: { api: 3000 } }, '/projects/sai');
  // Flush microtasks so wave 0 (api) spawns
  await Promise.resolve();
  expect(order).toEqual(['api']);
  resolvePoll(true);
  await upPromise;
  expect(order).toEqual(['api', 'app']);
});

test('up() awaits waitFor.exit before starting dependent', async () => {
  const order = [];
  let resolveExit;
  const waitForExit = jest.fn().mockReturnValue(new Promise(r => { resolveExit = r; }));
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    waitForExit,
  });
  const configs = [
    { name: 'migrate', command: 'migrate', waitFor: { exit: true, timeoutSeconds: 30 } },
    { name: 'api',     command: 'api',     dependsOn: ['migrate'] },
  ];
  const upPromise = pm2.up('sai', configs, {}, '/projects/sai');
  await Promise.resolve();
  expect(order).toEqual(['migrate']);
  resolveExit(true);
  await upPromise;
  expect(order).toEqual(['migrate', 'api']);
});

test('up() emits warning to buffer and continues when waitFor.port times out', async () => {
  const pollPort = jest.fn().mockResolvedValue(false);
  const order = [];
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    pollPort,
  });
  const configs = [
    { name: 'api', command: 'api', waitFor: { port: true, timeoutSeconds: 5 } },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  await pm2.up('sai', configs, { ports: { api: 3000 } }, '/projects/sai');
  // app still starts despite api not becoming ready
  expect(order).toEqual(['api', 'app']);
  const buf = pm2.getBuffer('sai', 'api', 20);
  expect(buf.join('\n')).toContain('[forge] Warning');
  expect(buf.join('\n')).toContain('api');
});

test('up() emits warning and continues when waitFor.exit process crashes', async () => {
  const waitForExit = jest.fn().mockResolvedValue(false);
  const order = [];
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    waitForExit,
  });
  const configs = [
    { name: 'migrate', command: 'migrate', waitFor: { exit: true, timeoutSeconds: 30 } },
    { name: 'api',     command: 'api',     dependsOn: ['migrate'] },
  ];
  await pm2.up('sai', configs, {}, '/projects/sai');
  expect(order).toEqual(['migrate', 'api']);
  const buf = pm2.getBuffer('sai', 'migrate', 20);
  expect(buf.join('\n')).toContain('[forge] Warning');
});

test('startProcess() auto-starts transitive dependencies first', async () => {
  const order = [];
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
  });
  const configs = [
    { name: 'migrate', command: 'migrate' },
    { name: 'api',     command: 'api',     dependsOn: ['migrate'] },
    { name: 'app',     command: 'app',     dependsOn: ['api'] },
  ];
  await pm2.startProcess('sai', 'app', configs, {}, '/projects/sai');
  expect(order[0]).toBe('migrate');
  expect(order[1]).toBe('api');
  expect(order[2]).toBe('app');
});

test('up() awaits waitFor.http before starting dependent', async () => {
  const order = [];
  let resolvePoll;
  const pollHttp = jest.fn().mockReturnValue(new Promise(r => { resolvePoll = r; }));
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    pollHttp,
  });
  const configs = [
    { name: 'api', command: 'api', ports: [3000], portEnv: 'PORT', waitFor: { http: true, timeoutSeconds: 5 } },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  const upPromise = pm2.up('sai', configs, { ports: { api: 3000 } }, '/projects/sai');
  await Promise.resolve();
  expect(order).toEqual(['api']);
  resolvePoll(true);
  await upPromise;
  expect(order).toEqual(['api', 'app']);
});

test('up() emits warning and continues when waitFor.http times out', async () => {
  const pollHttp = jest.fn().mockResolvedValue(false);
  const order = [];
  const pm2 = createProcessManager({
    ptySpawn: (command) => { order.push(command); return makeMockPty(); },
    pollHttp,
  });
  const configs = [
    { name: 'api', command: 'api', ports: [3000], portEnv: 'PORT', waitFor: { http: true, timeoutSeconds: 5 } },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  await pm2.up('sai', configs, { ports: { api: 3000 } }, '/projects/sai');
  expect(order).toEqual(['api', 'app']);
  const buf = pm2.getBuffer('sai', 'api', 20);
  expect(buf.join('\n')).toContain('[forge] Warning');
  expect(buf.join('\n')).toContain('HTTP-ready');
});

test('up() throws on cycle in dependsOn', async () => {
  const pm2 = createProcessManager({ ptySpawn: () => makeMockPty() });
  const configs = [
    { name: 'a', command: 'a', dependsOn: ['b'] },
    { name: 'b', command: 'b', dependsOn: ['a'] },
  ];
  await expect(pm2.up('sai', configs, {}, '/projects/sai')).rejects.toThrow('Cycle detected');
});

test('down() with processConfigs kills dependents before dependencies', async () => {
  const killOrder = [];
  const mockPtys = {};
  const pm2 = createProcessManager({
    ptySpawn: (command) => {
      const m = makeMockPty();
      if (command === 'app') {
        m.kill = jest.fn(() => { killOrder.push(command); }); // does not auto-exit
      } else {
        m.kill = jest.fn(() => { killOrder.push(command); m.exit(0); });
      }
      mockPtys[command] = m;
      return m;
    },
  });
  const configs = [
    { name: 'api', command: 'api' },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  await pm2.up('proj', configs, {}, '/projects/proj');

  const downPromise = pm2.down('proj', configs);

  // app (dependent) must be killed first
  expect(killOrder[0]).toBe('app');
  // api (dependency) must not be killed yet — waiting for app to exit
  expect(killOrder).toHaveLength(1);

  // Let app exit, which unblocks the next wave
  mockPtys['app'].exit(0);
  await downPromise;

  expect(killOrder[1]).toBe('api');
});

test('down() with processConfigs waits for dependent exit before killing dependency', async () => {
  let apiKilledAt = null;
  let appExitedAt = null;
  const mockPtys = {};
  const pm2 = createProcessManager({
    ptySpawn: (command) => {
      const m = makeMockPty();
      if (command === 'app') {
        m.kill = jest.fn(() => {}); // manual exit control
      } else {
        m.kill = jest.fn(() => { apiKilledAt = Date.now(); m.exit(0); });
      }
      mockPtys[command] = m;
      return m;
    },
  });
  const configs = [
    { name: 'api', command: 'api' },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  await pm2.up('proj', configs, {}, '/projects/proj');

  const downPromise = pm2.down('proj', configs);
  expect(apiKilledAt).toBeNull(); // api not yet killed

  appExitedAt = Date.now();
  mockPtys['app'].exit(0);
  await downPromise;

  expect(apiKilledAt).not.toBeNull();
  expect(apiKilledAt).toBeGreaterThanOrEqual(appExitedAt);
});

test('startProcess() does not re-spawn already-running dependency', async () => {
  const pm2 = createProcessManager({
    ptySpawn: (command) => {
      spawnCalls.push({ command, mock: makeMockPty() });
      return spawnCalls[spawnCalls.length - 1].mock;
    },
  });
  const configs = [
    { name: 'api', command: 'api' },
    { name: 'app', command: 'app', dependsOn: ['api'] },
  ];
  // Start api standalone first
  await pm2.startProcess('sai', 'api', configs, {}, '/projects/sai');
  const countBefore = spawnCalls.length;
  // Now start app — api should not re-spawn
  await pm2.startProcess('sai', 'app', configs, {}, '/projects/sai');
  const newCommands = spawnCalls.slice(countBefore).map(c => c.command);
  expect(newCommands).not.toContain('api');
  expect(newCommands).toContain('app');
});

test('startProcess merges envFileCommand output on top of inline env and envFile', async () => {
  const localPm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
    envCommandRunner: async (argv) => {
      expect(argv).toEqual(['decrypt-tool', 'secrets.enc']);
      return { ok: true, env: { SECRET_KEY: 'decrypted-value', LOG_LEVEL: 'debug' } };
    },
  });
  const configs = [{
    name: 'api',
    command: 'npm start',
    cwd: '.',
    ports: [3000],
    portEnv: 'PORT',
    env: { LOG_LEVEL: 'info', PUBLIC_VAR: 'visible' },
    envFileCommand: ['decrypt-tool', 'secrets.enc'],
  }];
  await localPm.up('sai', configs, allocations, '/projects/sai');

  expect(spawnCalls).toHaveLength(1);
  const apiEnv = spawnCalls[0].env;
  expect(apiEnv.SECRET_KEY).toBe('decrypted-value');     // from envFileCommand
  expect(apiEnv.LOG_LEVEL).toBe('debug');                // envFileCommand overrides inline env
  expect(apiEnv.PUBLIC_VAR).toBe('visible');             // inline still passes through
  expect(apiEnv.PORT).toBe('3000');                      // portEnv still injected
});

test('envFileCommand failure prevents spawn and records error in buffer', async () => {
  const failPm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
    envCommandRunner: async () => ({ ok: false, error: 'exit 1\nstderr:\nbad metadata' }),
  });
  const configs = [{
    name: 'api',
    command: 'npm start',
    cwd: '.',
    ports: [3000],
    portEnv: 'PORT',
    envFileCommand: ['decrypt-tool', 'secrets.enc'],
  }];
  await failPm.up('sai', configs, allocations, '/projects/sai');

  // The process must NOT have been spawned.
  expect(spawnCalls).toHaveLength(0);
  // Status should be crashed.
  expect(failPm.isRunning('sai', 'api')).toBe(false);
  // The buffer should contain the structured error so the dashboard can show it.
  const buf = failPm.getBuffer('sai', 'api').join('');
  expect(buf).toMatch(/envFileCommand failed for "api"/);
  expect(buf).toMatch(/exit 1/);
  expect(buf).toMatch(/bad metadata/);
  // Multi-line errors must use \r\n so xterm renders each line at column 0.
  expect(buf).toMatch(/exit 1\r\nstderr/);
});

test('envFileCommand failure with CRLF-tainted stderr does not produce \\r\\r\\n', async () => {
  // Regression: some decrypt tools emit CRLF on stderr. A naive /\n/g
  // normalizer would turn the \n inside \r\n into \r\n, yielding \r\r\n
  // which xterm renders with a double carriage return glitch.
  const crlfPm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
    envCommandRunner: async () => ({ ok: false, error: 'exit 1\r\nstderr:\r\noops' }),
  });
  const configs = [{
    name: 'api',
    command: 'npm start',
    cwd: '.',
    ports: [3000],
    portEnv: 'PORT',
    envFileCommand: ['decrypt-tool', 'secrets.enc'],
  }];
  await crlfPm.up('sai', configs, allocations, '/projects/sai');

  const buf = crlfPm.getBuffer('sai', 'api').join('');
  expect(buf).not.toMatch(/\r\r\n/);
  expect(buf).toMatch(/exit 1\r\nstderr/);
});

test('non-array envFileCommand fails through helper validation (not silently skipped)', async () => {
  // Regression guard: a string-typed envFileCommand (user config error) MUST
  // surface as a clear failure, not silently spawn without secrets.
  const stringPm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
    envCommandRunner: async (argv) => {
      // Real helper would return this; stub it here so the test doesn't depend on it.
      if (!Array.isArray(argv) || argv.length === 0) {
        return { ok: false, error: 'envFileCommand must be a non-empty array' };
      }
      return { ok: true, env: {} };
    },
  });
  const configs = [{
    name: 'api',
    command: 'npm start',
    cwd: '.',
    ports: [3000],
    portEnv: 'PORT',
    envFileCommand: 'sops -d secrets.enc',   // wrong: string instead of array
  }];
  await stringPm.up('sai', configs, allocations, '/projects/sai');

  expect(spawnCalls).toHaveLength(0);
  expect(stringPm.isRunning('sai', 'api')).toBe(false);
  const buf = stringPm.getBuffer('sai', 'api').join('');
  expect(buf).toMatch(/envFileCommand must be a non-empty array/);
});

test('startOne behaves unchanged when envFileCommand is absent', async () => {
  // Sanity: existing path is undisturbed. Uses the default real envCommandRunner,
  // which is never called because no process declares envFileCommand.
  await pm.up('sai', processConfigs, allocations, '/projects/sai');
  expect(spawnCalls).toHaveLength(2);
});

const { getDefaultShell } = require('../src/daemon/process-manager');

describe('getDefaultShell', () => {
  const savedShell = process.env.SHELL;

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  test('returns process.env.SHELL when it is set to a non-zsh shell', () => {
    process.env.SHELL = '/usr/bin/fish';
    expect(getDefaultShell('linux')).toBe('/usr/bin/fish');
    expect(getDefaultShell('darwin')).toBe('/usr/bin/fish');
  });

  test('skips zsh in process.env.SHELL — zsh strips env vars with hyphens at startup', () => {
    // zsh silently drops env vars whose names aren't valid POSIX identifiers
    // (e.g. .NET-style `ConnectionStrings__Foo-Bar`). bash/sh propagate them.
    // macOS defaults SHELL=/bin/zsh, so most macOS users would be affected.
    process.env.SHELL = '/bin/zsh';
    expect(getDefaultShell('darwin')).toBe('/bin/sh');
    expect(getDefaultShell('linux')).toBe('/bin/sh');

    // Match other zsh paths (homebrew, asdf, etc.) too.
    process.env.SHELL = '/opt/homebrew/bin/zsh';
    expect(getDefaultShell('darwin')).toBe('/bin/sh');
  });

  test('falls back to /bin/sh on POSIX when SHELL is unset', () => {
    delete process.env.SHELL;
    expect(getDefaultShell('darwin')).toBe('/bin/sh');
    expect(getDefaultShell('linux')).toBe('/bin/sh');
  });
});

test('startOne does not spawn an orphan PTY if down() races a slow envFileCommand', async () => {
  // Regression for the race: user issues `forge down` while a long-running
  // envCommandRunner is still resolving. killOne removes the record from the
  // map; when the await resolves, startOne must NOT proceed to spawnFn —
  // otherwise we'd create an orphaned PTY that can never be killed.
  let releaseRunner;
  const racePm = createProcessManager({
    ptySpawn: (command, env, cwd) => {
      const mock = makeMockPty();
      spawnCalls.push({ command, env, cwd, mock });
      return mock;
    },
    envCommandRunner: () => new Promise(res => { releaseRunner = res; }),
  });
  const configs = [{
    name: 'api',
    command: 'npm start',
    cwd: '.',
    ports: [3000],
    portEnv: 'PORT',
    envFileCommand: ['slow-decrypt'],
  }];
  // Kick off startProcess but don't await yet.
  const upPromise = racePm.up('sai', configs, allocations, '/projects/sai');
  // Simulate user calling forge down while the runner is still suspended.
  // (The full down() can't run because it'd find the live-map record and try
  // to kill a non-existent PTY. Use stopProcess + manual record removal to
  // simulate killOne's effect on this code path.)
  await new Promise(setImmediate);
  racePm.stopProcess('sai', 'api');
  // Now resolve the runner with success — the merge-and-spawn path will run.
  releaseRunner({ ok: true, env: { SECRET: 'x' } });
  await upPromise;
  // The bail-out guard must prevent spawnFn from being called.
  expect(spawnCalls).toHaveLength(0);
});

const { getShellInvokeFlag } = require('../src/daemon/process-manager');

describe('getShellInvokeFlag', () => {
  test('returns -c on POSIX platforms', () => {
    expect(getShellInvokeFlag('darwin')).toBe('-c');
    expect(getShellInvokeFlag('linux')).toBe('-c');
  });

  test('returns /c on win32', () => {
    expect(getShellInvokeFlag('win32')).toBe('/c');
  });

  test('defaults to process.platform when called with no args', () => {
    const expected = process.platform === 'win32' ? '/c' : '-c';
    expect(getShellInvokeFlag()).toBe(expected);
  });
});

describe('getDefaultShell — win32 branch', () => {
  const savedShell = process.env.SHELL;
  const savedComspec = process.env.COMSPEC;

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
    if (savedComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = savedComspec;
  });

  test('ignores process.env.SHELL on win32 (avoids bash /c "..." mismatch under Git Bash)', () => {
    // Git Bash on Windows sets SHELL=/usr/bin/bash, but getShellInvokeFlag()
    // returns `/c` on win32 — bash wants -c, so honoring SHELL on win32 would
    // produce a broken spawn. Pin to COMSPEC/cmd.exe on win32 instead.
    process.env.SHELL = '/usr/bin/bash';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    expect(getDefaultShell('win32')).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  test('falls back to COMSPEC on win32 when SHELL is unset', () => {
    delete process.env.SHELL;
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    expect(getDefaultShell('win32')).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  test('falls back to literal "cmd.exe" on win32 when SHELL and COMSPEC are unset', () => {
    delete process.env.SHELL;
    delete process.env.COMSPEC;
    expect(getDefaultShell('win32')).toBe('cmd.exe');
  });
});

describe('expandCommandVars', () => {
  const { expandCommandVars } = require('../src/daemon/process-manager');

  test('expands ${VAR}, $VAR, and %VAR% forms from the env map', () => {
    const env = { PORT: '3020', API_PORT: 8300 };
    expect(expandCommandVars('serve --port ${PORT}', env)).toBe('serve --port 3020');
    expect(expandCommandVars('serve --port $PORT', env)).toBe('serve --port 3020');
    expect(expandCommandVars('serve --port %PORT%', env)).toBe('serve --port 3020');
    expect(expandCommandVars('proxy $API_PORT', env)).toBe('proxy 8300');
  });

  test('leaves unknown vars untouched for the shell', () => {
    expect(expandCommandVars('echo $HOME_UNSET_XYZ ${ALSO_UNSET} %NOPE%', {}))
      .toBe('echo $HOME_UNSET_XYZ ${ALSO_UNSET} %NOPE%');
  });

  test('does not mangle subshells, ${VAR:-default}, or lone % signs', () => {
    const env = { PORT: '3020' };
    expect(expandCommandVars('echo $(date) ${PORT:-9999} 100%', env))
      .toBe('echo $(date) ${PORT:-9999} 100%');
  });

  test('longest-name match: $PORT does not clobber $PORT_EXTRA', () => {
    const env = { PORT: '3020', PORT_EXTRA: '9' };
    expect(expandCommandVars('run $PORT_EXTRA then $PORT', env)).toBe('run 9 then 3020');
  });

  test('startOne spawns the command with vars already expanded', async () => {
    const calls = [];
    const mgr = createProcessManager({
      ptySpawn: (command, env, cwd) => { calls.push(command); return makeMockPty(); },
    });
    const configs = [{ name: 'app', command: 'vite --port $PORT', cwd: '.', ports: [3020], portEnv: 'PORT' }];
    await mgr.up('proj', configs, { ports: { app: 3020 }, services: {} }, '/projects/proj');
    expect(calls).toEqual(['vite --port 3020']);
  });

  test('startOne does NOT textually expand process.env vars — the shell handles those', async () => {
    // Narrowed scope: only forge-injected vars are substituted here. Ambient
    // vars like $HOME are left for the shell to expand against the child's env
    // (process.env is merged in at spawn), so a value containing shell
    // metacharacters can't be re-parsed by pre-substitution.
    const calls = [];
    const prevHome = process.env.HOME;
    process.env.HOME = '/tmp/should; not-expand';
    try {
      const mgr = createProcessManager({
        ptySpawn: (command) => { calls.push(command); return makeMockPty(); },
      });
      const configs = [{ name: 'app', command: 'run $HOME --port $PORT', cwd: '.', ports: [3020], portEnv: 'PORT' }];
      await mgr.up('proj', configs, { ports: { app: 3020 }, services: {} }, '/projects/proj');
      expect(calls).toEqual(['run $HOME --port 3020']);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
  });
});
