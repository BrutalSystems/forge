const Docker = require('dockerode');
const net = require('net');

const docker = new Docker();

// containerPort is the port the service listens on INSIDE the container
// (defaults to the host port for backward compatibility). Drivers with a
// fixed internal port (redis 6379, postgres 5432, rabbitmq 5672) pass it so
// custom host ports map correctly instead of binding a container port
// nothing listens on.
async function ensureContainerRunning({ image, name, port, containerPort = port, cmd, env = [], volumes = [] }) {
  const containers = await docker.listContainers({ all: true });
  const existing = containers.find(c => c.Names.includes(`/${name}`));

  if (existing) {
    if (existing.State === 'running') return;
    await docker.getContainer(existing.Id).start();
    return;
  }

  // Pull image if not present locally
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, err => err ? reject(err) : resolve());
    });
  });

  const container = await docker.createContainer({
    Image: image,
    name,
    Cmd: cmd,
    ExposedPorts: { [`${containerPort}/tcp`]: {} },
    HostConfig: {
      PortBindings: { [`${containerPort}/tcp`]: [{ HostPort: String(port) }] },
      RestartPolicy: { Name: 'unless-stopped' },
      ...(volumes.length > 0 ? { Binds: volumes } : {}),
    },
    Env: env,
  });
  await container.start();
}

// TCP probe — returns true if the service is accepting connections
function checkTcpHealth(host, port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

// True if a container with this exact name is currently running. Used by
// driver health checks so a foreign process squatting on the service's port
// doesn't read as "healthy" — a bare TCP probe can't tell the difference.
async function isContainerRunning(name) {
  const containers = await docker.listContainers();
  return containers.some(c => c.Names.includes(`/${name}`));
}

async function stopContainer(name) {
  const containers = await docker.listContainers({ all: true });
  const existing = containers.find(c => c.Names.includes(`/${name}`));
  if (!existing || existing.State !== 'running') return;
  await docker.getContainer(existing.Id).stop();
}

// Exec a command inside a running container. Returns { exitCode, output } so
// callers can verify success — a TCP-ready container is not necessarily a
// booted service (Docker's port proxy accepts connections before e.g. the
// RabbitMQ broker is up), so provisioning commands MUST check exit codes.
// Callers doing idempotent provisioning ("create if not exists") can still
// ignore specific failures, but explicitly. Output is the raw multiplexed
// stream (contains 8-byte frame headers) — fine for substring matching.
async function execInContainer(containerName, cmd) {
  const containers = await docker.listContainers();
  const existing = containers.find(c => c.Names.includes(`/${containerName}`));
  if (!existing) throw new Error(`Container "${containerName}" is not running`);
  const container = docker.getContainer(existing.Id);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  let output = '';
  await new Promise((resolve, reject) => {
    exec.start({}, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  });
  const info = await exec.inspect();
  return { exitCode: info.ExitCode, output };
}

module.exports = { ensureContainerRunning, isContainerRunning, stopContainer, checkTcpHealth, execInContainer };
