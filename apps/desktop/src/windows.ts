import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHostsBlock,
  hostsConflicts,
  type ActionResult,
  type ApiRequest,
  type CaInfo,
  type HostsEntry,
  type ListenMode,
  type NetworkInfo,
  type SitesResponse,
  type WindowsStatus,
} from '@devkit/shared';
import { api } from './daemon-client';

const HOSTS_FILE = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Runs a PowerShell script passed as -EncodedCommand, so no quoting is involved. */
function powershell(script: string, timeoutMs = 30_000): Promise<ProcResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeoutMs);
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function daemon<T>(request: ApiRequest): Promise<T> {
  const result = await api<T>(request);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Processes other than WSL's relay that listen on 80/443 on Windows (e.g. EnvKit's nginx). */
export async function portOwners(): Promise<{ port: number; process: string }[]> {
  const result = await powershell(
    'Get-NetTCPConnection -State Listen -LocalPort 80,443 -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { "$($_.LocalPort) $((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName)" }',
  );
  const seen = new Set<string>();
  const owners: { port: number; process: string }[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [port, name] = line.trim().split(/\s+/);
    if (!port || !name || name.toLowerCase() === 'wslrelay' || seen.has(`${port}/${name}`)) continue;
    seen.add(`${port}/${name}`);
    owners.push({ port: Number(port), process: name });
  }
  return owners.sort((a, b) => a.port - b.port);
}

async function isCaTrusted(thumbprint: string): Promise<boolean> {
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) return false;
  const result = await powershell(`Test-Path -LiteralPath 'Cert:\\CurrentUser\\Root\\${thumbprint}'`);
  return result.stdout.trim() === 'True';
}

function readHosts(): string {
  return readFileSync(HOSTS_FILE, 'utf8');
}

async function desiredHosts(): Promise<{ current: string; next: string; domains: string[]; network: NetworkInfo }> {
  const [network, { sites }] = await Promise.all([
    daemon<NetworkInfo>({ method: 'GET', path: '/api/network' }),
    daemon<SitesResponse>({ method: 'GET', path: '/api/sites' }),
  ]);
  const target = network.hostsTarget;
  const entries: HostsEntry[] = target ? sites.map((site) => ({ ip: target, domain: site.domain })) : [];
  const current = readHosts();
  return { current, next: applyHostsBlock(current, entries), domains: sites.map((s) => s.domain), network };
}

/** TCP connect from Windows, like the browser will; detects a dead localhost relay or a stale WSL IP. */
function canConnect(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function windowsStatus(): Promise<WindowsStatus> {
  const [hosts, owners, ca] = await Promise.all([
    desiredHosts(),
    portOwners(),
    daemon<CaInfo>({ method: 'GET', path: '/api/ca' }).catch(() => null),
  ]);
  const target = hosts.network.hostsTarget;
  return {
    network: hosts.network,
    recommendedMode: owners.length > 0 ? 'wsl-ip' : 'localhost',
    portOwners: owners,
    ca: ca ? { thumbprint: ca.thumbprint, trusted: await isCaTrusted(ca.thumbprint) } : null,
    hosts: { inSync: hosts.next === hosts.current, conflicts: hostsConflicts(hosts.current, hosts.domains) },
    // Only meaningful once there are sites for nginx to listen for.
    reachable: target && hosts.domains.length ? await canConnect(target, 443) : null,
  };
}

/** Adds the CA to CurrentUser\Root: no admin rights, but Windows asks the user to confirm. */
export async function trustCa(): Promise<ActionResult> {
  const ca = await daemon<CaInfo>({ method: 'GET', path: '/api/ca' });
  if (await isCaTrusted(ca.thumbprint)) return { ok: true, message: 'The DevKit CA is already trusted.' };
  const file = join(tmpdir(), `devkit-ca-${ca.thumbprint}.crt`);
  writeFileSync(file, ca.pem);
  try {
    const result = await exec('certutil.exe', ['-user', '-addstore', 'Root', file], 5 * 60_000);
    const trusted = await isCaTrusted(ca.thumbprint);
    return trusted
      ? { ok: true, message: 'Windows now trusts the DevKit CA. Restart the browser if a site still shows a warning.' }
      : { ok: false, message: `The CA was not added (${(result.stdout + result.stderr).trim().split(/\r?\n/).pop() ?? 'cancelled'}).` };
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Rewrites the DevKit block of the hosts file. Writing needs admin rights, so an elevated PowerShell
 * copies a prepared file over it (one UAC prompt). WriteAllBytes keeps the file's existing permissions.
 */
export async function syncHosts(): Promise<ActionResult> {
  const { current, next, network } = await desiredHosts();
  if (!network.hostsTarget) return { ok: false, message: 'Could not determine the WSL IP address.' };
  if (next === current) return { ok: true, message: 'The hosts file is already up to date.' };

  const staged = join(tmpdir(), `devkit-hosts-${Date.now()}.txt`);
  writeFileSync(staged, next, 'utf8');
  const inner =
    `[IO.File]::WriteAllBytes(${psQuote(HOSTS_FILE)}, [IO.File]::ReadAllBytes(${psQuote(staged)})); ` +
    'ipconfig /flushdns | Out-Null';
  const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
  try {
    const result = await powershell(
      `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
        `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}'; exit $p.ExitCode`,
      5 * 60_000,
    );
    if (readHosts() === next) return { ok: true, message: 'Hosts file updated.' };
    const reason = /cancel/i.test(result.stderr) ? 'the administrator prompt was declined' : result.stderr.trim() || `exit code ${result.code}`;
    return { ok: false, message: `The hosts file was not updated: ${reason}.` };
  } finally {
    rmSync(staged, { force: true });
  }
}

export async function setListenMode(mode: ListenMode): Promise<ActionResult> {
  await daemon<NetworkInfo>({ method: 'PUT', path: '/api/network', body: { mode } });
  const hosts = await syncHosts();
  return hosts.ok ? { ok: true, message: `Switched to ${mode} mode. ${hosts.message}` } : hosts;
}
