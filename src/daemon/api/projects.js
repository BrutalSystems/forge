// src/daemon/api/projects.js
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { writeEnvFile } = require('../../cli/env-file');

function writeConfigFile(projectPath, config) {
  const configPath = path.join(projectPath, '.forge', 'config.json');
  if (fs.existsSync(path.dirname(configPath))) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
}

function validateServicesConfig(servicesConfig) {
  return Object.entries(servicesConfig ?? {})
    .filter(([, cfg]) => !cfg?.env)
    .map(([name]) => `Service "${name}" has no "env" key — forge won't inject its connection string into processes`);
}

function createProjectRoutes({ registry, portAllocator, serviceManager, processManager }) {
  const router = Router();

  // `keepPort(procName)` returns a port to pin unconditionally (a process
  // already running on a known port), or null to reserve fresh from candidates.
  async function allocatePorts(config, keepPort = null) {
    const ports = {};
    const procs = (config.processes ?? []).filter((p) => p.ports?.length);
    // Pass 1: pin ports for processes we must keep, so pass 2's reservations
    // can't hand a kept port to a different process.
    if (keepPort) {
      for (const proc of procs) {
        const port = keepPort(proc.name);
        if (port != null) ports[proc.name] = portAllocator.keep(config.name, proc.name, port);
      }
    }
    // Pass 2: reserve the remaining processes from their candidate lists.
    for (const proc of procs) {
      if (ports[proc.name] != null) continue;
      ports[proc.name] = await portAllocator.reserve(config.name, proc.name, proc.ports);
    }
    return ports;
  }

  router.get('/', (_req, res) => {
    const all = registry.getAll();
    res.json(Object.entries(all).map(([name, data]) => ({ name, ...data })));
  });

  router.post('/register', async (req, res) => {
    const config = req.body;
    if (!config?.name) return res.status(400).json({ error: 'name is required' });
    const reserved = new Set(['up', 'down']);
    const badProc = (config.processes ?? []).find(p => reserved.has(p.name));
    if (badProc) {
      return res.status(400).json({ error: `Process name "${badProc.name}" is reserved` });
    }
    if (registry.get(config.name)) {
      return res.status(409).json({ error: `"${config.name}" is already registered` });
    }
    try {
      const ports = await allocatePorts(config);
      const services = await serviceManager.provision(config.name, config.services ?? {});
      const allocations = { ports, services };
      registry.add(config.name, { path: config.path, config, allocations });
      const warnings = validateServicesConfig(config.services);
      res.json({ ok: true, name: config.name, allocations, warnings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:name', (req, res) => {
    const project = registry.get(req.params.name);
    if (!project) return res.status(404).json({ error: `"${req.params.name}" not found` });
    res.json({ name: req.params.name, ...project });
  });

  router.delete('/:name', async (req, res) => {
    const project = registry.get(req.params.name);
    if (!project) {
      return res.status(404).json({ error: `"${req.params.name}" not found` });
    }
    try {
      await serviceManager.deprovision(req.params.name, project.config?.services ?? {});
      portAllocator.releaseAll(req.params.name);
      registry.remove(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:name/sync', async (req, res) => {
    const project = registry.get(req.params.name);
    if (!project) return res.status(404).json({ error: `"${req.params.name}" not found` });
    try {
      // TODO: safer sync would allocate-new into staging first, then deprovision-old,
      // so a bad config doesn't leave the project without allocations. Acceptable now
      // while provision is cheap and recoverable; revisit before adding stateful drivers.
      await serviceManager.deprovision(req.params.name, project.config?.services ?? {});
      // Preserve the ports of processes that are still running: they can't be
      // moved without a restart, and re-reserving from scratch would reset a
      // process on a fallback port back to its (now-free) first candidate —
      // orphaning the live process and leaving `forge status` reporting a port
      // nothing is listening on.
      const prevPorts = project.allocations?.ports ?? {};
      portAllocator.releaseAll(req.params.name);
      const ports = await allocatePorts({ ...req.body, name: req.params.name }, (procName) =>
        processManager?.isRunning(req.params.name, procName) && prevPorts[procName] != null
          ? prevPorts[procName]
          : null,
      );
      const services = await serviceManager.provision(req.params.name, req.body.services ?? {});
      const allocations = { ports, services };
      registry.update(req.params.name, { config: req.body, allocations });
      const warnings = validateServicesConfig(req.body.services);
      res.json({ ok: true, name: req.params.name, allocations, warnings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Default service configs when a dev enables a service via the UI
  function defaultServiceConfig(projectName, serviceName) {
    const base = projectName.replace(/^@[^/]+\//, '');
    if (serviceName === 'mongo') return { db: base, env: 'MONGODB_URL' };
    if (serviceName === 'redis') return { env: 'REDIS_URL' };
    return {};
  }

  router.post('/:name/services', async (req, res) => {
    const project = registry.get(req.params.name);
    if (!project) return res.status(404).json({ error: `"${req.params.name}" not found` });
    const { service } = req.body;
    if (!service) return res.status(400).json({ error: 'service is required' });
    if (project.config?.services?.[service]) {
      return res.status(409).json({ error: `Service "${service}" already enabled` });
    }
    try {
      const cfg = req.body.config ?? defaultServiceConfig(req.params.name, service);
      const newServices = { ...(project.config?.services ?? {}), [service]: cfg };
      const newConfig = { ...project.config, services: newServices };
      const provisioned = await serviceManager.provision(req.params.name, { [service]: cfg });
      const newAllocations = {
        ...project.allocations,
        services: { ...(project.allocations?.services ?? {}), ...provisioned },
      };
      registry.update(req.params.name, { config: newConfig, allocations: newAllocations });
      writeConfigFile(project.path, newConfig);
      const envFile = newConfig.envFile ?? '.env.forge';
      if (envFile !== false) writeEnvFile(project.path, envFile, newAllocations, newConfig);
      res.json({ ok: true, service, allocations: newAllocations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:name/services/:service', async (req, res) => {
    const project = registry.get(req.params.name);
    if (!project) return res.status(404).json({ error: `"${req.params.name}" not found` });
    const { service } = req.params;
    if (!project.config?.services?.[service]) {
      return res.status(404).json({ error: `Service "${service}" not enabled` });
    }
    try {
      await serviceManager.deprovision(req.params.name, { [service]: {} });
      const newServices = { ...(project.config.services) };
      delete newServices[service];
      const newAllocations = {
        ...project.allocations,
        services: { ...(project.allocations?.services ?? {}) },
      };
      delete newAllocations.services[service];
      const newConfig = { ...project.config, services: newServices };
      registry.update(req.params.name, { config: newConfig, allocations: newAllocations });
      writeConfigFile(project.path, newConfig);
      const envFile = newConfig.envFile ?? '.env.forge';
      if (envFile !== false) writeEnvFile(project.path, envFile, newAllocations, newConfig);
      res.json({ ok: true, service, allocations: newAllocations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createProjectRoutes };
