import { describe, expect, test } from 'bun:test';
import { catalog, findService } from '../src/services/catalog.ts';
import { logCommand } from '../src/services/logs.ts';
import { parseDpkgQuery, parseSystemctlShow, shortVersion } from '../src/services/system-tools.ts';

describe('catalog', () => {
  test('ids and units are unique', () => {
    expect(new Set(catalog.map((s) => s.id)).size).toBe(catalog.length);
    expect(new Set(catalog.map((s) => s.unit)).size).toBe(catalog.length);
  });

  test('every service exposes the journal first', () => {
    for (const def of catalog) expect(def.logSources[0]?.id).toBe('journal');
  });

  test('php versions come from the ondrej PPA with fpm first', () => {
    const php = findService('php8.4');
    expect(php?.ppa).toBe('ondrej/php');
    expect(php?.installPackages[0]).toBe('php8.4-fpm');
    expect(php?.installPackages).toContain('php8.4-redis');
  });
});

describe('parseSystemctlShow', () => {
  test('maps states and missing units', () => {
    const states = parseSystemctlShow(
      'Id=nginx.service\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\n\n' +
        'Id=mysql.service\nLoadState=not-found\nActiveState=inactive\nUnitFileState=\n\n' +
        'Id=redis-server.service\nLoadState=loaded\nActiveState=failed\nUnitFileState=disabled\n',
    );
    expect(states.get('nginx.service')).toEqual({ active: 'active', enabled: true });
    expect(states.get('mysql.service')).toEqual({ active: 'missing', enabled: false });
    expect(states.get('redis-server.service')).toEqual({ active: 'failed', enabled: false });
  });
});

describe('parseDpkgQuery', () => {
  test('keeps only fully installed packages', () => {
    const versions = parseDpkgQuery('nginx\tii \t1.24.0-2ubuntu7.13\nmysql-server\trc \t8.0.46-0ubuntu0.24.04.3\n');
    expect([...versions]).toEqual([['nginx', '1.24.0-2ubuntu7.13']]);
  });
});

describe('shortVersion', () => {
  test.each([
    ['1.24.0-2ubuntu7.13', '1.24.0'],
    ['5:7.0.15-1ubuntu0.24.04.4', '7.0.15'],
    ['8.4.14-1+ubuntu24.04.1+deb.sury.org+1', '8.4.14'],
    ['16+257build1.1', '16'],
  ])('%s → %s', (input, expected) => {
    expect(shortVersion(input)).toBe(expected);
  });
});

describe('logCommand', () => {
  const nginx = findService('nginx')!;

  test('journal and file sources', () => {
    expect(logCommand(nginx, 'journal', 50, false)).toEqual(['journalctl', '-u', 'nginx.service', '-n', '50', '--no-pager', '-o', 'short-iso']);
    expect(logCommand(nginx, 'error', 10, true)).toEqual(['tail', '-n', '10', '-F', '/var/log/nginx/error.log']);
  });

  test('clamps line counts and rejects unknown sources', () => {
    expect(logCommand(nginx, 'access', 1e9, false)[2]).toBe('2000');
    expect(logCommand(nginx, 'access', Number.NaN, false)[2]).toBe('0');
    expect(() => logCommand(nginx, '../../etc/shadow', 10, false)).toThrow();
  });
});
