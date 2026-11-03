#!/usr/bin/env node
/**
 * Runs a project-local PostgreSQL cluster in ./.pgdata on port 5433 using the
 * PostgreSQL binaries installed on this machine. Optional — any PostgreSQL 14+
 * reachable via DATABASE_URL works (see docker-compose.yml for a container).
 *
 *   node scripts/localdb.mjs start | stop | status
 *
 * Set PG_BIN to the PostgreSQL bin directory if it isn't found automatically.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const dataDir = path.join(root, '.pgdata');
const PORT = process.env.PGPORT_LOCAL ?? '5433';
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const candidates = [];
  if (process.platform === 'win32') {
    const base = 'C:/Program Files/PostgreSQL';
    if (existsSync(base)) for (const v of readdirSync(base).sort().reverse()) candidates.push(path.join(base, v, 'bin'));
  } else {
    candidates.push('/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  const hit = candidates.find((d) => existsSync(path.join(d, exe('pg_ctl'))));
  if (!hit) throw new Error('PostgreSQL binaries not found. Set PG_BIN or use docker compose up -d.');
  return hit;
}

const bin = findBin();
const run = (name, args, opts = {}) => spawnSync(path.join(bin, exe(name)), args, { stdio: 'inherit', ...opts });
const cmd = process.argv[2] ?? 'status';

if (cmd === 'start') {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('Initialising cluster in .pgdata …');
    run('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  }
  // Detach so the server outlives this process.
  const child = spawn(path.join(bin, exe('pg_ctl')), ['-D', dataDir, '-o', `-p ${PORT}`, '-l', path.join(dataDir, 'server.log'), '-w', 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    const r = spawnSync(path.join(bin, exe('pg_isready')), ['-h', 'localhost', '-p', PORT], { stdio: 'ignore' });
    if (r.status === 0) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  for (const db of ['edumin', 'edumin_test']) {
    spawnSync(path.join(bin, exe('createdb')), ['-h', 'localhost', '-p', PORT, '-U', 'postgres', db], { stdio: 'ignore' });
  }
  console.log(`PostgreSQL running on port ${PORT} (databases: edumin, edumin_test)`);
} else if (cmd === 'stop') {
  run('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']);
} else {
  run('pg_ctl', ['-D', dataDir, 'status']);
}
