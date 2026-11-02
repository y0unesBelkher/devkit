import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import { ADMINER_DOMAIN, DAEMON_PATHS } from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { mysql, sqlString } from '../sites/database.ts';
import { installedPhpVersions } from '../sites/detect.ts';
import { createSite, deleteSite } from '../sites/sites.ts';
import type { Store } from '../store.ts';
import { mysqlState } from './databases.ts';

export const ADMINER_DIR = join(DAEMON_PATHS.stateDir, 'adminer');
export const ADMINER_USER = 'devkit_adminer';
const ADMINER_URL = 'https://www.adminer.org/latest-mysql-en.php';

/**
 * Pre-fills Adminer's login form submission so opening the site signs straight in. After login Adminer
 * redirects to ?username=…, so this only kicks in on a fresh visit or after logging out.
 * Adminer 6 only accepts a login carrying its CSRF token; adminer_object() is Adminer's documented
 * customization hook, used here to skip that check for this server-side login.
 */
export function renderAdminerIndex(password: string): string {
  const php = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `<?php
// Managed by DevKit: signs Adminer in to the local MySQL as ${ADMINER_USER}.
function adminer_object() {
    return new class extends \\Adminer\\Adminer {
        function verifyLoginToken() {
            return false;
        }
    };
}

if (!isset($_GET['username']) && empty($_POST['auth'])) {
    $_POST['auth'] = [
        'driver' => 'server',
        'server' => 'localhost',
        'username' => ${php(ADMINER_USER)},
        'password' => ${php(password)},
        'db' => '',
    ];
}
require __DIR__ . '/adminer.php';
`;
}

export function adminerStatus(store: Store): { enabled: boolean; domain: string; username: string } {
  return { enabled: store.findSiteByDomain(ADMINER_DOMAIN) !== null, domain: ADMINER_DOMAIN, username: ADMINER_USER };
}

/** Downloads Adminer, gives it its own MySQL account, and serves it as a PHP site at adminer-wsl.test. */
export async function enableAdminer(ctx: JobContext, store: Store, user: string): Promise<void> {
  const mysqlInfo = await mysqlState();
  if (!mysqlInfo.running) throw new HttpError(409, 'MySQL must be installed and running (Services page).');
  const php = (await installedPhpVersions()).at(-1);
  if (!php) throw new HttpError(409, 'Install a PHP version first (Services page).');

  mkdirSync(ADMINER_DIR, { recursive: true, mode: 0o755 });
  await ctx.exec(['curl', '-fsSL', '--retry', '3', '-o', join(ADMINER_DIR, 'adminer.php'), ADMINER_URL]);

  // DevKit owns this account, so it may (re)set its password; socket auth is not available to PHP-FPM.
  const password = randomBytes(18).toString('base64url');
  const account = `${sqlString(ADMINER_USER)}@'localhost'`;
  await mysql(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${sqlString(password)}`);
  await mysql(`ALTER USER ${account} IDENTIFIED BY ${sqlString(password)}`);
  await mysql(`GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION`);
  writeFileSync(join(ADMINER_DIR, 'index.php'), renderAdminerIndex(password), { mode: 0o644 });
  ctx.log(`MySQL account ${ADMINER_USER}@localhost is ready.`);

  if (store.findSiteByDomain(ADMINER_DOMAIN)) {
    ctx.log(`${ADMINER_DOMAIN} already exists; Adminer was updated in place.`);
    return;
  }
  await createSite(store, user, { domain: ADMINER_DOMAIN, root: ADMINER_DIR, type: 'php', phpVersion: php });
  ctx.log(`Adminer is served at https://${ADMINER_DOMAIN} (PHP ${php}).`);
}

export async function disableAdminer(store: Store): Promise<void> {
  const site = store.findSiteByDomain(ADMINER_DOMAIN);
  if (!site) throw new HttpError(404, 'Adminer is not enabled');
  await deleteSite(store, site.id);
}
