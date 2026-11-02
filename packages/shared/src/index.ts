// Contract shared by the WSL daemon, the Electron main process and the Angular UI.
// Keep this file free of runtime dependencies: it is bundled into all three.

/** Port the daemon listens on inside WSL (reachable from Windows via localhost forwarding). */
export const DAEMON_PORT = 7765;

/** Version of the daemon bundled with this build of the desktop app. */
export const DAEMON_VERSION = '0.6.0';

/** Paths inside WSL owned by the daemon. */
export const DAEMON_PATHS = {
  binary: '/usr/local/bin/devkitd',
  unit: '/etc/systemd/system/devkitd.service',
  configDir: '/etc/devkit',
  config: '/etc/devkit/config.json',
  token: '/etc/devkit/token',
  stateDir: '/var/lib/devkit',
  stateDb: '/var/lib/devkit/state.db',
  caDir: '/etc/devkit/ca',
  certsDir: '/etc/devkit/certs',
  nginxIncludes: '/etc/nginx/devkit',
} as const;

/** Top-level domain for every site. */
export const SITE_TLD = 'test';

/** Written by the desktop bootstrap; read by the daemon at startup. */
export interface DaemonConfig {
  /** Linux user that owns projects; project commands and FPM pools run as this user. */
  user: string;
  port: number;
}

/** GET /api/ping — unauthenticated liveness probe. */
export interface PingResponse {
  name: 'devkitd';
  version: string;
}

/** GET /api/system — authenticated system overview. */
export interface SystemInfo {
  daemon: {
    version: string;
    pid: number;
    uptimeSec: number;
    runningAsRoot: boolean;
  };
  distro: {
    id: string;
    name: string;
    version: string;
  };
  kernel: string;
  systemd: boolean;
  user: string;
  /** True unless /etc/wsl.conf sets appendWindowsPath=false (Windows php.exe etc. leak into PATH). */
  windowsPathAppended: boolean;
  /** DevKit's /usr/local/bin/php shim is installed, so Linux PHP wins over a Windows php.exe on PATH. */
  phpShim: boolean;
  /** Packages an interrupted upgrade left unconfigured; apt installs fail while this is > 0. */
  packagesNeedingRepair: number;
}

export interface ApiError {
  error: string;
}

/** What the desktop app knows about the daemon, as shown in the UI. */
export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'not-installed'; distro: string }
  | { status: 'outdated'; installed: string; bundled: string }
  | { status: 'unreachable'; message: string }
  | { status: 'connected'; version: string };

export interface BootstrapResult {
  ok: boolean;
  log: string;
}

/** Request proxied from the renderer to the daemon by the Electron main process. */
export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

// ---------------------------------------------------------------------------
// Services

export type ServiceCategory = 'web' | 'php' | 'database' | 'cache';

export const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export interface LogSource {
  id: string;
  label: string;
}

/** Static description of a service DevKit can manage (see the daemon's catalog). */
export interface ServiceInfo {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string;
  unit: string;
  logSources: LogSource[];
}

/** systemd ActiveState, plus `missing` when the unit does not exist. */
export type ActiveState = 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'reloading' | 'missing';

export interface ServiceStatus extends ServiceInfo {
  installed: boolean;
  version: string | null;
  active: ActiveState;
  enabled: boolean;
}

/** GET /api/services */
export interface ServicesResponse {
  services: ServiceStatus[];
}

/** GET /api/services/:id/logs?source=…&lines=… */
export interface LogsResponse {
  serviceId: string;
  sourceId: string;
  lines: string[];
}

// ---------------------------------------------------------------------------
// Jobs: long-running privileged work (apt), run one at a time

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  title: string;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  /** Combined stdout/stderr, capped to the most recent lines. */
  output: string[];
  error: string | null;
}

/** GET /api/jobs */
export interface JobsResponse {
  jobs: Job[];
}

