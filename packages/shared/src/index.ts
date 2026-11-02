// Contract shared by the WSL daemon, the Electron main process and the Angular UI.
// Keep this file free of runtime dependencies: it is bundled into all three.

/** Port the daemon listens on inside WSL (reachable from Windows via localhost forwarding). */
export const DAEMON_PORT = 7765;

/** Version of the daemon bundled with this build of the desktop app. */
export const DAEMON_VERSION = '0.1.0';

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

/** Bridge exposed on `window.devkit` by the Electron preload script. */
export interface DevkitBridge {
  connection(): Promise<ConnectionState>;
  installDaemon(): Promise<BootstrapResult>;
  api<T = unknown>(request: ApiRequest): Promise<ApiResult<T>>;
}
