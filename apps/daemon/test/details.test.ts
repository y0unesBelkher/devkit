import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import type { Site } from '@devkit/shared';
import { parseMeminfo } from '../src/setup.ts';
import { validateArtisan } from '../src/sites/env-file.ts';
import { countRequests, parseUsage } from '../src/sites/insights.ts';
import { laravelLog, siteLogCommand, siteLogSources } from '../src/sites/site-logs.ts';
import type { ProcessRow } from '../src/store.ts';

const site: Site = {
  id: 's1',
  domain: 'lv-oms.test',
  root: '/home/dev/projects/zoon/lv-oms',
  docroot: '/home/dev/projects/zoon/lv-oms/public',
  type: 'laravel',
  phpVersion: '8.4',
  nodeVersion: null,
  port: null,
  createdAt: 1,
};
const worker: ProcessRow = { id: 'p1', siteId: 's1', kind: 'queue', name: 'Queue worker', command: 'php artisan queue:work', autostart: true };

describe('site logs', () => {
  test('sources: Laravel log, each process, nginx', () => {
    expect(siteLogSources(site, [worker]).map((s) => s.id)).toEqual(['laravel', 'process:p1', 'error', 'access']);
    expect(siteLogSources({ ...site, type: 'static' }, []).map((s) => s.id)).toEqual(['error', 'access']);
  });

  test('commands', () => {
    expect(siteLogCommand(site, [worker], 'access', 50)).toEqual(['tail', '-n', '50', '-F', '/var/log/nginx/lv-oms.test-access.log']);
    expect(siteLogCommand(site, [worker], 'process:p1', 50).slice(0, 3)).toEqual(['journalctl', '-u', 'devkit-proc-p1.service']);
    expect(() => siteLogCommand(site, [worker], 'process:other', 50)).toThrow();
    expect(() => siteLogCommand(site, [], '../../etc/shadow', 50)).toThrow();
  });

  test('newest laravel log, daily channel included', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-logs-'));
    const logs = join(root, 'storage', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'laravel.log'), 'old');
    writeFileSync(join(logs, 'laravel-2026-11-03.log'), 'new');
    writeFileSync(join(logs, 'other.log'), 'x');
    utimesSync(join(logs, 'laravel.log'), new Date(1000), new Date(1000));
    expect(laravelLog(root)).toBe(join(logs, 'laravel-2026-11-03.log'));
    expect(laravelLog('/nope')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('artisan', () => {
  test('arguments are split without a shell', () => {
    expect(validateArtisan('migrate --force')).toEqual(['migrate', '--force']);
    expect(validateArtisan('php artisan make:model "Order Item"')).toEqual(['make:model', 'Order Item']);
    expect(validateArtisan('tinker --execute=\'echo 1;\'')).toEqual(['tinker', '--execute=echo 1;']);
    expect(() => validateArtisan('')).toThrow();
    expect(() => validateArtisan('migrate\nrm -rf /')).toThrow();
  });
});

describe('insights', () => {
  test('systemctl usage blocks', () => {
    const usage = parseUsage('Id=devkit-proc-p1.service\nMemoryCurrent=52428800\nCPUUsageNSec=1500000000\n\nId=php8.4-fpm.service\nMemoryCurrent=[not set]\nCPUUsageNSec=[not set]\n');
    expect(usage.get('devkit-proc-p1.service')).toEqual({ memoryBytes: 52428800, cpuNsec: 1500000000 });
    expect(usage.get('php8.4-fpm.service')).toEqual({ memoryBytes: null, cpuNsec: null });
  });

  test('requests in the last hour and day, with 5xx', () => {
    const now = Date.UTC(2026, 10, 3, 20, 0, 0);
    const log = [
      '1.2.3.4 - - [03/Nov/2026:21:50:00 +0200] "GET / HTTP/2.0" 200 10 "-" "x"',
      '1.2.3.4 - - [03/Nov/2026:21:10:00 +0200] "POST /api HTTP/2.0" 500 10 "-" "x"',
      '1.2.3.4 - - [03/Nov/2026:10:00:00 +0200] "GET /up HTTP/2.0" 200 10 "-" "x"',
      '1.2.3.4 - - [01/Nov/2026:10:00:00 +0200] "GET /old HTTP/2.0" 503 10 "-" "x"',
      'garbage',
    ].join('\n');
    // now is 22:00 +02:00, so 21:50 and 21:10 are both within the last hour.
    expect(countRequests(log, now)).toEqual({ lastHour: 2, last24h: 3, errors24h: 1 });
  });

  test('meminfo', () => {
    expect(parseMeminfo('MemTotal:       16000000 kB\nMemFree: 1 kB\nMemAvailable:    8000000 kB\n')).toEqual({
      totalBytes: 16000000 * 1024,
      availableBytes: 8000000 * 1024,
    });
  });
});

