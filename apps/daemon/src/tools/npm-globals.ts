import type { GlobalPackage, NodeToolInfo, PackageUpdate } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { listNodeVersions, nodeBinDir } from '../node/fnm.ts';
import { asUser } from '../user-exec.ts';

const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
/** Shipped with Node itself; not shown as user-installed globals. */
const BUNDLED = new Set(['npm', 'corepack']);

export function requireNodeVersion(user: string, version: string): string {
  if (!listNodeVersions(user).includes(version)) throw new HttpError(404, `Node ${version} is not installed`);
  return version;
}

export function validatePackageName(name: string): string {
  if (!PACKAGE_NAME.test(name) || name.length > 214) throw new HttpError(422, `Invalid npm package name "${name}"`);
  return name;
}

const npm = (user: string, version: string, args: string[]) =>
  asUser(user, [`${nodeBinDir(user, version)}/npm`, ...args], [nodeBinDir(user, version)]);

/** Parses `npm ls -g --depth=0 --json`. */
export function parseGlobals(json: string): GlobalPackage[] {
  try {
    const deps = (JSON.parse(json) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
    return Object.entries(deps)
      .filter(([name]) => !BUNDLED.has(name))
      .map(([name, info]) => ({ name, version: info.version ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Parses `npm outdated -g --json` (which exits 1 when something is outdated); npm itself follows its Node release. */
export function parseOutdated(json: string): PackageUpdate[] {
  try {
    const entries = JSON.parse(json || '{}') as Record<string, { current?: string; latest?: string }>;
    return Object.entries(entries)
      .filter(([name, info]) => info.current && info.latest && info.current !== info.latest && !BUNDLED.has(name))
      .map(([name, info]) => ({ name, current: info.current!, latest: info.latest! }));
  } catch {
    return [];
  }
}

export async function nodeToolInfo(user: string): Promise<NodeToolInfo[]> {
  return Promise.all(
    listNodeVersions(user).map(async (version) => {
      const [ls, npmVersion] = await Promise.all([
        run(npm(user, version, ['ls', '-g', '--depth=0', '--json']), { timeoutMs: 30_000 }),
        run(npm(user, version, ['--version']), { timeoutMs: 30_000 }),
      ]);
      return { version, npm: npmVersion.code === 0 ? npmVersion.stdout.trim() : null, globals: parseGlobals(ls.stdout) };
    }),
  );
}

export async function outdatedGlobals(user: string, version: string): Promise<PackageUpdate[]> {
  const result = await run(npm(user, version, ['outdated', '-g', '--json']), { timeoutMs: 60_000 });
  return parseOutdated(result.stdout);
}

export async function changeGlobal(
  ctx: JobContext,
  user: string,
  version: string,
  name: string,
  action: 'install' | 'uninstall' | 'update',
): Promise<void> {
  const args = action === 'uninstall' ? ['uninstall', '-g', name] : ['install', '-g', `${name}@latest`];
  await ctx.exec(npm(user, version, args));
}

export async function updateAllGlobals(ctx: JobContext, user: string, version: string): Promise<void> {
  const outdated = await outdatedGlobals(user, version);
  if (outdated.length === 0) return ctx.log(`Everything is current for Node ${version}.`);
  await ctx.exec(npm(user, version, ['install', '-g', ...outdated.map((pkg) => `${pkg.name}@latest`)]));
}
