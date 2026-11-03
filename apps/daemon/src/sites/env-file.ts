import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import type { Site, SiteEnv } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { asUser } from '../user-exec.ts';

const MAX_ENV_BYTES = 256 * 1024;

export function readSiteEnv(site: Site): SiteEnv {
  const path = join(site.root, '.env');
  const exists = existsSync(path);
  return {
    path,
    exists,
    content: exists ? readFileSync(path, 'utf8') : '',
    exampleExists: existsSync(join(site.root, '.env.example')),
  };
}

/**
 * Saves .env. An existing file is rewritten in place, which keeps it owned by the user; a new one is
 * created by the user so it never ends up owned by root.
 */
export async function writeSiteEnv(site: Site, user: string, content: string): Promise<SiteEnv> {
  if (typeof content !== 'string') throw new HttpError(422, 'Expected the file content');
  if (Buffer.byteLength(content) > MAX_ENV_BYTES) throw new HttpError(422, '.env is too large');
  const path = join(site.root, '.env');
  if (!existsSync(path)) {
    const created = await run(asUser(user, ['touch', path]));
    if (created.code !== 0) throw new HttpError(500, created.stderr.trim() || 'Could not create .env');
  }
  writeFileSync(path, content);
  return readSiteEnv(site);
}

export async function envFromExample(site: Site, user: string): Promise<SiteEnv> {
  const example = join(site.root, '.env.example');
  if (!existsSync(example)) throw new HttpError(404, 'There is no .env.example');
  if (existsSync(join(site.root, '.env'))) throw new HttpError(409, '.env already exists');
  const copied = await run(asUser(user, ['cp', '-n', example, join(site.root, '.env')]));
  if (copied.code !== 0) throw new HttpError(500, copied.stderr.trim() || 'Could not copy .env.example');
  return readSiteEnv(site);
}

/** Runs `php artisan …` as the user in the site root (the php shim picks the site's PHP version). */
export function validateArtisan(command: string): string[] {
  const trimmed = String(command ?? '').trim().replace(/^php\s+artisan\s+/, '');
  if (!trimmed || trimmed.length > 300 || /[\r\n]/.test(trimmed)) throw new HttpError(422, 'Enter one artisan command');
  // Split on whitespace, honouring quotes anywhere in a word (--execute='echo 1;'); the result is passed
  // as argv, never through a shell.
  const words = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return words.map((word) => word.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
}

export async function runArtisan(ctx: JobContext, site: Site, user: string, args: string[]): Promise<void> {
  if (site.type !== 'laravel') throw new HttpError(422, 'Not a Laravel site');
  await ctx.exec(asUser(user, ['php', 'artisan', ...args, '--no-interaction', '--no-ansi']), undefined, site.root);
}
