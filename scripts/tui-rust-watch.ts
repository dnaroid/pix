import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const rustRoot = path.join(repoRoot, 'apps', 'tui-rust');
const watchRoots = [
  path.join(rustRoot, 'src'),
  path.join(rustRoot, 'tests'),
  path.join(rustRoot, 'Cargo.toml'),
];

const forwardArgs = process.argv.slice(2);

let child: ChildProcess | null = null;
let restarting = false;
let queuedRestart = false;
let debounceTimer: NodeJS.Timeout | null = null;
let watchers: FSWatcher[] = [];

function log(message: string) {
  process.stdout.write(`[tui-rust-watch] ${message}\n`);
}

function watchedDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const st = statSync(root);
  if (!st.isDirectory()) {
    return [];
  }

  const out = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'target' || entry.name === '.git') {
      continue;
    }
    out.push(...watchedDirectories(path.join(root, entry.name)));
  }
  return out;
}

function disposeWatchers() {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
}

function armWatchers() {
  disposeWatchers();

  const directories = [
    ...watchedDirectories(path.join(rustRoot, 'src')),
    ...watchedDirectories(path.join(rustRoot, 'tests')),
  ];

  for (const dir of directories) {
    const watcher = watch(dir, () => scheduleRestart());
    watcher.on('error', () => scheduleRestart());
    watchers.push(watcher);
  }

  const cargoToml = path.join(rustRoot, 'Cargo.toml');
  if (existsSync(cargoToml)) {
    const watcher = watch(cargoToml, () => scheduleRestart());
    watcher.on('error', () => scheduleRestart());
    watchers.push(watcher);
  }
}

function spawnCargo() {
  log(`starting cargo run ${forwardArgs.length ? `with args: ${forwardArgs.join(' ')}` : ''}`.trim());

  child = spawn(
    'cargo',
    ['run', '--manifest-path', 'apps/tui-rust/Cargo.toml', '--', ...forwardArgs],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  child.on('exit', (code, signal) => {
    const exited = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    log(`cargo exited with ${exited}`);
    child = null;

    if (queuedRestart) {
      queuedRestart = false;
      restartCargo();
    }
  });
}

function restartCargo() {
  if (restarting) {
    queuedRestart = true;
    return;
  }

  restarting = true;
  armWatchers();

  if (!child) {
    spawnCargo();
    restarting = false;
    return;
  }

  queuedRestart = false;
  log('change detected, restarting cargo...');
  const current = child;
  current.once('exit', () => {
    spawnCargo();
    restarting = false;
  });
  current.kill('SIGTERM');
}

function scheduleRestart() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    restartCargo();
  }, 100);
}

function shutdown(signal: NodeJS.Signals) {
  log(`received ${signal}, shutting down`);
  disposeWatchers();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!child) {
    process.exit(0);
  }
  const current = child;
  current.once('exit', () => process.exit(0));
  current.kill('SIGTERM');
}

for (const root of watchRoots) {
  if (!existsSync(root)) {
    throw new Error(`missing watch path: ${path.relative(repoRoot, root)}`);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

armWatchers();
spawnCargo();
