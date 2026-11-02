import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { versionSatisfies } from '../sites/php-constraint.ts';

/** fnm is installed once for the system; each user's Node versions live under their own FNM_DIR. */
export const FNM_BIN = '/usr/local/bin/fnm';
const FNM_RELEASE = 'https://github.com/Schniz/fnm/releases/latest/download/fnm-linux.zip';

export function userHome(user: string): string {
  let passwd = '';
  try {
    passwd = readFileSync('/etc/passwd', 'utf8');
  } catch {
    // Fall back to the conventional location.
  }
  const line = passwd.split('\n').find((entry) => entry.startsWith(`${user}:`));
  return line?.split(':')[5] || `/home/${user}`;
}

export const fnmDir = (user: string) => join(userHome(user), '.local', 'share', 'fnm');

export const nodeBinDir = (user: string, version: string) => join(fnmDir(user), 'node-versions', `v${version}`, 'installation', 'bin');

const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

/** Installed Node versions for the user, newest first. */
export function listNodeVersions(user: string): string[] {
  try {
    return readdirSync(join(fnmDir(user), 'node-versions'))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .map((name) => name.slice(1))
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/** Newest installed version allowed by an .nvmrc value or engines.node range ("lts/*" and "node" mean newest). */
export function pickNodeVersion(requirement: string | null, installed: string[]): string | null {
  const sorted = [...installed].sort(compareVersions);
  const wanted = requirement?.trim().replace(/^v(?=\d)/, '') ?? '';
  if (!wanted || /^(lts\/.*|node|stable|latest)$/i.test(wanted)) return sorted[0] ?? null;
  return sorted.find((version) => versionSatisfies(wanted, version)) ?? null;
}

async function installFnm(ctx: JobContext): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-fnm-'));
  try {
    const zip = join(dir, 'fnm.zip');
    await ctx.exec(['curl', '-fsSL', '--retry', '3', '-o', zip, FNM_RELEASE]);
    // No unzip on a stock WSL Ubuntu; python3 is always there.
    await ctx.exec(['python3', '-m', 'zipfile', '-e', zip, dir]);
    await ctx.exec(['install', '-m', '0755', join(dir, 'fnm'), FNM_BIN]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Accepts "lts" or a version prefix such as "22" or "22.12.0". */
export function validateNodeVersion(version: string): string {
  if (version !== 'lts' && !/^\d+(\.\d+){0,2}$/.test(version)) throw new HttpError(422, `Invalid Node version "${version}"`);
  return version;
}

/** Installs fnm if needed, then a Node version for the project user. */
export async function installNode(ctx: JobContext, user: string, version: string): Promise<void> {
  validateNodeVersion(version);
  if (!existsSync(FNM_BIN)) await installFnm(ctx);
  const env = ['env', `HOME=${userHome(user)}`, `FNM_DIR=${fnmDir(user)}`];
  await ctx.exec(['runuser', '-u', user, '--', ...env, FNM_BIN, 'install', version === 'lts' ? '--lts' : version]);
  ctx.log(`Installed Node versions: ${listNodeVersions(user).join(', ')}`);
}
