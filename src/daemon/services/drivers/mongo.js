const { ensureContainerRunning, isContainerRunning, stopContainer, checkTcpHealth, execInContainer } = require('../docker');

const DEFAULT_NAME = 'mongo';
const DEFAULT_CONTAINER_NAME = 'forge-mongo';
const IMAGE = 'mongo:8.0.23';

// Linux kernels 6.19 through 7.0.13 broke the rseq ABI that the tcmalloc
// vendored into mongod 8.x relies on, so mongod refuses to start (SERVER-121912).
// Docker Desktop's VM kernel crossed into that range, which takes out every
// mongo 8.x tag — there is no fixed image to bump to. Letting glibc own the rseq
// registration keeps tcmalloc off the broken path, and mongod then starts
// normally. Costs some allocator performance; fine for local dev.
// Remove once the VM kernel reaches 7.0.14+, where the kernel-side fix landed.
const ENV = ['GLIBC_TUNABLES=glibc.pthread.rseq=1'];
const DEFAULT_PORT = 27017;

function createMongoDriver({ name = DEFAULT_NAME, containerName = DEFAULT_CONTAINER_NAME, port = DEFAULT_PORT, replicaSet = false } = {}) {
  // Custom ports need mongod itself to listen on ${port}: the container maps
  // port:port, and replica-set mode advertises 127.0.0.1:${port} as the member
  // address — which must be reachable from inside the container too.
  const cmd = (replicaSet || port !== DEFAULT_PORT)
    ? [
        ...(port !== DEFAULT_PORT ? ['--port', String(port)] : []),
        ...(replicaSet ? ['--replSet', 'rs0'] : []),
        '--bind_ip_all',
      ]
    : undefined;

  return {
    name,
    containerName,
    image: IMAGE,
    port,

    async start() {
      await ensureContainerRunning({ image: IMAGE, name: containerName, port, cmd, env: ENV, volumes: [`${containerName}-data:/data/db`] });
    },

    async healthCheck() {
      // Container identity + TCP: a foreign mongod on this port must not
      // read as healthy (it won't have our db/replica-set config).
      return (await isContainerRunning(containerName)) && checkTcpHealth('127.0.0.1', port);
    },

    ...(replicaSet ? {
      async postStart() {
        // Retry loop: TCP health passes before mongod accepts RS commands.
        // Also idempotent — if the volume already has RS state, rs.status().ok === 1 and we skip.
        let lastError = 'unknown';
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const { exitCode, output } = await execInContainer(containerName, [
              'mongosh', '--quiet', '--port', String(port), '--eval',
              `var s; try { s = rs.status(); } catch(e) { s = {ok:0}; } if (!s.ok) rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:${port}'}]});`,
            ]);
            if (exitCode === 0) return;
            lastError = output.trim().slice(-200);
          } catch (err) {
            lastError = String(err.message ?? err);
          }
        }
        throw new Error(`mongo replica set init failed on "${containerName}": ${lastError}`);
      },
    } : {}),

    // MongoDB creates databases lazily on first write — no provisioning needed.
    async provision(_projectName, _cfg) {},

    connectionString(projectName, cfg) {
      const db = cfg?.db || projectName;
      const suffix = replicaSet ? '?replicaSet=rs0' : '';
      return `mongodb://localhost:${port}/${db}${suffix}`;
    },

    async stop() {
      await stopContainer(containerName);
    },

    // Destructive DB cleanup is deferred to a future plan.
    async deprovision(_projectName) {},

    restoreFromRegistry(_projects) {},
  };
}

// Export singleton for production use. Tests use createMongoDriver() for isolation.
module.exports = createMongoDriver();
module.exports.createMongoDriver = createMongoDriver;