// ---------------------------------------------------------------------------
// Networking: how the Windows browser reaches nginx inside WSL

/**
 * - `wsl-ip`: nginx listens only on WSL's NAT IP and hosts entries point there. Coexists with another
 *   stack (EnvKit) that owns 80/443 on Windows; hosts entries change when WSL's IP changes.
 * - `localhost`: nginx listens on all addresses, WSL forwards 127.0.0.1:80/443, hosts entries use 127.0.0.1.
 */
export type ListenMode = 'wsl-ip' | 'localhost';

/** GET/PUT /api/network */
export interface NetworkInfo {
  mode: ListenMode;
  wslIp: string | null;
  /** IP the Windows hosts entries must point at. */
  hostsTarget: string | null;
}

export interface SetNetworkRequest {
  mode: ListenMode;
}

/** GET /api/ca: the local certificate authority that signs every site certificate. */
export interface CaInfo {
  pem: string;
  /** SHA-1 of the DER certificate, uppercase hex; matches the Windows certificate store thumbprint. */
  thumbprint: string;
  subject: string;
  notAfter: string;
}

// ---------------------------------------------------------------------------
// Sites

/** PHP versions DevKit installs from the ondrej/php PPA, oldest first. */
export const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'] as const;

export type SiteType = 'static' | 'php' | 'laravel' | 'angular';

/** First port handed to dev servers (EnvKit's Windows-side dev servers sit at 5170+). */
export const DEV_SERVER_PORT_START = 5300;

export interface Site {
  id: string;
  domain: string;
  /** Project directory on the Linux filesystem. */
  root: string;
  /** Directory nginx serves (`<root>/public` for Laravel). */
  docroot: string;
  type: SiteType;
  /** PHP-FPM version for php/laravel sites; null otherwise. */
  phpVersion: string | null;
  /** Node version (e.g. "22.12.0") for sites with a dev server; null otherwise. */
  nodeVersion: string | null;
  /** Port of the dev server nginx proxies to (Angular); null otherwise. */
  port: number | null;
  createdAt: number;
}

/** POST /api/sites/detect: what a folder looks like, before creating a site from it. */
export interface DetectRequest {
  root: string;
}

export interface SiteDatabase {
  connection: string;
  name: string;
  username: string;
  hasPassword: boolean;
}

export interface DetectResult {
  /** Resolved project directory. */
  root: string;
  type: SiteType;
  domain: string;
  docroot: string;
  /** `require.php` from composer.json, e.g. "^8.2". */
  phpConstraint: string | null;
  /** Best installed version matching the constraint (or the newest installed). */
  phpVersion: string | null;
  installedPhpVersions: string[];
  /** From .nvmrc or package.json engines.node, e.g. "^20.19.0 || ^22.12.0". */
  nodeRequirement: string | null;
  /** Best installed Node version for the requirement (or the newest installed). */
  nodeVersion: string | null;
  installedNodeVersions: string[];
  /** From .env, when it uses MySQL. */
  database: SiteDatabase | null;
  mysqlInstalled: boolean;
  warnings: string[];
}

/** POST /api/sites */
export interface CreateSiteRequest {
  domain: string;
  root: string;
  type: SiteType;
  phpVersion?: string | null;
  nodeVersion?: string | null;
  /** Create the .env database and its user in MySQL. */
  createDatabase?: boolean;
}

// ---------------------------------------------------------------------------
// Site processes: long-running commands per site (ng serve, queue workers, Horizon, …),
// each a systemd unit running as the project user in the project directory.

export type ProcessKind = 'ng-serve' | 'queue' | 'schedule' | 'horizon' | 'custom';

export const PROCESS_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

export interface SiteProcess {
  id: string;
  siteId: string;
  kind: ProcessKind;
  name: string;
  /** Shell command run in the site root. */
  command: string;
  /** Started automatically when WSL boots. */
  autostart: boolean;
  unit: string;
  active: ActiveState;
}

