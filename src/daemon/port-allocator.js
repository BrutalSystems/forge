const net = require('net');

function checkTcpAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function createPortAllocator() {
  // "project:process" → port number
  const reserved = new Map();

  return {
    async isAvailable(port) {
      for (const p of reserved.values()) {
        if (p === port) return false;
      }
      return checkTcpAvailable(port);
    },

    async reserve(project, process, candidates) {
      for (const port of candidates) {
        if (await this.isAvailable(port)) {
          reserved.set(`${project}:${process}`, port);
          return port;
        }
      }
      throw new Error(
        `No available port for ${project}:${process} — tried: ${candidates.join(', ')}`
      );
    },

    // Pin a port for a process unconditionally, without a TCP availability
    // check. Used to re-record the port a process is ALREADY running on: that
    // port reads as "in use" (the process is listening on it), so reserve()
    // and revalidate() would wrongly skip it and move the record to a free
    // candidate — silently orphaning the live process. See the sync route.
    keep(project, process, port) {
      reserved.set(`${project}:${process}`, port);
      return port;
    },

    release(project, process) {
      reserved.delete(`${project}:${process}`);
    },

    releaseAll(project) {
      for (const key of [...reserved.keys()]) {
        if (key.startsWith(`${project}:`)) reserved.delete(key);
      }
    },

    getAll() {
      return Object.fromEntries(reserved);
    },

    async revalidate(project, process, candidates) {
      const current = reserved.get(`${project}:${process}`);
      if (current == null) return null;
      if (await checkTcpAvailable(current)) return current;
      // Current port is occupied — release and re-allocate from candidates
      reserved.delete(`${project}:${process}`);
      for (const port of candidates) {
        if (await this.isAvailable(port)) {
          reserved.set(`${project}:${process}`, port);
          return port;
        }
      }
      throw new Error(
        `No available port for ${project}:${process} — tried: ${candidates.join(', ')}`
      );
    },

    restoreFromRegistry(projects) {
      for (const [name, project] of Object.entries(projects)) {
        for (const [proc, port] of Object.entries(project.allocations?.ports ?? {})) {
          reserved.set(`${name}:${proc}`, port);
        }
      }
    },
  };
}

module.exports = { createPortAllocator };
