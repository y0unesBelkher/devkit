import { PHP_VERSIONS, type LogSource, type ServiceInfo } from '@devkit/shared';

export interface ServiceDefinition extends ServiceInfo {
  /** apt package whose presence means "installed" and whose version is shown. */
  package: string;
  installPackages: string[];
  /** Removed on uninstall. Data (e.g. /var/lib/mysql) is kept: we never purge. */
  removePackages: string[];
  /** Launchpad PPA needed before installing. */
  ppa?: string;
  /** journalctl -u pattern; defaults to the unit. */
  journalUnit?: string;
  /** Log files by source id (the journal is always available as `journal`). */
  logFiles: Record<string, { label: string; path: string }>;
}

/** Extensions a Laravel app expects out of the box; per-version toggles arrive with the Tools page. */
const PHP_BASE_EXTENSIONS = [
  'cli', 'common', 'mbstring', 'xml', 'curl', 'zip', 'mysql', 'pgsql', 'sqlite3',
  'bcmath', 'intl', 'gd', 'redis', 'opcache', 'readline',
];

const php = (version: string): ServiceDefinition => ({
  id: `php${version}`,
  name: `PHP ${version} FPM`,
  category: 'php',
  description: `PHP ${version} FastCGI process manager with Laravel's usual extensions.`,
  unit: `php${version}-fpm.service`,
  package: `php${version}-fpm`,
  installPackages: [`php${version}-fpm`, ...PHP_BASE_EXTENSIONS.map((ext) => `php${version}-${ext}`)],
  removePackages: [`php${version}-fpm`],
  ppa: 'ondrej/php',
  logSources: [],
  logFiles: { fpm: { label: 'FPM log', path: `/var/log/php${version}-fpm.log` } },
});

const definitions: ServiceDefinition[] = [
  {
    id: 'nginx',
    name: 'nginx',
    category: 'web',
    description: 'Web server and reverse proxy for every site.',
    unit: 'nginx.service',
    package: 'nginx',
    installPackages: ['nginx'],
    removePackages: ['nginx', 'nginx-common'],
    logSources: [],
    logFiles: {
      error: { label: 'Error log', path: '/var/log/nginx/error.log' },
      access: { label: 'Access log', path: '/var/log/nginx/access.log' },
    },
  },
  ...PHP_VERSIONS.map(php),
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'database',
    description: 'MySQL 8 server. Uninstalling keeps your databases in /var/lib/mysql.',
    unit: 'mysql.service',
    package: 'mysql-server',
    installPackages: ['mysql-server'],
    removePackages: ['mysql-server'],
    logSources: [],
    logFiles: { error: { label: 'Error log', path: '/var/log/mysql/error.log' } },
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    category: 'database',
    description: 'PostgreSQL server (optional).',
    unit: 'postgresql.service',
    journalUnit: 'postgresql*',
    package: 'postgresql',
    installPackages: ['postgresql'],
    removePackages: ['postgresql'],
    logSources: [],
    logFiles: {},
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'cache',
    description: 'In-memory store for cache, sessions, queues and Horizon.',
    unit: 'redis-server.service',
    package: 'redis-server',
    installPackages: ['redis-server'],
    removePackages: ['redis-server'],
    logSources: [],
    logFiles: { server: { label: 'Server log', path: '/var/log/redis/redis-server.log' } },
  },
];

for (const def of definitions) {
  const sources: LogSource[] = [{ id: 'journal', label: 'systemd journal' }];
  for (const [id, file] of Object.entries(def.logFiles)) sources.push({ id, label: file.label });
  def.logSources = sources;
}

export const catalog: readonly ServiceDefinition[] = definitions;

export function findService(id: string): ServiceDefinition | undefined {
  return catalog.find((def) => def.id === id);
}

export function toInfo(def: ServiceDefinition): ServiceInfo {
  const { id, name, category, description, unit, logSources } = def;
  return { id, name, category, description, unit, logSources };
}
