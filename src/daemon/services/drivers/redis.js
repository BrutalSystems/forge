const { ensureContainerRunning, isContainerRunning, stopContainer, checkTcpHealth } = require('../docker');

const NAME = 'redis';
const CONTAINER_NAME = 'forge-redis';
const IMAGE = 'redis:7';
const PORT = 6379;

function createRedisDriver({ name = NAME, containerName = CONTAINER_NAME, port = PORT } = {}) {
  // projectName → database number (1–63). Database 0 is reserved.
  const dbNumbers = new Map();

  function nextAvailableDb() {
    const used = new Set(dbNumbers.values());
    for (let n = 1; n <= 63; n++) {
      if (!used.has(n)) return n;
    }
    throw new Error('All 63 Redis databases are allocated');
  }

  return {
    name,
    containerName,
    image: IMAGE,
    port,

    async start() {
      await ensureContainerRunning({
        image: IMAGE,
        name: containerName,
        port,
        containerPort: PORT, // redis-server always listens on 6379 inside the container
        // Override default of 16 databases to support up to 63 projects
        cmd: ['redis-server', '--databases', '64'],
      });
    },

    async healthCheck() {
      // Container identity + TCP: a foreign process on this port must not read as healthy.
      return (await isContainerRunning(containerName)) && checkTcpHealth('127.0.0.1', port);
    },

    async provision(projectName, _cfg) {
      if (dbNumbers.has(projectName)) return; // idempotent
      dbNumbers.set(projectName, nextAvailableDb());
    },

    connectionString(projectName, _cfg) {
      const n = dbNumbers.get(projectName);
      if (n == null) throw new Error(`No Redis allocation for project "${projectName}"`);
      return `redis://localhost:${port}/${n}`;
    },

    async stop() {
      await stopContainer(containerName);
    },

    async deprovision(projectName) {
      dbNumbers.delete(projectName);
    },

    restoreFromRegistry(projects) {
      for (const [projectName, project] of Object.entries(projects)) {
        const url = project.allocations?.services?.[name];
        if (!url) continue;
        // Parse db number from "redis://localhost:6379/N"
        const match = url.match(/\/(\d+)$/);
        if (match) dbNumbers.set(projectName, parseInt(match[1], 10));
      }
    },
  };
}

// Export singleton for production use. Tests use createRedisDriver() directly for isolated state.
module.exports = createRedisDriver();
module.exports.createRedisDriver = createRedisDriver;
