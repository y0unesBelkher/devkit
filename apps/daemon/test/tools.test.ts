import { describe, expect, test } from 'bun:test';
import { parseComposerVersion } from '../src/tools/composer.ts';
import { parseAptUpgradable } from '../src/tools/maintenance.ts';
import { parseGlobals, parseOutdated, validatePackageName } from '../src/tools/npm-globals.ts';
import { PHP_EXTENSIONS, enabledModules, requireExtension } from '../src/tools/php-extensions.ts';
import { asUser } from '../src/user-exec.ts';

describe('apt upgradable', () => {
  test('keeps DevKit-managed packages and shortens versions', () => {
    const text = [
      'Listing...',
      'php8.4-fpm/noble 8.4.28-1+ubuntu24.04.1+deb.sury.org+1 amd64 [upgradable from: 8.4.27-1+ubuntu24.04.1+deb.sury.org+1]',
      'nginx/noble-updates 1.24.0-2ubuntu7.14 amd64 [upgradable from: 1.24.0-2ubuntu7.13]',
      'libc6/noble-updates 2.39-0ubuntu8.7 amd64 [upgradable from: 2.39-0ubuntu8.6]',
      'redis-server/noble-updates 5:7.0.15-1ubuntu0.24.04.5 amd64 [upgradable from: 5:7.0.15-1ubuntu0.24.04.4]',
    ].join('\n');
    expect(parseAptUpgradable(text)).toEqual([
      { name: 'php8.4-fpm', current: '8.4.27', latest: '8.4.28' },
      { name: 'nginx', current: '1.24.0', latest: '1.24.0' },
      { name: 'redis-server', current: '7.0.15', latest: '7.0.15' },
    ]);
  });
});

describe('composer', () => {
  test('parses --version output', () => {
    expect(parseComposerVersion('Composer version 2.9.2 2026-10-01 12:00:00')).toBe('2.9.2');
    expect(parseComposerVersion('Composer 2.10.0 (2026-11-01)')).toBe('2.10.0');
    expect(parseComposerVersion('PHP Warning: nope')).toBeNull();
  });
});

describe('npm globals', () => {
  test('lists user globals without bundled npm/corepack', () => {
    const json = JSON.stringify({ dependencies: { npm: { version: '11.6.0' }, corepack: { version: '0.34.0' }, '@angular/cli': { version: '22.2.0' } } });
    expect(parseGlobals(json)).toEqual([{ name: '@angular/cli', version: '22.2.0' }]);
    expect(parseGlobals('not json')).toEqual([]);
  });

  test('parses outdated entries', () => {
    const json = JSON.stringify({ '@angular/cli': { current: '22.1.0', latest: '22.2.0' }, npm: { current: '11.20.0', latest: '12.2.1' } });
    expect(parseOutdated(json)).toEqual([{ name: '@angular/cli', current: '22.1.0', latest: '22.2.0' }]);
    expect(parseOutdated('')).toEqual([]);
  });

  test.each(['@angular/cli', 'typescript', 'npm-check-updates', '@nestjs/cli'])('accepts %s', (name) => {
    expect(validatePackageName(name)).toBe(name);
  });

  test.each(['', '../x', 'a b', '--global', 'Foo;rm', '@/x'])('rejects %s', (name) => {
    expect(() => validatePackageName(name)).toThrow();
  });
});

describe('php extensions', () => {
  test('conf.d names map to modules', () => {
    expect([...enabledModules(['10-opcache.ini', '20-pdo_mysql.ini', '25-redis.ini', '99-devkit-xdebug.ini'])]).toEqual([
      'opcache',
      'pdo_mysql',
      'redis',
      'devkit-xdebug',
    ]);
  });

  test('catalog is unique, xdebug is toggleable, pcntl is built in', () => {
    expect(new Set(PHP_EXTENSIONS.map((e) => e.name)).size).toBe(PHP_EXTENSIONS.length);
    expect(requireExtension('xdebug').toggleable).toBe(true);
    expect(requireExtension('pcntl').builtin).toBe(true);
    expect(() => requireExtension('evil')).toThrow();
  });
});

describe('asUser', () => {
  test('runs through runuser with a clean environment', () => {
    const argv = asUser('dev', ['npm', 'ls'], ['/opt/node/bin']);
    expect(argv.slice(0, 5)).toEqual(['runuser', '-u', 'dev', '--', 'env']);
    expect(argv).toContain('PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin');
    expect(argv.slice(-2)).toEqual(['npm', 'ls']);
  });
});
