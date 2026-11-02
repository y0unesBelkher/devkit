import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import { DAEMON_PATHS, type ProcessKind, type Site, type SiteProcess } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import { fnmDir, listNodeVersions, nodeBinDir, userHome } from '../node/fnm.ts';
import { unitStates } from '../services/system-tools.ts';
import type { ProcessRow, Store } from '../store.ts';

const UNIT_DIR = '/etc/systemd/system';
const SCRIPT_DIR = join(DAEMON_PATHS.stateDir, 'processes');

export const unitName = (id: string) => `devkit-proc-${id}.service`;
const scriptPath = (id: string) => join(SCRIPT_DIR, `${id}.sh`);

/** Defaults for Laravel's long-running commands; `php` is DevKit's shim, so the site's PHP version is used. */
export const LARAVEL_PROCESSES: Record<'queue' | 'schedule' | 'horizon', { name: string; command: string }> = {
  queue: { name: 'Queue worker', command: 'php artisan queue:work --tries=3' },
  schedule: { name: 'Scheduler', command: 'php artisan schedule:work' },
  horizon: { name: 'Horizon', command: 'php artisan horizon' },
};

/**
 * The project's own Angular CLI, bound to loopback; nginx terminates TLS and proxies (with WebSockets for
 * live reload). nginx sends Host: localhost, so Vite's host check stays on without per-site flags.
 */
export function ngServeCommand(site: Site): string {
  return `npx ng serve --host 127.0.0.1 --port ${site.port}`;
}

export function validateCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new HttpError(422, 'Command must not be empty');
  if (trimmed.length > 1000 || /[\r\n]/.test(trimmed)) throw new HttpError(422, 'Command must be a single line');
  return trimmed;
}

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The command runs from a script so nothing in it needs systemd quoting. */
export function renderScript(process: ProcessRow, site: Site): string {
  return `#!/bin/bash
# Managed by DevKit - ${site.domain}: ${process.name}
cd ${shQuote(site.root)} || exit 1
${process.command}
`;
}

export function renderUnit(process: ProcessRow, site: Site, user: string, group: string, nodeVersion: string | null): string {
  const path = [nodeVersion ? nodeBinDir(user, nodeVersion) : null, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  return `# Managed by DevKit - edits are overwritten.
[Unit]
Description=DevKit ${site.domain}: ${process.name}
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${user}
Group=${group}
WorkingDirectory=${site.root}
Environment="PATH=${path}"
Environment="HOME=${userHome(user)}"
Environment="USER=${user}"
Environment="FNM_DIR=${fnmDir(user)}"
Environment="NG_CLI_ANALYTICS=false"
Environment="NO_COLOR=1"
Environment="FORCE_COLOR=0"
ExecStart=/bin/bash ${scriptPath(process.id)}
Restart=always
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
`;
}

async function systemctl(...args: string[]): Promise<void> {
  const result = await run(['systemctl', ...args], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new HttpError(409, result.stderr.trim() || `systemctl ${args.join(' ')} failed`);
}

/** Writes (or rewrites) a process's script and unit, and applies its autostart setting. */
export async function installProcessUnit(process: ProcessRow, site: Site, user: string): Promise<void> {
  const group = (await run(['id', '-gn', user])).stdout.trim() || user;
  // Laravel sites can still run Node tooling (Vite); give them the newest Node.
  const nodeVersion = site.nodeVersion ?? listNodeVersions(user)[0] ?? null;
  mkdirSync(SCRIPT_DIR, { recursive: true, mode: 0o755 });
  writeFileSync(scriptPath(process.id), renderScript(process, site), { mode: 0o755 });
  writeFileSync(join(UNIT_DIR, unitName(process.id)), renderUnit(process, site, user, group, nodeVersion));
  await systemctl('daemon-reload');
  await systemctl(process.autostart ? 'enable' : 'disable', unitName(process.id));
}

export async function removeProcessUnit(id: string): Promise<void> {
  await run(['systemctl', 'disable', '--now', unitName(id)], { timeoutMs: 60_000 });
  rmSync(join(UNIT_DIR, unitName(id)), { force: true });
  rmSync(scriptPath(id), { force: true });
  await run(['systemctl', 'daemon-reload']);
  await run(['systemctl', 'reset-failed', unitName(id)]);
}

export function processAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  return systemctl(action, unitName(id));
}

export async function listProcesses(store: Store): Promise<SiteProcess[]> {
  const rows = store.listProcesses();
  if (rows.length === 0) return [];
  const states = await unitStates(rows.map((row) => unitName(row.id)));
  return rows.map((row) => ({
    ...row,
    unit: unitName(row.id),
    active: states.get(unitName(row.id))?.active ?? 'missing',
  }));
}

export async function getProcess(store: Store, id: string): Promise<SiteProcess> {
  const process = (await listProcesses(store)).find((p) => p.id === id);
  if (!process) throw new HttpError(404, 'Unknown process');
  return process;
}

/** Which process kinds a site type may have. */
export function allowedKinds(site: Site): ProcessKind[] {
  if (site.type === 'angular') return ['ng-serve', 'custom'];
  if (site.type === 'laravel') return ['queue', 'schedule', 'horizon', 'custom'];
  return ['custom'];
}

/** Lowest free dev-server port from `start`, skipping ports other sites hold and anything listening in WSL. */
export async function allocatePort(store: Store, start: number): Promise<number> {
  const taken = new Set(store.listSites().map((site) => site.port).filter((port): port is number => port !== null));
  const listening = await run(['ss', '-Hltn']);
  for (const match of listening.stdout.matchAll(/:(\d+)\s/g)) taken.add(Number(match[1]));
  let port = start;
  while (taken.has(port)) port++;
  return port;
}
