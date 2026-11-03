import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path/posix';
import type { Site, SiteLogSource } from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import type { ProcessRow } from '../store.ts';
import { unitName } from './processes.ts';

export const accessLog = (domain: string) => `/var/log/nginx/${domain}-access.log`;
export const errorLog = (domain: string) => `/var/log/nginx/${domain}-error.log`;

/** Laravel writes laravel.log, or laravel-YYYY-MM-DD.log with the daily channel: the newest one. */
export function laravelLog(root: string): string | null {
  const dir = join(root, 'storage', 'logs');
  try {
    const logs = readdirSync(dir)
      .filter((name) => /^laravel(-\d{4}-\d{2}-\d{2})?\.log$/.test(name))
      .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return logs[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function siteLogSources(site: Site, processes: ProcessRow[]): SiteLogSource[] {
  const sources: SiteLogSource[] = [];
  if (site.type === 'laravel') sources.push({ id: 'laravel', label: 'Laravel log' });
  for (const process of processes) sources.push({ id: `process:${process.id}`, label: process.name });
  sources.push({ id: 'error', label: 'nginx errors' }, { id: 'access', label: 'nginx access' });
  return sources;
}

/** The follow command for one source (`tail -F` keeps working across log rotation and file creation). */
export function siteLogCommand(site: Site, processes: ProcessRow[], sourceId: string, lines: number): string[] {
  const tail = (file: string) => ['tail', '-n', String(lines), '-F', file];
  if (sourceId === 'access') return tail(accessLog(site.domain));
  if (sourceId === 'error') return tail(errorLog(site.domain));
  if (sourceId === 'laravel') {
    if (site.type !== 'laravel') throw new HttpError(404, 'Not a Laravel site');
    return tail(laravelLog(site.root) ?? join(site.root, 'storage', 'logs', 'laravel.log'));
  }
  if (sourceId.startsWith('process:')) {
    const process = processes.find((p) => `process:${p.id}` === sourceId);
    if (!process) throw new HttpError(404, 'Unknown process');
    return ['journalctl', '-u', unitName(process.id), '-n', String(lines), '--no-pager', '-o', 'cat', '-f'];
  }
  throw new HttpError(404, `Unknown log source "${sourceId}"`);
}
