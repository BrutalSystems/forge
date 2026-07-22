const { ensureContainerRunning, isContainerRunning, stopContainer, checkTcpHealth, execInContainer } = require('../docker');
const { retryProvision } = require('./retry');

const NAME = 'rabbitmq';
const CONTAINER_NAME = 'forge-rabbitmq';
const IMAGE = 'rabbitmq:3';
const PORT = 5672;

function sanitizeVhost(name) {
  // vhost names may contain any characters but keep them filesystem-safe
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '') || 'forge';
}

function createRabbitmqDriver({ name = NAME, containerName = CONTAINER_NAME, port = PORT } = {}) {
  const vhosts = new Map();

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
        containerPort: PORT, // the broker always listens on 5672 inside the container
      });
    },

    async healthCheck() {
      // Container identity + TCP: a foreign process on this port must not read as healthy.
      return (await isContainerRunning(containerName)) && checkTcpHealth('127.0.0.1', port);
    },

    async provision(projectName, cfg) {
      if (vhosts.has(projectName)) return;
      const vhost = cfg?.vhost || sanitizeVhost(projectName);
      // TCP-ready ≠ broker booted (Docker's port proxy answers first), and
      // rabbitmqctl against a booting broker fails — so retry until the vhost
      // verifiably exists. add_vhost exits non-zero if it already exists,
      // which counts as success; list_vhosts is the source of truth.
      await retryProvision(`rabbitmq vhost "${vhost}"`, async () => {
        await execInContainer(containerName, ['rabbitmqctl', 'add_vhost', vhost]);
        const { exitCode, output } = await execInContainer(containerName, ['rabbitmqctl', 'list_vhosts']);
        return exitCode === 0 && output.split(/\r?\n/).some(line => line.trim() === vhost);
      });
      await retryProvision(`rabbitmq permissions on "${vhost}"`, async () => {
        const { exitCode } = await execInContainer(containerName, [
          'rabbitmqctl', 'set_permissions', '-p', vhost, 'guest', '.*', '.*', '.*',
        ]);
        return exitCode === 0;
      });
      vhosts.set(projectName, vhost);
    },

    connectionString(projectName, cfg) {
      const vhost = vhosts.get(projectName) ?? cfg?.vhost ?? sanitizeVhost(projectName);
      return `amqp://guest:guest@localhost:${port}/${encodeURIComponent(vhost)}`;
    },

    async stop() {
      await stopContainer(containerName);
    },

    async deprovision(projectName) {
      vhosts.delete(projectName);
    },

    restoreFromRegistry(projects) {
      for (const [projectName, project] of Object.entries(projects)) {
        const url = project.allocations?.services?.[name];
        if (!url) continue;
        const match = url.match(/\/([^/]*)$/);
        if (match) vhosts.set(projectName, decodeURIComponent(match[1]));
      }
    },
  };
}

const createRabbitMQDriver = createRabbitmqDriver;

module.exports = createRabbitmqDriver();
module.exports.createRabbitmqDriver = createRabbitmqDriver;
module.exports.createRabbitMQDriver = createRabbitMQDriver;
