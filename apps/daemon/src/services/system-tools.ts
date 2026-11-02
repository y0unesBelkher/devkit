import type { ActiveState } from '@devkit/shared';
import { run } from '../exec.ts';

const ACTIVE_STATES = new Set<ActiveState>(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading']);

export interface UnitState {
  active: ActiveState;
  enabled: boolean;
}

/** Parses `systemctl show -p Id,LoadState,ActiveState,UnitFileState a b …` (blocks separated by blank lines). */
export function parseSystemctlShow(text: string): Map<string, UnitState> {
  const result = new Map<string, UnitState>();
  for (const block of text.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const id = props['Id'];
    if (!id) continue;
    const active = props['ActiveState'] as ActiveState;
    result.set(id, {
      active: props['LoadState'] === 'not-found' ? 'missing' : ACTIVE_STATES.has(active) ? active : 'inactive',
      enabled: props['UnitFileState'] === 'enabled',
    });
  }
  return result;
}

export async function unitStates(units: string[]): Promise<Map<string, UnitState>> {
  const result = await run(['systemctl', 'show', '-p', 'Id,LoadState,ActiveState,UnitFileState', ...units]);
  return parseSystemctlShow(result.stdout);
}

/** Parses `dpkg-query -W -f '${Package}\t${db:Status-Abbrev}\t${Version}\n'`; only fully installed ("ii") packages count. */
export function parseDpkgQuery(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [name, status, version] = line.split('\t');
    if (name && version && status?.startsWith('ii')) versions.set(name, version);
  }
  return versions;
}

export async function installedPackages(packages: string[]): Promise<Map<string, string>> {
  // Exits non-zero when some packages are unknown, but still prints the known ones.
  const result = await run(['dpkg-query', '-W', '-f', '${Package}\t${db:Status-Abbrev}\t${Version}\n', ...packages]);
  return parseDpkgQuery(result.stdout);
}

/**
 * Packages an interrupted dpkg run left unpacked-but-unconfigured (or with pending triggers).
 * apt refuses to install anything until `dpkg --configure -a` has fixed them.
 */
export async function packagesNeedingRepair(): Promise<number> {
  const result = await run(['dpkg', '--audit']);
  return result.stdout.split('\n').filter((line) => /^ \S/.test(line)).length;
}

/** "5:7.0.15-1ubuntu0.24.04.4" → "7.0.15"; "8.4.14-1+ubuntu24.04.1+deb.sury.org+1" → "8.4.14". */
export function shortVersion(debianVersion: string): string {
  return debianVersion.replace(/^\d+:/, '').split(/[-+~]/)[0] ?? debianVersion;
}
