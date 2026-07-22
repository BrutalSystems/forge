const request = require('supertest');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../../src/daemon/server');
const { createRegistry } = require('../../src/daemon/registry');
const { createPortAllocator } = require('../../src/daemon/port-allocator');
const { createServiceManager } = require('../../src/daemon/services/manager');
const { findFreePort } = require('../helpers/find-free-port');

const TEST_PROJECT_PATH = path.join(os.tmpdir(), 'sai');

function tmpServer() {
  const p = path.join(os.tmpdir(), `forge-api-test-${Date.now()}.json`);
  const registry = createRegistry(p);
  const portAllocator = createPortAllocator();
  // Empty service manager — no drivers, safe for projects with services: {}
  const serviceManager = createServiceManager([]);
  const { app } = createServer({ registry, portAllocator, serviceManager });
  return { app, cleanup: () => fs.existsSync(p) && fs.unlinkSync(p) };
}

let candidatePorts;

beforeAll(async () => {
  // Get fresh OS-assigned ports for test configs — avoids hardcoded port conflicts
  candidatePorts = await Promise.all([findFreePort(), findFreePort(), findFreePort(), findFreePort()]);
});

function makeConfig(overrides = {}) {
  return {
    name: 'sai',
    path: TEST_PROJECT_PATH,
    envFile: '.env.forge',
    processes: [
      { name: 'api', command: 'echo hi', cwd: '.', ports: [candidatePorts[0], candidatePorts[1]], portEnv: 'PORT' }
    ],
    services: {},
    ...overrides,
  };
}

test('GET /api/health returns ok', async () => {
  const { app, cleanup } = tmpServer();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  cleanup();
});

test('GET /api/projects returns empty array initially', async () => {
  const { app, cleanup } = tmpServer();
  const res = await request(app).get('/api/projects');
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
  cleanup();
});

test('POST /api/projects/register returns allocated port', async () => {
  const { app, cleanup } = tmpServer();
  const res = await request(app).post('/api/projects/register').send(makeConfig());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(typeof res.body.allocations.ports.api).toBe('number');
  cleanup();
});

test('POST /api/projects/register returns 400 without name', async () => {
  const { app, cleanup } = tmpServer();
  const res = await request(app).post('/api/projects/register').send({ path: path.join(os.tmpdir(), 'x') });
  expect(res.status).toBe(400);
  cleanup();
});

test('POST /api/projects/register returns 409 when already registered', async () => {
  const { app, cleanup } = tmpServer();
  await request(app).post('/api/projects/register').send(makeConfig());
  const res = await request(app).post('/api/projects/register').send(makeConfig());
  expect(res.status).toBe(409);
  cleanup();
});

test('GET /api/projects/:name returns project data', async () => {
  const { app, cleanup } = tmpServer();
  await request(app).post('/api/projects/register').send(makeConfig());
  const res = await request(app).get('/api/projects/sai');
  expect(res.status).toBe(200);
  expect(res.body.name).toBe('sai');
  cleanup();
});

test('GET /api/projects/:name returns 404 for unknown project', async () => {
  const { app, cleanup } = tmpServer();
  expect((await request(app).get('/api/projects/nobody')).status).toBe(404);
  cleanup();
});

test('DELETE /api/projects/:name removes project', async () => {
  const { app, cleanup } = tmpServer();
  await request(app).post('/api/projects/register').send(makeConfig());
  expect((await request(app).delete('/api/projects/sai')).status).toBe(200);
  expect((await request(app).get('/api/projects/sai')).status).toBe(404);
  cleanup();
});

test('POST /api/projects/:name/sync re-allocates ports for updated config', async () => {
  const { app, cleanup } = tmpServer();
  await request(app).post('/api/projects/register').send(makeConfig());
  const updated = makeConfig({
    processes: [
      { name: 'api', command: 'echo hi', cwd: '.', ports: [candidatePorts[0], candidatePorts[1]], portEnv: 'PORT' },
      { name: 'worker', command: 'echo', cwd: '.', ports: [candidatePorts[2], candidatePorts[3]], portEnv: 'PORT' },
    ],
  });
  const res = await request(app).post('/api/projects/sai/sync').send(updated);
  expect(res.status).toBe(200);
  expect(typeof res.body.allocations.ports.worker).toBe('number');
  cleanup();
});

// Regression: a running process that fell back to a later candidate (because
// its first candidate was busy at launch) must NOT be moved back to the first
// candidate when it frees up and a sync runs — the live process keeps that
// port, so its registry record must too. Previously sync did releaseAll +
// blind reserve and reset it, leaving `forge status` reporting a dead port.
test('POST /api/projects/:name/sync keeps a running process on its fallback port', async () => {
  const p = path.join(os.tmpdir(), `forge-api-test-${Date.now()}-keep.json`);
  const registry = createRegistry(p);
  const portAllocator = createPortAllocator();
  const serviceManager = createServiceManager([]);
  // Fake process manager: 'api' is running, everything else is not.
  const processManager = { isRunning: (_proj, proc) => proc === 'api' };
  const { app } = createServer({ registry, portAllocator, serviceManager, processManager });

  // Occupy the first candidate so registration falls back to the second.
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(candidatePorts[0], '127.0.0.1', r));

  const reg = await request(app).post('/api/projects/register').send(makeConfig());
  expect(reg.body.allocations.ports.api).toBe(candidatePorts[1]); // fell back

  // First candidate frees up.
  await new Promise((r) => blocker.close(r));

  // Sync while 'api' is still running — it must stay on the fallback port.
  const res = await request(app).post('/api/projects/sai/sync').send(makeConfig());
  expect(res.status).toBe(200);
  expect(res.body.allocations.ports.api).toBe(candidatePorts[1]);

  fs.existsSync(p) && fs.unlinkSync(p);
});

test('POST /api/projects/register stores empty services allocations', async () => {
  const { app, cleanup } = tmpServer();
  const res = await request(app).post('/api/projects/register').send(makeConfig());
  expect(res.status).toBe(200);
  expect(res.body.allocations.services).toEqual({});
  cleanup();
});

test('POST /api/projects/register rejects process named "up"', async () => {
  const { app, cleanup } = tmpServer();
  const config = makeConfig({ processes: [{ name: 'up', command: 'echo hi', cwd: '.', ports: [] }] });
  const res = await request(app).post('/api/projects/register').send(config);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/reserved/);
  cleanup();
});

test('POST /api/projects/register rejects process named "down"', async () => {
  const { app, cleanup } = tmpServer();
  const config = makeConfig({ processes: [{ name: 'down', command: 'echo hi', cwd: '.', ports: [] }] });
  const res = await request(app).post('/api/projects/register').send(config);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/reserved/);
  cleanup();
});