/** GET /api/processes */
export interface ProcessesResponse {
  processes: SiteProcess[];
}

/** POST /api/sites/:id/processes; queue/schedule/horizon get default commands. */
export interface CreateProcessRequest {
  kind: ProcessKind;
  name?: string;
  command?: string;
  autostart?: boolean;
}

/** PATCH /api/processes/:id */
export interface UpdateProcessRequest {
  name?: string;
  command?: string;
  autostart?: boolean;
}

// ---------------------------------------------------------------------------
// Node.js (fnm, per project user)

/** GET /api/node */
export interface NodeInfo {
  fnmInstalled: boolean;
  /** Installed versions, newest first ("22.12.0"). */
  versions: string[];
}

/** POST /api/node/install: "lts" or a version prefix like "22". */
export interface InstallNodeRequest {
  version: string;
}

// ---------------------------------------------------------------------------
// Tools: PHP extensions, Composer, global npm packages, health and updates

export interface PhpExtension {
  /** Name used in the UI and in apt (`php8.4-<name>`). */
  name: string;
  installed: boolean;
  /** Loaded for PHP-FPM (and CLI). Built-in extensions are always on. */
  enabled: boolean;
  /** Shipped inside php-common/php-cli rather than as its own package. */
  builtin: boolean;
  /** Can be switched on and off without uninstalling (e.g. xdebug, opcache). */
  toggleable: boolean;
}

export interface PhpToolInfo {
  version: string;
  /** Full version from `php -v`, e.g. "8.4.27". */
  release: string | null;
  extensions: PhpExtension[];
}

export interface GlobalPackage {
  name: string;
  version: string;
}

export interface NodeToolInfo {
  version: string;
  npm: string | null;
  globals: GlobalPackage[];
}

/** GET /api/tools */
export interface ToolsInfo {
  php: PhpToolInfo[];
  composer: { installed: boolean; version: string | null };
  fnmInstalled: boolean;
  node: NodeToolInfo[];
}

export const PHP_EXTENSION_ACTIONS = ['install', 'uninstall', 'enable', 'disable'] as const;
export type PhpExtensionAction = (typeof PHP_EXTENSION_ACTIONS)[number];

/** POST /api/tools/node/:version/globals */
export interface NodeGlobalRequest {
  package: string;
  action: 'install' | 'uninstall' | 'update';
}

export interface PackageUpdate {
  name: string;
  current: string;
  latest: string;
}

/** GET /api/tools/updates: what can be upgraded (apt from the cached package lists; refresh with the check job). */
export interface ToolUpdates {
  checkedAt: number;
  /** DevKit-managed apt packages (PHP, nginx, MySQL, Redis, …) with a newer version available. */
  apt: PackageUpdate[];
  composer: PackageUpdate | null;
  /** Outdated global npm packages per Node version. */
  npm: Record<string, PackageUpdate[]>;
}

export interface CreateSiteResponse {
  site: Site;
  /** Things that happened besides the site itself (database created, user reused, …). */
  notes: string[];
}

/** PATCH /api/sites/:id */
export interface UpdateSiteRequest {
  phpVersion: string;
}

/** GET /api/sites */
export interface SitesResponse {
  sites: Site[];
}

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Returns an error message, or null when `domain` is a valid single-label site name like `lv-oms.test`. */
export function validateDomain(domain: string): string | null {
  const suffix = `.${SITE_TLD}`;
  if (!domain.endsWith(suffix)) return `Domain must end with ${suffix}`;
  const label = domain.slice(0, -suffix.length);
  if (!DOMAIN_LABEL.test(label)) return 'Use lowercase letters, digits and dashes (e.g. lv-oms.test)';
  return null;
}

// ---------------------------------------------------------------------------
// Windows hosts file block (written by the desktop app, rendered here so it can be tested)

export const HOSTS_BEGIN = '# BEGIN DevKit - managed by the DevKit app, do not edit';
export const HOSTS_END = '# END DevKit';

