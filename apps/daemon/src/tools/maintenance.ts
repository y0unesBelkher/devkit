import { existsSync } from 'node:fs';
import type { PackageUpdate, ToolUpdates } from '@devkit/shared';
import { run } from '../exec.ts';
import type { JobContext } from '../jobs.ts';
import { FNM_BIN, fnmDir, listNodeVersions, nodeBinDir, userHome } from '../node/fnm.ts';
import { asUser } from '../user-exec.ts';
import { COMPOSER_BIN, composerVersion, installComposer, latestComposerVersion } from './composer.ts';
import { outdatedGlobals, updateAllGlobals } from './npm-globals.ts';
import { phpToolInfo } from './php-extensions.ts';
import { installedPhpVersions } from '../sites/detect.ts';
import { packagesNeedingRepair, shortVersion } from '../services/system-tools.ts';

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
const APT_OPTS = ['-o', 'DPkg::Lock::Timeout=300', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

/** Packages DevKit installs and therefore offers to upgrade. */
const MANAGED_PACKAGE = /^(php\d+\.\d+-|nginx|mysql-|redis|postgresql)/;

/** Parses `apt list --upgradable`: "php8.4-fpm/noble 8.4.28-1… amd64 [upgradable from: 8.4.27-1…]". */
export function parseAptUpgradable(text: string): PackageUpdate[] {
  const updates: PackageUpdate[] = [];
  for (const line of text.split('\n')) {
    const match = /^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(line);
    if (!match?.[1] || !MANAGED_PACKAGE.test(match[1])) continue;
    updates.push({ name: match[1], current: shortVersion(match[3]!), latest: shortVersion(match[2]!) });
  }
  return updates;
}

export async function aptUpgradable(): Promise<PackageUpdate[]> {
  const result = await run(['apt', 'list', '--upgradable'], { env: { LANG: 'C' }, timeoutMs: 60_000 });
  return parseAptUpgradable(result.stdout);
}

/** Uses the cached apt lists, so it is fast; `refreshPackageLists` updates them. */
export async function toolUpdates(user: string): Promise<ToolUpdates> {
  const versions = listNodeVersions(user);
  const [apt, current, latest, npmLists] = await Promise.all([
    aptUpgradable(),
    composerVersion(),
    latestComposerVersion(),
    Promise.all(versions.map((v) => outdatedGlobals(user, v))),
  ]);
  const npm: Record<string, PackageUpdate[]> = {};
  versions.forEach((v, i) => (npm[v] = npmLists[i] ?? []));
  return {
    checkedAt: Date.now(),
    apt,
    composer: current && latest && current !== latest ? { name: 'composer', current, latest } : null,
    npm,
  };
}

export async function refreshPackageLists(ctx: JobContext): Promise<void> {
  await ctx.exec(['apt-get', 'update', ...APT_OPTS], APT_ENV);
  const updates = await aptUpgradable();
  ctx.log(updates.length ? `${updates.length} DevKit-managed package updates available.` : 'All DevKit-managed packages are current.');
}

export async function applyUpdates(ctx: JobContext, user: string, target: 'apt' | 'composer' | 'npm', nodeVersion?: string): Promise<void> {
  if (target === 'composer') return installComposer(ctx, user);
  if (target === 'npm') return updateAllGlobals(ctx, user, nodeVersion!);
  const packages = (await aptUpgradable()).map((u) => u.name);
  if (packages.length === 0) return ctx.log('Nothing to upgrade.');
  await ctx.exec(['apt-get', 'install', '--only-upgrade', '-y', ...APT_OPTS, ...packages], APT_ENV);
}

/**
 * Read-only checks of everything DevKit manages. Each check reports ✓/✗ and the job carries on,
 * so one broken tool does not hide the state of the others.
 */
export async function healthCheck(ctx: JobContext, user: string): Promise<void> {
  let failures = 0;
  const check = async (label: string, argv: string[], env?: Record<string, string>) => {
    const result = await run(argv, { env, timeoutMs: 120_000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
    const output = (result.stdout + result.stderr).trim().split('\n').filter(Boolean);
    if (result.code !== 0) failures++;
    ctx.log(`${result.code === 0 ? '✓' : '✗'} ${label}`);
    for (const line of output.slice(0, 12)) ctx.log(`    ${line}`);
  };

  ctx.log('== Packages');
  const broken = await packagesNeedingRepair();
  if (broken) failures++;
  ctx.log(broken ? `✗ ${broken} half-configured packages (repair from the Dashboard)` : '✓ dpkg is healthy');
  await check('nginx configuration', ['nginx', '-t']);

  ctx.log('== PHP');
  for (const version of await installedPhpVersions()) {
    await check(`PHP ${version} CLI`, [`php${version}`, '-v']);
    await check(`PHP ${version} FPM configuration`, [`php-fpm${version}`, '-t']);
    const info = await phpToolInfo(version);
    ctx.log(`    extensions on: ${info.extensions.filter((e) => e.enabled).map((e) => e.name).join(', ')}`);
  }

  ctx.log('== Composer');
  if (existsSync(COMPOSER_BIN)) {
    await check('composer diagnose', asUser(user, ['php', COMPOSER_BIN, 'diagnose', '--no-interaction', '--no-ansi']), {});
  } else {
    ctx.log('- Composer is not installed');
  }

  ctx.log('== Node.js');
  if (!existsSync(FNM_BIN)) ctx.log('- fnm is not installed');
  for (const version of listNodeVersions(user)) {
    const bin = nodeBinDir(user, version);
    await check(`Node ${version}`, asUser(user, [`${bin}/node`, '--version'], [bin]));
    await check(`npm (Node ${version})`, asUser(user, [`${bin}/npm`, '--version'], [bin]));
    if (existsSync(`${bin}/ng`)) {
      await check(`Angular CLI (Node ${version})`, asUser(user, ['env', 'NG_CLI_ANALYTICS=false', `${bin}/ng`, 'version'], [bin]));
    }
  }
  ctx.log(`   FNM_DIR ${fnmDir(user)} (home ${userHome(user)})`);

  ctx.log('== Failed units');
  const failed = await run(['systemctl', 'list-units', '--failed', '--no-legend', '--plain']);
  const lines = failed.stdout.trim().split('\n').filter(Boolean);
  if (lines.length) failures++;
  ctx.log(lines.length ? lines.map((l) => `✗ ${l}`).join('\n') : '✓ no failed systemd units');

  if (failures > 0) throw new Error(`${failures} check(s) need attention`);
  ctx.log('All checks passed.');
}

/** Removes a Node version unless a site still uses it. */
export async function uninstallNode(ctx: JobContext, user: string, version: string, usedBy: string[]): Promise<void> {
  if (usedBy.length) throw new Error(`Node ${version} is used by ${usedBy.join(', ')}; switch those sites first.`);
  await ctx.exec(asUser(user, ['env', `FNM_DIR=${fnmDir(user)}`, FNM_BIN, 'uninstall', version]));
}
