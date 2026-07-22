// Shared provisioning retry. A container that accepts TCP is not necessarily
// a booted service — Docker's port proxy answers before e.g. the RabbitMQ
// broker or postgres is ready — so provisioning commands are retried until
// their exit code (or output) proves they took effect, and FAIL LOUDLY if
// they never do. Silent provisioning failures cost hours downstream: the
// project starts "cleanly" against a vhost/database that doesn't exist.
async function retryProvision(what, attemptFn, { attempts = 20, delayMs = 1500, sleep } = {}) {
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let lastError = 'command never succeeded';
  for (let i = 0; i < attempts; i++) {
    try {
      if (await attemptFn()) return;
    } catch (err) {
      lastError = String(err.message ?? err);
    }
    if (i < attempts - 1) await wait(delayMs);
  }
  throw new Error(`Provisioning ${what} failed after ${attempts} attempts: ${lastError}`);
}

module.exports = { retryProvision };
