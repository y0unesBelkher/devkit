import {
  DAEMON_PATHS,
  DAEMON_PORT,
  DAEMON_VERSION,
  type ApiRequest,
  type ApiResult,
  type ConnectionState,
  type PingResponse,
} from '@devkit/shared';
import { DISTRO, wsl } from './wsl';

const baseUrl = `http://127.0.0.1:${DAEMON_PORT}`;
let token: string | null = null;

export async function ping(timeoutMs = 1500): Promise<PingResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as PingResponse;
    return body.name === 'devkitd' ? body : null;
  } catch {
    return null;
  }
}

export async function waitForPing(timeoutMs: number): Promise<PingResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pong = await ping();
    if (pong) return pong;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Version of the installed daemon binary, or null when it is not installed. */
export async function installedVersion(): Promise<string | null> {
  const result = await wsl([DAEMON_PATHS.binary, '--version'], { user: 'root', timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function connectionState(): Promise<ConnectionState> {
  let pong = await ping();
  if (!pong) {
    // Any wsl.exe call boots the VM; systemd then starts the enabled daemon.
    const installed = await installedVersion();
    if (!installed) return { status: 'not-installed', distro: DISTRO };
    pong = await waitForPing(8000);
    if (!pong) {
      return { status: 'unreachable', message: `devkitd ${installed} is installed but not answering on port ${DAEMON_PORT}.` };
    }
  }
  if (pong.version !== DAEMON_VERSION) {
    return { status: 'outdated', installed: pong.version, bundled: DAEMON_VERSION };
  }
  return { status: 'connected', version: pong.version };
}

async function readToken(): Promise<string> {
  const result = await wsl(['cat', DAEMON_PATHS.token], { user: 'root', timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`Cannot read daemon token: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function forgetToken(): void {
  token = null;
}

export async function api<T>(request: ApiRequest, retry = true): Promise<ApiResult<T>> {
  if (!request.path.startsWith('/api/')) {
    return { ok: false, status: 400, error: `Refusing to call ${request.path}` };
  }
  try {
    token ??= await readToken();
    const res = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    });
    // The token is regenerated if /etc/devkit/token is removed; re-read it once.
    if (res.status === 401 && retry) {
      token = null;
      return api(request, false);
    }
    const body = (await res.json()) as unknown;
    if (!res.ok) {
      const message = (body as { error?: string }).error ?? res.statusText;
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, status: res.status, data: body as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
