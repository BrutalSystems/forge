// npm lifecycle `prepare` for folder/git installs: install the dashboard's
// deps and build it.
//
// Why a script instead of `npm install --prefix web && npm run build:web`:
// on Windows, `npm install --prefix web` executed from the package root
// re-runs the ROOT package's prepare script (npm resolves the project from
// cwd, not from --prefix), recursing until the nested PATH prepends overflow
// cmd.exe's 8191-char limit. The env flag breaks that cycle deterministically
// on every platform.
'use strict';

if (process.env.FORGE_PREPARE_ACTIVE) process.exit(0);

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env, FORGE_PREPARE_ACTIVE: '1' };

function run(args, cwd) {
  // shell:true so `npm` resolves to npm.cmd on Windows.
  const result = spawnSync('npm', args, { cwd, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Run both steps inside web/. `npm run build:web` at the root previously
// resolved `vite` against root/node_modules — which doesn't have it, since
// vite is a web/-only devDependency. Running `npm run build` from web/ uses
// the local .bin, so root doesn't need vite installed.
run(['install'], path.join(root, 'web'));
run(['run', 'build'], path.join(root, 'web'));
