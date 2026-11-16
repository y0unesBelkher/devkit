import { MIN_PHP_VERSION, PHP_VERSIONS } from '@devkit/shared';
import { run } from '../exec.ts';

export interface PhpRelease {
  version: string;
  /** Only alpha, beta or RC builds exist (e.g. "8.6.0~rc3"): offered, but never picked automatically. */
  preRelease: boolean;
}

let releases: PhpRelease[] = PHP_VERSIONS.map((version) => ({ version, preRelease: false }));

/** Every PHP version DevKit offers, oldest first. */
export function phpReleases(): readonly PhpRelease[] {
  return releases;
}

export function phpVersions(): string[] {
  return releases.map((r) => r.version);
}

/** Released versions only: what DevKit chooses for sites and the recommended stack. */
export function stablePhpVersions(): string[] {
  return releases.filter((r) => !r.preRelease).map((r) => r.version);
}

/**
 * Adds the PHP versions apt can install (the ondrej/php PPA ships new releases, and their RCs, as
 * `php<x.y>-fpm`) to the baseline. Runs at startup and after every `apt-get update`.
 */
export async function refreshPhpVersions(): Promise<void> {
  const names = await run(['apt-cache', 'pkgnames', 'php']);
  const found = parseFpmPackages(names.stdout).filter((v) => compareVersions(v, MIN_PHP_VERSION) >= 0);
  if (!found.length) return;
  const policy = await run(['apt-cache', 'policy', ...found.map((v) => `php${v}-fpm`)]);
  releases = mergeReleases(PHP_VERSIONS, parseCandidates(policy.stdout));
}

/** "php8.5-fpm" lines of `apt-cache pkgnames` → ["8.5"]. */
export function parseFpmPackages(text: string): string[] {
  return [...text.matchAll(/^php(\d+\.\d+)-fpm$/gm)].map((m) => m[1]!);
}

/** `apt-cache policy` output → candidate package version per PHP version; "(none)" is left out. */
export function parseCandidates(text: string): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const block of text.split(/^(?=php\d+\.\d+-fpm:)/m)) {
    const name = /^php(\d+\.\d+)-fpm:/.exec(block)?.[1];
    const candidate = /^\s+Candidate:\s+(\S+)/m.exec(block)?.[1];
    if (name && candidate && candidate !== '(none)') candidates.set(name, candidate);
  }
  return candidates;
}

export function mergeReleases(baseline: readonly string[], candidates: Map<string, string>): PhpRelease[] {
  const all = new Set([...baseline, ...candidates.keys()]);
  return [...all].sort(compareVersions).map((version) => ({
    version,
    preRelease: /~(alpha|beta|rc)/i.test(candidates.get(version) ?? ''),
  }));
}

export function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}
