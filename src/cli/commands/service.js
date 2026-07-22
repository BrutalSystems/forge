// src/cli/commands/service.js
const chalk = require('chalk');
const client = require('../client');

const KNOWN_TYPES = ['mongo', 'postgres', 'redis', 'rabbitmq'];

module.exports = function registerService(program) {
  const service = program
    .command('service')
    .description('Show status of shared services, or manage named instances');

  // Bare: forge service — show running container health
  service.action(async () => {
    if (!await client.isDaemonRunning()) {
      console.error(chalk.red('Forge daemon is not running.'));
      process.exit(1);
    }
    const list = await client.getServices();
    if (list.length === 0) {
      console.log(chalk.dim('No shared services registered.'));
      return;
    }
    for (const svc of list) {
      const status = svc.healthy
        ? chalk.green('● healthy')
        : chalk.red('✗ unhealthy');
      console.log(`${status}  ${chalk.bold(svc.name)}  ${chalk.dim(svc.containerName)}`);
    }
  });

  service
    .command('up [name]')
    .description('Start one or all shared services')
    .action(async (name) => {
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      try {
        const result = await client.startServices(name);
        if (!result.ok) {
          for (const e of result.errors ?? []) {
            console.error(chalk.red(`✗ ${e.name}: ${e.error}`));
          }
          process.exit(1);
        }
        for (const n of result.started ?? []) {
          console.log(chalk.green(`✓ ${chalk.bold(n)}`) + chalk.dim('  started'));
        }
      } catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  service
    .command('down [name]')
    .description('Stop one or all shared services (blocked if a running project needs it)')
    .action(async (name) => {
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      try {
        const result = await client.stopServices(name);
        if (!result.ok && !(result.stopped || result.blocked)) {
          console.error(chalk.red(result.error ?? 'Failed to stop services'));
          process.exit(1);
        }
        for (const n of result.stopped ?? []) {
          console.log(chalk.green(`✓ ${chalk.bold(n)}`) + chalk.dim('  stopped'));
        }
        for (const b of result.blocked ?? []) {
          console.error(chalk.red(`✗ ${chalk.bold(b.name)}: ${b.reason}`));
        }
        if ((result.blocked ?? []).length > 0) process.exit(1);
      } catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  service
    .command('list')
    .description('List all shared services (built-in and named instances)')
    .action(async () => {
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      const instances = await client.listInstances();
      if (instances.length === 0) {
        console.log(chalk.dim('No shared services available.'));
        return;
      }
      for (const inst of instances) {
        const opts = Object.entries(inst.options ?? {})
          .filter(([, v]) => v)
          .map(([k]) => chalk.cyan(k))
          .join(', ');
        const tag = inst.builtIn ? chalk.dim(' built-in') : '';
        const portStr = inst.port ? chalk.dim(`port ${inst.port}`) : chalk.dim('no port');
        const status = inst.healthy === true
          ? chalk.green('● up  ')
          : inst.healthy === false
            ? chalk.red('✗ down')
            : chalk.dim('? n/a ');
        console.log(
          `${status}  ${chalk.bold(inst.key)}${tag}  ${portStr}${opts ? `  ${opts}` : ''}`
        );
      }
    });

  service
    .command('add <type> <name>')
    .description('Add a named service instance (e.g. forge service add mongo rs)')
    .option('--port <port>', 'Port to bind (default: auto-assigned)', parseInt)
    .option('--replica-set', 'Enable MongoDB replica set mode (mongo only)')
    .action(async (type, name, opts) => {
      if (!KNOWN_TYPES.includes(type)) {
        console.error(chalk.red(`Unknown service type "${type}". Valid types: ${KNOWN_TYPES.join(', ')}`));
        process.exit(1);
      }
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      const result = await client.addInstance(type, name, { port: opts.port, replicaSet: opts.replicaSet });
      if (result.error) {
        console.error(chalk.red(result.error));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Added ${chalk.bold(result.key)} on port ${result.port}`));
      console.log(chalk.dim(`  Reference in .forge/config.json as "${result.key}"`));
    });

  service
    .command('remove <type> <name>')
    .description('Remove a named service instance')
    .action(async (type, name) => {
      const key = `${type}:${name}`;
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      const result = await client.removeInstance(key);
      if (result.error) {
        console.error(chalk.red(result.error));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Removed ${chalk.bold(key)}`));
    });

  service
    .command('configure <type> [name]')
    .description('Update options for a service instance (omit name for the built-in default)')
    .option('--port <port>', 'Change the bound port', parseInt)
    .option('--replica-set', 'Enable MongoDB replica set mode')
    .option('--no-replica-set', 'Disable MongoDB replica set mode')
    .action(async (type, name, opts) => {
      const key = name ? `${type}:${name}` : type;
      if (!await client.isDaemonRunning()) {
        console.error(chalk.red('Forge daemon is not running.'));
        process.exit(1);
      }
      const updates = {};
      if (opts.port !== undefined) updates.port = opts.port;
      if (opts.replicaSet !== undefined) updates.options = { replicaSet: opts.replicaSet };
      const result = await client.configureInstance(key, updates);
      if (result.error) {
        console.error(chalk.red(result.error));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Updated ${chalk.bold(key)}`));
      if (!name) {
        // The driver is rebuilt only when the daemon boots (buildDriverList), and
        // options like port/replicaSet are baked into the container at creation time.
        // A plain 'service down && up' restarts the *existing* container unchanged,
        // so it must be removed and the daemon restarted for the new options to apply.
        // After the daemon comes back, `forge reload` re-provisions each project so
        // .env.forge picks up the new connection string (e.g. ?replicaSet=rs0).
        console.log(chalk.dim(`  To apply: stop dependents, then 'forge service down ${type}',`));
        console.log(chalk.dim(`  'docker rm forge-${type}', and restart the forge daemon.`));
        console.log(chalk.dim(`  Then run 'forge reload' in each project that uses ${type} to refresh .env.forge.`));
      }
    });
};
