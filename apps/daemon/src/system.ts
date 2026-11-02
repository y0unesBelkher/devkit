import { readFileSync } from 'node:fs';
import { DAEMON_VERSION, type DaemonConfig, type SystemInfo } from '@devkit/shared';
import { packagesNeedingRepair } from './services/system-tools.ts';

export function parseOsRelease(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match?.[1]) continue;
    result[match[1]] = (match[2] ?? '').replace(/^"(.*)"$/, '$1');
  }
  return result;
}

/** Reads `[interop] appendWindowsPath` from /etc/wsl.conf; WSL's default is true. */
export function parseAppendWindowsPath(wslConf: string): boolean {
  let section = '';
  for (const raw of wslConf.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (section === 'interop' && kv?.[1]?.trim().toLowerCase() === 'appendwindowspath') {
      return (kv[2] ?? '').trim().toLowerCase() !== 'false';
    }
  }
  return true;
}

function readOr(file: string, fallback: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export async function getSystemInfo(config: DaemonConfig, startedAt: number): Promise<SystemInfo> {
  const os = parseOsRelease(readOr('/etc/os-release', ''));
  const packagesNeedingRepairCount = await packagesNeedingRepair().catch(() => 0);
  const pid1 = readOr('/proc/1/comm', '').trim();
  return {
    daemon: {
      version: DAEMON_VERSION,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      runningAsRoot: process.getuid?.() === 0,
    },
    distro: {
      id: os['ID'] ?? 'unknown',
      name: os['PRETTY_NAME'] ?? os['NAME'] ?? 'unknown',
      version: os['VERSION_ID'] ?? '',
    },
    kernel: readOr('/proc/sys/kernel/osrelease', '').trim(),
    systemd: pid1 === 'systemd',
    user: config.user,
    windowsPathAppended: parseAppendWindowsPath(readOr('/etc/wsl.conf', '')),
    packagesNeedingRepair: packagesNeedingRepairCount,
  };
}
