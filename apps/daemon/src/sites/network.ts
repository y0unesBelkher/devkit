import type { ListenMode, NetworkInfo } from '@devkit/shared';
import { run } from '../exec.ts';
import type { Store } from '../store.ts';

const MODE_KEY = 'network.mode';

/** Parses `ip -4 -o addr show dev eth0` → first IPv4 address. */
export function parseIpAddr(output: string): string | null {
  return /\binet (\d+\.\d+\.\d+\.\d+)\//.exec(output)?.[1] ?? null;
}

export async function wslIp(): Promise<string | null> {
  const result = await run(['ip', '-4', '-o', 'addr', 'show', 'dev', 'eth0']);
  return result.code === 0 ? parseIpAddr(result.stdout) : null;
}

/** Defaults to `wsl-ip`, which never takes 127.0.0.1:80/443 away from another stack on Windows. */
export function getListenMode(store: Store): ListenMode {
  return store.getSetting(MODE_KEY) === 'localhost' ? 'localhost' : 'wsl-ip';
}

export function setListenMode(store: Store, mode: ListenMode): void {
  store.setSetting(MODE_KEY, mode);
}

export async function getNetworkInfo(store: Store): Promise<NetworkInfo> {
  const mode = getListenMode(store);
  const ip = await wslIp();
  return { mode, wslIp: ip, hostsTarget: mode === 'localhost' ? '127.0.0.1' : ip };
}