export interface HostsEntry {
  ip: string;
  domain: string;
}

/** Replaces (or appends) the DevKit block in a hosts file, keeping everything else and its line endings. */
export function applyHostsBlock(content: string, entries: HostsEntry[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const begin = lines.indexOf(HOSTS_BEGIN);
  const end = begin === -1 ? -1 : lines.indexOf(HOSTS_END, begin);
  const outside = begin === -1 || end === -1 ? lines : [...lines.slice(0, begin), ...lines.slice(end + 1)];
  while (outside.length && outside[outside.length - 1] === '') outside.pop();
  const block = entries.length
    ? ['', HOSTS_BEGIN, ...[...entries].sort((a, b) => a.domain.localeCompare(b.domain)).map((e) => `${e.ip} ${e.domain}`), HOSTS_END]
    : [];
  return [...outside, ...block, ''].join(eol);
}

/** Domains that already resolve through a line outside the DevKit block (e.g. EnvKit's), which would shadow ours. */
export function hostsConflicts(content: string, domains: string[]): string[] {
  const lines = content.split(/\r?\n/);
  const begin = lines.indexOf(HOSTS_BEGIN);
  const end = begin === -1 ? -1 : lines.indexOf(HOSTS_END, begin);
  const outside = new Set<string>();
  lines.forEach((line, i) => {
    if (begin !== -1 && end !== -1 && i >= begin && i <= end) return;
    const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (ip) names.forEach((name) => outside.add(name.toLowerCase()));
  });
  return domains.filter((domain) => outside.has(domain));
}

/** State of the Windows side, gathered by the desktop app. */
export interface WindowsStatus {
  network: NetworkInfo;
  /** Mode suggested by who owns ports 80/443 on Windows. */
  recommendedMode: ListenMode;
  /** Non-WSL processes listening on 80/443 on Windows (e.g. EnvKit's nginx). */
  portOwners: { port: number; process: string }[];
  ca: { thumbprint: string; trusted: boolean } | null;
  hosts: {
    inSync: boolean;
    /** Domains defined outside the DevKit block, which win over ours. */
    conflicts: string[];
  };
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Live events over the daemon WebSocket (/api/ws), relayed by the Electron main process

export type ClientMessage =
  | { type: 'logs.subscribe'; serviceId: string; sourceId: string }
  | { type: 'logs.unsubscribe' }
  | { type: 'process-logs.subscribe'; processId: string };

export type DaemonEvent =
  | { type: 'services'; services: ServiceStatus[] }
  | { type: 'job'; job: Job }
  | { type: 'job.output'; jobId: string; lines: string[] }
  | { type: 'processes'; processes: SiteProcess[] }
  | { type: 'process-log'; processId: string; lines: string[] }
  | { type: 'log'; serviceId: string; sourceId: string; lines: string[] }
  /** Emitted by the Electron main process when the socket to the daemon opens or drops. */
  | { type: 'socket'; connected: boolean };

/** Bridge exposed on `window.devkit` by the Electron preload script. */
export interface DevkitBridge {
  connection(): Promise<ConnectionState>;
  installDaemon(): Promise<BootstrapResult>;
  api<T = unknown>(request: ApiRequest): Promise<ApiResult<T>>;
  /** Whether the main process currently has the daemon socket open (events only report changes). */
  isLive(): Promise<boolean>;
  /** Subscribes to live daemon events; returns an unsubscribe function. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  send(message: ClientMessage): void;
  windowsStatus(): Promise<WindowsStatus>;
  /** Adds the DevKit CA to the current user's trusted roots (Windows shows a confirmation dialog). */
  trustCa(): Promise<ActionResult>;
  /** Rewrites the DevKit block of the hosts file from the daemon's sites (one UAC prompt when it changes). */
  syncHosts(): Promise<ActionResult>;
  setListenMode(mode: ListenMode): Promise<ActionResult>;
}
