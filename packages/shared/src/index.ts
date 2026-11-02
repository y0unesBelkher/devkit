// Contract shared by the WSL daemon, the Electron main process and the Angular UI.
// Keep this file free of runtime dependencies: it is bundled into all three.

/** Port the daemon listens on inside WSL (reachable from Windows via localhost forwarding). */
export const DAEMON_PORT = 7765;

/** Version of the daemon bundled with this build of the desktop app. */
export const DAEMON_VERSION = '0.2.0';

/** Paths inside WSL owned by the daemon. */
export const DAEMON_PATHS = {
  binary: '/usr/local/bin/devkitd',
  unit: '/etc/systemd/system/devkitd.service',
  configDir: '/etc/devkit',
  config: '/etc/devkit/config.json',
  token: '/etc/devkit/token',
  stateDir: '/var/lib/devkit',
} as const;

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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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
// Live events over the daemon WebSocket (/api/ws), relayed by the Electron main process

export type ClientMessage =
  | { type: 'logs.subscribe'; serviceId: string; sourceId: string }
  | { type: 'logs.unsubscribe' };

export type DaemonEvent =
  | { type: 'services'; services: ServiceStatus[] }
  | { type: 'job'; job: Job }
  | { type: 'job.output'; jobId: string; lines: string[] }
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
}
