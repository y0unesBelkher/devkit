import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { PHP_VERSIONS, type PhpExtension, type PhpExtensionAction, type PhpToolInfo } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { installedPackages } from '../services/system-tools.ts';

interface ExtensionDef {
  name: string;
  /** PHP module names the package provides (what phpenmod and conf.d use). */
  modules: string[];
  builtin?: boolean;
  toggleable?: boolean;
}

/** Extensions offered per PHP version; everything else stays available through apt directly. */
export const PHP_EXTENSIONS: ExtensionDef[] = [
  { name: 'bcmath', modules: ['bcmath'] },
  { name: 'curl', modules: ['curl'] },
  { name: 'gd', modules: ['gd'] },
  { name: 'imagick', modules: ['imagick'], toggleable: true },
  { name: 'intl', modules: ['intl'] },
  { name: 'mbstring', modules: ['mbstring'] },
  { name: 'memcached', modules: ['memcached'], toggleable: true },
  { name: 'mongodb', modules: ['mongodb'], toggleable: true },
  { name: 'mysql', modules: ['mysqli', 'pdo_mysql'] },
  { name: 'opcache', modules: ['opcache'], toggleable: true },
  { name: 'pcntl', modules: ['pcntl'], builtin: true },
  { name: 'pgsql', modules: ['pgsql', 'pdo_pgsql'] },
  { name: 'redis', modules: ['redis'], toggleable: true },
  { name: 'soap', modules: ['soap'] },
  { name: 'sqlite3', modules: ['sqlite3', 'pdo_sqlite'] },
  { name: 'swoole', modules: ['swoole'], toggleable: true },
  { name: 'xdebug', modules: ['xdebug'], toggleable: true },
  { name: 'xml', modules: ['dom', 'simplexml', 'xml'] },
  { name: 'zip', modules: ['zip'] },
];

/** Xdebug set up for step debugging on demand (XDEBUG_TRIGGER / browser extension), not on every request. */
const XDEBUG_SETTINGS = `; Managed by DevKit
xdebug.mode = debug,develop
xdebug.start_with_request = trigger
xdebug.client_host = 127.0.0.1
xdebug.client_port = 9003
`;

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
const APT_OPTS = ['-o', 'DPkg::Lock::Timeout=300', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

export function requirePhpVersion(version: string): string {
  if (!(PHP_VERSIONS as readonly string[]).includes(version)) throw new HttpError(404, `Unknown PHP version "${version}"`);
  if (!existsSync(`/etc/php/${version}`)) throw new HttpError(409, `PHP ${version} is not installed`);
  return version;
}

export function requireExtension(name: string): ExtensionDef {
  const def = PHP_EXTENSIONS.find((ext) => ext.name === name);
  if (!def) throw new HttpError(404, `Unknown extension "${name}"`);
  return def;
}

/** Module names enabled for a SAPI, from its conf.d ("20-intl.ini" → "intl"). */
export function enabledModules(confDirEntries: string[]): Set<string> {
  return new Set(confDirEntries.map((file) => file.replace(/^\d+-/, '').replace(/\.ini$/, '')).filter(Boolean));
}

function readConfD(version: string, sapi: 'fpm' | 'cli'): string[] {
  try {
    return readdirSync(`/etc/php/${version}/${sapi}/conf.d`);
  } catch {
    return [];
  }
}

export async function phpToolInfo(version: string): Promise<PhpToolInfo> {
  const [packages, release, cliModules] = await Promise.all([
    installedPackages(PHP_EXTENSIONS.filter((e) => !e.builtin).map((e) => `php${version}-${e.name}`)),
    run([`php${version}`, '-r', 'echo PHP_VERSION;']).then((r) => (r.code === 0 ? r.stdout.trim() : null)),
    run([`php${version}`, '-m']).then((r) => new Set(r.stdout.split('\n').map((line) => line.trim().toLowerCase()))),
  ]);
  const fpm = enabledModules(readConfD(version, 'fpm'));
  const extensions: PhpExtension[] = PHP_EXTENSIONS.map((ext) => {
    const installed = ext.builtin ? cliModules.has(ext.modules[0]!) : packages.has(`php${version}-${ext.name}`);
    const enabled = ext.builtin ? installed : installed && ext.modules.every((module) => fpm.has(module));
    return { name: ext.name, installed, enabled, builtin: !!ext.builtin, toggleable: !!ext.toggleable };
  });
  return { version, release, extensions };
}

async function reloadFpm(version: string): Promise<void> {
  await run(['systemctl', 'reload-or-restart', `php${version}-fpm`], { timeoutMs: 60_000 });
}

async function setEnabled(version: string, ext: ExtensionDef, enabled: boolean): Promise<void> {
  const result = await run([enabled ? 'phpenmod' : 'phpdismod', '-v', version, '-s', 'ALL', ...ext.modules]);
  if (result.code !== 0) throw new HttpError(500, result.stderr.trim() || `Could not ${enabled ? 'enable' : 'disable'} ${ext.name}`);
  await reloadFpm(version);
}

/** enable/disable run immediately; install/uninstall go through the apt job queue. */
export async function toggleExtension(version: string, name: string, action: 'enable' | 'disable'): Promise<void> {
  const ext = requireExtension(name);
  if (!ext.toggleable) throw new HttpError(422, `${name} cannot be switched off on its own`);
  if (!(await installedPackages([`php${version}-${name}`])).size) throw new HttpError(409, `${name} is not installed for PHP ${version}`);
  await setEnabled(version, ext, action === 'enable');
}

export function isQueuedAction(action: PhpExtensionAction): action is 'install' | 'uninstall' {
  return action === 'install' || action === 'uninstall';
}

export async function installExtension(ctx: JobContext, version: string, name: string): Promise<void> {
  const ext = requireExtension(name);
  if (ext.builtin) throw new HttpError(422, `${name} is built into PHP`);
  await ctx.exec(['apt-get', 'install', '-y', ...APT_OPTS, `php${version}-${name}`], APT_ENV);
  if (name === 'xdebug') {
    // Xdebug slows every request, so it starts switched off; the Tools page turns it on per version.
    for (const sapi of ['fpm', 'cli']) writeFileSync(`/etc/php/${version}/${sapi}/conf.d/99-devkit-xdebug.ini`, XDEBUG_SETTINGS);
    await ctx.exec(['phpdismod', '-v', version, '-s', 'ALL', 'xdebug']);
    ctx.log('Xdebug installed but left disabled; enable it on the Tools page when you need it.');
  }
  await reloadFpm(version);
}

export async function uninstallExtension(ctx: JobContext, version: string, name: string): Promise<void> {
  const ext = requireExtension(name);
  if (ext.builtin) throw new HttpError(422, `${name} is built into PHP`);
  await ctx.exec(['apt-get', 'remove', '-y', ...APT_OPTS, `php${version}-${name}`], APT_ENV);
  await reloadFpm(version);
}
