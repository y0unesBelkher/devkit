import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { ProcessUsage, SiteInsights } from '@devkit/shared';
import { run } from '../exec.ts';
import type { Store } from '../store.ts';
import { asUser } from '../user-exec.ts';
import { listProcesses, unitName } from './processes.ts';
import { accessLog } from './site-logs.ts';

const ACCESS_TAIL_BYTES = 4 * 1024 * 1024;
const DISK_TTL_MS = 10 * 60_000;

/** Previous CPU samples per unit, to turn cumulative CPUUsageNSec into a percentage. */
const cpuSamples = new Map<string, { nsec: number; at: number }>();
const diskCache = new Map<string, { bytes: number; measuredAt: number }>();
const diskRunning = new Set<string>();

interface UnitUsage {
  memoryBytes: number | null;
  cpuNsec: number | null;
}

/** Parses `systemctl show -p Id,MemoryCurrent,CPUUsageNSec u1 u2 …`; "[not set]" means no accounting yet. */
export function parseUsage(text: string): Map<string, UnitUsage> {
  const result = new Map<string, UnitUsage>();
  for (const block of text.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    if (!props['Id']) continue;
    const num = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : null);
    result.set(props['Id'], { memoryBytes: num(props['MemoryCurrent']), cpuNsec: num(props['CPUUsageNSec']) });
  }
  return result;
}

function cpuPercent(unit: string, nsec: number | null, now: number): number | null {
  if (nsec === null) return null;
  const previous = cpuSamples.get(unit);
  cpuSamples.set(unit, { nsec, at: now });
  if (!previous || now <= previous.at) return null;
  return Math.max(0, ((nsec - previous.nsec) / 1e6 / (now - previous.at)) * 100);
}

/** Counts requests in the last hour/day and 5xx answers, from the tail of the site's access log. */
export function countRequests(log: string, now: number): SiteInsights['requests'] {
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  let lastHour = 0;
  let last24h = 0;
  let errors24h = 0;
  for (const line of log.split('\n')) {
    // 172.29.144.1 - - [03/Nov/2026:21:40:50 +0200] "GET / HTTP/2.0" 200 …
    const match = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] "[^"]*" (\d{3})/.exec(line);
    if (!match) continue;
    const [, d, mon, y, h, mi, s, sign, oh, om, status] = match;
    const offset = (Number(oh) * 60 + Number(om)) * (sign === '-' ? -1 : 1);
    const at = Date.UTC(Number(y), months[mon!] ?? 0, Number(d), Number(h), Number(mi), Number(s)) - offset * 60_000;
    const age = now - at;
    if (age < 0 || age > 24 * 3600_000) continue;
    last24h++;
    if (age <= 3600_000) lastHour++;
    if (status!.startsWith('5')) errors24h++;
  }
  return { lastHour, last24h, errors24h };
}

function readTail(path: string, bytes: number): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

/** `du` of big trees (node_modules) takes seconds, so it runs in the background and is cached. */
function measureDisk(user: string, root: string): void {
  const cached = diskCache.get(root);
  if (diskRunning.has(root) || (cached && Date.now() - cached.measuredAt < DISK_TTL_MS)) return;
  diskRunning.add(root);
  void run(asUser(user, ['du', '-sb', root]), { timeoutMs: 120_000 })
    .then((result) => {
      const bytes = Number(result.stdout.split('\t')[0]);
      if (Number.isFinite(bytes)) diskCache.set(root, { bytes, measuredAt: Date.now() });
    })
    .finally(() => diskRunning.delete(root));
}

export async function siteInsights(store: Store, user: string): Promise<SiteInsights[]> {
  const sites = store.listSites();
  const processes = await listProcesses(store);
  const fpmUnits = [...new Set(sites.map((s) => s.phpVersion).filter(Boolean))].map((v) => `php${v}-fpm.service`);
  const units = [...processes.map((p) => unitName(p.id)), ...fpmUnits];
  const usage = units.length
    ? parseUsage((await run(['systemctl', 'show', '-p', 'Id,MemoryCurrent,CPUUsageNSec', ...units])).stdout)
    : new Map<string, UnitUsage>();
  const now = Date.now();

  return sites.map((site) => {
    const own: ProcessUsage[] = processes
      .filter((p) => p.siteId === site.id)
      .map((p) => {
        const u = usage.get(unitName(p.id));
        return {
          id: p.id,
          name: p.name,
          active: p.active,
          memoryBytes: p.active === 'active' ? (u?.memoryBytes ?? null) : null,
          cpuPercent: p.active === 'active' ? cpuPercent(unitName(p.id), u?.cpuNsec ?? null, now) : null,
        };
      });
    measureDisk(user, site.root);
    const cpus = own.map((p) => p.cpuPercent).filter((c): c is number => c !== null);
    return {
      siteId: site.id,
      processes: own,
      memoryBytes: own.reduce((sum, p) => sum + (p.memoryBytes ?? 0), 0),
      cpuPercent: cpus.length ? cpus.reduce((a, b) => a + b, 0) : null,
      fpm: site.phpVersion ? { version: site.phpVersion, memoryBytes: usage.get(`php${site.phpVersion}-fpm.service`)?.memoryBytes ?? null } : null,
      requests: countRequests(readTail(accessLog(site.domain), ACCESS_TAIL_BYTES), now),
      disk: diskCache.get(site.root) ?? null,
    };
  });
}
