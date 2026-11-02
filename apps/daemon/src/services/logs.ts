import { HttpError } from '../http-error.ts';
import type { ServiceDefinition } from './catalog.ts';

export const MAX_LOG_LINES = 2000;

/** Command that prints (and with `follow`, keeps printing) one log source of a service. */
export function logCommand(def: ServiceDefinition, sourceId: string, lines: number, follow: boolean): string[] {
  const count = String(Math.min(Math.max(Math.trunc(lines) || 0, 0), MAX_LOG_LINES));
  if (sourceId === 'journal') {
    return [
      'journalctl', '-u', def.journalUnit ?? def.unit, '-n', count, '--no-pager', '-o', 'short-iso',
      ...(follow ? ['-f'] : []),
    ];
  }
  const file = def.logFiles[sourceId];
  if (!file) throw new HttpError(404, `${def.name} has no log source "${sourceId}"`);
  return ['tail', '-n', count, ...(follow ? ['-F'] : []), file.path];
}
