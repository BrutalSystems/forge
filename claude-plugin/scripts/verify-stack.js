#!/usr/bin/env node
// Port-level verification of a forge project. Run from the project root.
//
// Probes: the forge daemon (2525), every *_PORT export and URL-shaped value in
// .env.forge, and every candidate-port process in .forge/config.json. Exits
// non-zero listing exactly what is unreachable — "forge status says running"
// is not proof anything is listening.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const cwd = process.cwd();

function probe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

function parseEnvForge(file) {
  const targets = [];
  if (!fs.existsSync(file)) return targets;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (/_PORT$/.test(key) && /^\d+$/.test(value)) {
      targets.push({ label: `${key} (.env.forge)`, host: 'localhost', port: Number(value) });
    } else if (value.includes('://')) {
      try {
        const url = new URL(value.replace(/^(amqp|mongodb|redis|ws)(s)?:\/\//, 'http$2://'));
        if (url.port) targets.push({ label: `${key} (.env.forge)`, host: url.hostname, port: Number(url.port) });
      } catch { /* unparseable value — skip */ }
    }
  }
  return targets;
}

async function main() {
  const targets = [{ label: 'forge daemon', host: 'localhost', port: 2525 }];
  targets.push(...parseEnvForge(path.join(cwd, '.env.forge')));

  const configPath = path.join(cwd, '.forge', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`No .forge/config.json in ${cwd} — run from the project root.`);
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const covered = new Set(targets.map(t => t.port));
  for (const proc of config.processes ?? []) {
    // Candidate ports are a fallback when no portExportEnv landed in .env.forge:
    // probe the first candidate only, and only if nothing else covers it.
    const first = proc.ports?.[0];
    if (first && !covered.has(first)) {
      targets.push({ label: `${proc.name} (first candidate port — may have drifted)`, host: 'localhost', port: first });
    }
  }

  let failures = 0;
  for (const t of targets) {
    const ok = await probe(t.host, t.port);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${t.host}:${String(t.port).padEnd(5)}  ${t.label}`);
    if (!ok) failures++;
  }
  if (failures) {
    console.error(`\n${failures} target(s) unreachable. Check: forge status, forge logs <process>, docker ps.`);
    process.exit(1);
  }
  console.log('\nAll ports reachable. For a true end-to-end check, run the project smoke test (e.g. dev login).');
}

main();
