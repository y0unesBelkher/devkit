import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PHP_VERSIONS, SITE_TLD, type DetectResult, type SiteType } from '@devkit/shared';
import { installedPackages } from '../services/system-tools.ts';
import { databaseFromEnv, readDotEnv } from './dotenv.ts';
import { pickPhpVersion } from './php-constraint.ts';
import { resolveRoot } from './root.ts';

interface ComposerJson {
  require?: Record<string, string>;
}

function readComposer(root: string): ComposerJson | null {
  try {
    return JSON.parse(readFileSync(join(root, 'composer.json'), 'utf8')) as ComposerJson;
  } catch {
    return null;
  }
}

/** Folder name → DNS label: "My App_v2" → "my-app-v2". */
export function domainFromFolder(root: string): string {
  const label = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'site';
  return `${label}.${SITE_TLD}`;
}

export function detectType(root: string): DetectResult['type'] {
  const composer = readComposer(root);
  if (existsSync(join(root, 'artisan')) && composer?.require?.['laravel/framework']) return 'laravel';
  if (existsSync(join(root, 'angular.json'))) return 'angular';
  if (composer || existsSync(join(root, 'index.php')) || existsSync(join(root, 'public', 'index.php'))) return 'php';
  return 'static';
}

/** Directory nginx serves for a project of this type. */
export function docrootFor(type: SiteType, root: string): string {
  if (type === 'laravel') return join(root, 'public');
  if (type === 'php' && existsSync(join(root, 'public', 'index.php'))) return join(root, 'public');
  return root;
}

export async function installedPhpVersions(): Promise<string[]> {
  const installed = await installedPackages(PHP_VERSIONS.map((v) => `php${v}-fpm`));
  return PHP_VERSIONS.filter((v) => installed.has(`php${v}-fpm`));
}

export async function mysqlInstalled(): Promise<boolean> {
  return (await installedPackages(['mysql-server'])).has('mysql-server');
}

export async function detectProject(requestedRoot: string): Promise<DetectResult> {
  const root = resolveRoot(requestedRoot);
  const type = detectType(root);
  const [phpInstalled, hasMysql] = await Promise.all([installedPhpVersions(), mysqlInstalled()]);
  const usesPhp = type === 'php' || type === 'laravel';
  const constraint = usesPhp ? (readComposer(root)?.require?.['php'] ?? null) : null;
  const phpVersion = usesPhp ? pickPhpVersion(constraint, phpInstalled) : null;
  const database = type === 'laravel' ? databaseFromEnv(readDotEnv(root)) : null;
  const warnings: string[] = [];

  if (type === 'angular') warnings.push('Angular projects are served from the next milestone on (ng serve behind nginx).');
  if (usesPhp && phpInstalled.length === 0) {
    warnings.push('No PHP version is installed yet. Install one on the Services page.');
  } else if (usesPhp && !phpVersion) {
    const wanted = pickPhpVersion(constraint, PHP_VERSIONS);
    warnings.push(
      `composer.json requires PHP ${constraint}, which no installed version satisfies.` +
        (wanted ? ` Install PHP ${wanted} on the Services page.` : ''),
    );
  }
  if (type === 'laravel') {
    if (!existsSync(join(root, 'vendor'))) warnings.push('vendor/ is missing: run "composer install" in the project.');
    if (!existsSync(join(root, '.env'))) {
      warnings.push('.env is missing: copy .env.example to .env, then run "php artisan key:generate".');
    }
  }
  if (database && !hasMysql) warnings.push(`.env uses ${database.connection}, but MySQL is not installed (Services page).`);

  return {
    root,
    type,
    domain: domainFromFolder(root),
    docroot: type === 'angular' ? root : docrootFor(type, root),
    phpConstraint: constraint,
    phpVersion,
    installedPhpVersions: phpInstalled,
    // Never send the password to the UI.
    database: database
      ? { connection: database.connection, name: database.name, username: database.username, hasPassword: database.hasPassword }
      : null,
    mysqlInstalled: hasMysql,
    warnings,
  };
}
