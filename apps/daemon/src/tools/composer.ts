import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { run } from '../exec.ts';
import type { JobContext } from '../jobs.ts';
import { userHome } from '../node/fnm.ts';
import { asUser } from '../user-exec.ts';

export const COMPOSER_BIN = '/usr/local/bin/composer';
const PHAR_URL = 'https://getcomposer.org/download/latest-stable/composer.phar';
const VERSIONS_URL = 'https://getcomposer.org/versions';
const PUBKEYS = {
  'keys.dev.pub': 'https://composer.github.io/snapshots.pub',
  'keys.tags.pub': 'https://composer.github.io/releases.pub',
};

/** "Composer version 2.9.2 2026-10-01 12:00:00" → "2.9.2". */
export function parseComposerVersion(output: string): string | null {
  return /Composer (?:version )?(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

export async function composerVersion(): Promise<string | null> {
  if (!existsSync(COMPOSER_BIN)) return null;
  const result = await run(['php', COMPOSER_BIN, '--version', '--no-ansi'], { env: { COMPOSER_ALLOW_SUPERUSER: '1' }, timeoutMs: 30_000 });
  return parseComposerVersion(result.stdout);
}

export async function latestComposerVersion(): Promise<string | null> {
  try {
    const res = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { stable?: { version: string }[] };
    return body.stable?.[0]?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Installs (or updates to) the latest stable composer.phar from getcomposer.org, refusing it unless its
 * SHA-256 matches the checksum published next to it.
 */
export async function installComposer(ctx: JobContext, user: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-composer-'));
  try {
    const phar = join(dir, 'composer.phar');
    const sum = join(dir, 'composer.phar.sha256sum');
    await ctx.exec(['curl', '-fsSL', '--retry', '3', '-o', phar, PHAR_URL]);
    await ctx.exec(['curl', '-fsSL', '--retry', '3', '-o', sum, `${PHAR_URL}.sha256sum`]);
    const expected = readFileSync(sum, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash('sha256').update(readFileSync(phar)).digest('hex');
    if (!expected || expected !== actual) throw new Error(`Checksum mismatch for composer.phar (expected ${expected}, got ${actual})`);
    ctx.log(`Checksum verified: ${actual}`);
    await ctx.exec(['install', '-m', '0755', phar, COMPOSER_BIN]);
    ctx.log(`Installed ${(await composerVersion()) ?? 'Composer'} at ${COMPOSER_BIN}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Composer extracts dist archives much faster (and more reliably) with unzip than with ext-zip.
  if (!existsSync('/usr/bin/unzip')) {
    await ctx.exec(['apt-get', 'install', '-y', '-o', 'DPkg::Lock::Timeout=300', 'unzip'], { DEBIAN_FRONTEND: 'noninteractive' });
  }
  // The public keys `composer self-update` and `composer diagnose` verify signatures with.
  const keysDir = join(userHome(user), '.config', 'composer');
  await ctx.exec(asUser(user, ['mkdir', '-p', keysDir]));
  for (const [file, url] of Object.entries(PUBKEYS)) {
    await ctx.exec(asUser(user, ['curl', '-fsSL', '--retry', '3', '-o', join(keysDir, file), url]));
  }
}
