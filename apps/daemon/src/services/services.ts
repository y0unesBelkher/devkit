import { readdirSync } from 'node:fs';
import type { ServiceAction, ServiceStatus } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { catalog, findService, toInfo, type ServiceDefinition } from './catalog.ts';
import { installedPackages, packagesNeedingRepair, shortVersion, unitStates } from './system-tools.ts';

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
// Wait for unattended-upgrades instead of failing on the dpkg lock; keep existing config files.
const APT_OPTS = ['-o', 'DPkg::Lock::Timeout=300', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

export function requireService(id: string): ServiceDefinition {
  const def = findService(id);
  if (!def) throw new HttpError(404, `Unknown service "${id}"`);
  return def;
}

export async function listServices(): Promise<ServiceStatus[]> {
  const [versions, states] = await Promise.all([
    installedPackages(catalog.map((def) => def.package)),
    unitStates(catalog.map((def) => def.unit)),
  ]);
  return catalog.map((def) => {
    const version = versions.get(def.package);
    const state = states.get(def.unit);
    return {
      ...toInfo(def),
      installed: version !== undefined,
      version: version ? shortVersion(version) : null,
      active: state?.active ?? 'missing',
      enabled: state?.enabled ?? false,
    };
  });
}

export async function getService(id: string): Promise<ServiceStatus> {
  const status = (await listServices()).find((s) => s.id === id);
  if (!status) throw new HttpError(404, `Unknown service "${id}"`);
  return status;
}

export async function runServiceAction(def: ServiceDefinition, action: ServiceAction): Promise<ServiceStatus> {
  const current = await getService(def.id);
  if (!current.installed) throw new HttpError(409, `${def.name} is not installed`);
  const result = await run(['systemctl', action, def.unit], { timeoutMs: 90_000 });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `systemctl ${action} exited with ${result.code}`;
    throw new HttpError(409, detail);
  }
  return getService(def.id);
}

function hasPpa(ppa: string): boolean {
  const [owner, name] = ppa.split('/');
  try {
    return readdirSync('/etc/apt/sources.list.d').some((file) => file.includes(`${owner}-ubuntu-${name}`));
  } catch {
    return false;
  }
}

/** Finishes an interrupted dpkg run: configures unpacked packages, then lets apt fix dependencies. */
export async function repairPackages(ctx: JobContext): Promise<void> {
  // dpkg fails when some packages have unmet dependencies (e.g. a half-downloaded upgrade);
  // apt-get -f installs the missing versions and configures what dpkg left behind.
  await ctx.exec(['dpkg', '--configure', '-a', '--force-confdef', '--force-confold'], APT_ENV).catch((e: Error) => {
    ctx.log(`${e.message}; letting apt fix the remaining dependencies.`);
  });
  await ctx.exec(['apt-get', 'update', ...APT_OPTS], APT_ENV);
  await ctx.exec(['apt-get', 'install', '-f', '-y', ...APT_OPTS], APT_ENV);
  const remaining = await packagesNeedingRepair();
  if (remaining > 0) throw new Error(`${remaining} packages still need attention; see "dpkg --audit" in WSL.`);
  ctx.log('Package system is healthy.');
}

export async function installService(def: ServiceDefinition, ctx: JobContext): Promise<void> {
  const broken = await packagesNeedingRepair();
  if (broken > 0) {
    throw new Error(
      `Ubuntu's package system has ${broken} half-configured packages from an interrupted upgrade, so apt cannot install anything. ` +
        'Use "Repair package system" on the Dashboard first.',
    );
  }
  if (def.ppa && !hasPpa(def.ppa)) {
    ctx.log(`Adding ppa:${def.ppa}`);
    await ctx.exec(['add-apt-repository', '-y', `ppa:${def.ppa}`], APT_ENV);
  }
  await ctx.exec(['apt-get', 'update', ...APT_OPTS], APT_ENV);
  await ctx.exec(['apt-get', 'install', '-y', ...APT_OPTS, ...def.installPackages], APT_ENV);
  await ctx.exec(['systemctl', 'enable', '--now', def.unit]);
}

export async function uninstallService(def: ServiceDefinition, ctx: JobContext): Promise<void> {
  await ctx.exec(['systemctl', 'disable', '--now', def.unit]).catch(() => ctx.log(`(${def.unit} was not running)`));
  await ctx.exec(['apt-get', 'remove', '-y', ...APT_OPTS, ...def.removePackages], APT_ENV);
}
