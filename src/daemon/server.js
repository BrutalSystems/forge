// src/daemon/server.js
const express = require('express');
const http = require('http');
const { FORGE_PORT } = require('../constants');
const { createRegistry } = require('./registry');
const { createPortAllocator } = require('./port-allocator');
const { createServiceManager } = require('./services/manager');
const { createProcessManager } = require('./process-manager');
const { createHealthRoutes } = require('./api/health');
const { createProjectRoutes } = require('./api/projects');
const { createServicesRoutes } = require('./api/services');
const { createProcessRoutes } = require('./api/processes');
const path = require('path');
const fs   = require('fs');
const { createInstanceStore } = require('./services/instance-store');

const DRIVER_FACTORIES = {
  mongo: require('./services/drivers/mongo').createMongoDriver,
  postgres: require('./services/drivers/postgres').createPostgresDriver,
  redis: require('./services/drivers/redis').createRedisDriver,
  rabbitmq: require('./services/drivers/rabbitmq').createRabbitmqDriver,
};

const DEFAULT_DRIVERS = [
  require('./services/drivers/mongo'),
  require('./services/drivers/redis'),
  require('./services/drivers/postgres'),
  require('./services/drivers/rabbitmq'),
];

function buildDriverList(instanceStore, driverFactories, defaultDrivers) {
  const instances = instanceStore.getAll();
  const overriddenBuiltIns = new Set(
    Object.keys(instances).filter(k => defaultDrivers.some(d => d.name === k))
  );

  const customAndOverrides = Object.entries(instances)
    .map(([key, cfg]) => {
      const isBuiltIn = defaultDrivers.some(d => d.name === key);
      const type = isBuiltIn ? key : cfg.type;
      const factory = driverFactories[type];
      if (!factory) return null;
      const containerName = isBuiltIn
        ? `forge-${key}`
        : `forge-${cfg.type}-${cfg.instance}`;
      return factory({ name: key, containerName, port: cfg.port, ...(cfg.options ?? {}) });
    })
    .filter(Boolean);

  return [
    ...defaultDrivers.filter(d => !overriddenBuiltIns.has(d.name)),
    ...customAndOverrides,
  ];
}

function createServer({ registry, portAllocator, serviceManager, processManager, instanceStore } = {}) {
  const reg = registry ?? createRegistry();
  const alloc = portAllocator ?? createPortAllocator();
  const store = instanceStore ?? createInstanceStore();
  const svcMgr = serviceManager ?? createServiceManager(
    buildDriverList(store, DRIVER_FACTORIES, DEFAULT_DRIVERS)
  );
  const pm = processManager ?? createProcessManager();

  alloc.restoreFromRegistry(reg.getAll());
  svcMgr.restoreFromRegistry(reg.getAll());

  const app = express();
  app.use(express.json());
  app.use('/api/health', createHealthRoutes());
  app.use('/api/projects', createProjectRoutes({ registry: reg, portAllocator: alloc, serviceManager: svcMgr, processManager: pm }));
  app.use('/api/services', createServicesRoutes({ serviceManager: svcMgr, registry: reg, instanceStore: store, driverFactories: DRIVER_FACTORIES, processManager: pm }));
  app.use('/api/projects/:name/processes', createProcessRoutes({ registry: reg, processManager: pm, serviceManager: svcMgr, portAllocator: alloc }));

  const server = http.createServer(app);

  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const projectName = url.searchParams.get('project');
    const processName = url.searchParams.get('process');

    if (!projectName || !processName) {
      ws.send(JSON.stringify({ type: 'error', message: 'project and process query params required' }));
      ws.close();
      return;
    }

    const project = reg.get(projectName);
    if (!project) {
      ws.send(JSON.stringify({ type: 'error', message: `Project "${projectName}" not found` }));
      ws.close();
      return;
    }

    // Subscribe before reading snapshot to avoid missing events that fire between the two
    const relay = (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    pm.subscribe(projectName, processName, relay);

    // Send current status and buffered output
    const status = pm.isRunning(projectName, processName) ? 'running' : 'stopped';
    ws.send(JSON.stringify({ type: 'status', status }));

    const buffered = pm.getBuffer(projectName, processName).join('\r\n');
    if (buffered) ws.send(JSON.stringify({ type: 'output', data: buffered }));

    ws.on('message', (raw) => {
      try {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'input')  pm.sendInput(projectName, processName, msg.data);
        if (msg.type === 'resize') pm.resize(projectName, processName, msg.cols, msg.rows);
        if (msg.type === 'start') {
          const p = reg.get(projectName);
          if (p) pm.startProcess(projectName, processName, p.config?.processes ?? [], p.allocations ?? {}, p.path, p.config?.services ?? {});
        }
        if (msg.type === 'stop') pm.stopProcess(projectName, processName);
      } catch (err) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => pm.unsubscribe(projectName, processName, relay));
  });

  const webDist = path.join(__dirname, '../../web/dist');
  app.use(express.static(webDist));
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return { app, server, wss, registry: reg, portAllocator: alloc, serviceManager: svcMgr, processManager: pm };
}

if (require.main === module) {
  const { server, processManager } = createServer();
  server.listen(FORGE_PORT, '127.0.0.1', () => {
    console.log(`Forge daemon listening on port ${FORGE_PORT}`);
  });
  const shutdown = () => { processManager.killAll(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

module.exports = { createServer, buildDriverList };
