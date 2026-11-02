import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { Database } from 'bun:sqlite';
import type { Site } from '@devkit/shared';
import { detectType, docrootFor, domainFromFolder } from '../src/sites/detect.ts';
import { databaseFromEnv, parseDotEnv } from '../src/sites/dotenv.ts';
import { renderPool } from '../src/sites/fpm.ts';
import { renderPhpVhost } from '../src/sites/nginx.ts';
import { minorSatisfies, pickPhpVersion } from '../src/sites/php-constraint.ts';
import { PHP_SHIM, renderPhpSitesMap } from '../src/sites/php-shim.ts';
import { Store } from '../src/store.ts';

const ALL = ['8.1', '8.2', '8.3', '8.4'];

describe('php constraints', () => {
  test.each([
    ['^8.2', ['8.2', '8.3', '8.4']],
    ['^8.1|^8.2', ['8.1', '8.2', '8.3', '8.4']],
    ['^8.1 || ^8.2', ['8.1', '8.2', '8.3', '8.4']],
    ['>=8.1 <8.3', ['8.1', '8.2']],
    ['>= 8.2, < 8.4', ['8.2', '8.3']],
    ['~8.3.0', ['8.3']],
    ['~8.2', ['8.2', '8.3', '8.4']],
    ['8.3.*', ['8.3']],
    ['8.2', ['8.2']],
    ['^8.2.5', ['8.2', '8.3', '8.4']],
    ['>8.3', ['8.3', '8.4']],
    ['^7.4', []],
    ['*', ALL],
  ])('%s', (constraint, expected) => {
    expect(ALL.filter((v) => minorSatisfies(constraint, v))).toEqual(expected);
  });

  test('unparseable constraints do not filter', () => {
    expect(minorSatisfies('dev-main as whatever', '8.1')).toBe(true);
  });

  test('picks the newest allowed installed version', () => {
    expect(pickPhpVersion('^8.2', ['8.1', '8.4', '8.2'])).toBe('8.4');
    expect(pickPhpVersion('>=8.1 <8.3', ['8.1', '8.4', '8.2'])).toBe('8.2');
    expect(pickPhpVersion('^8.3', ['8.1'])).toBeNull();
    expect(pickPhpVersion(null, ['8.1', '8.3'])).toBe('8.3');
    expect(pickPhpVersion(null, [])).toBeNull();
  });
});

describe('dotenv', () => {
  const env = parseDotEnv(
    [
      'APP_NAME="Zoon OMS"',
      'export DB_CONNECTION=mysql',
      'DB_HOST=127.0.0.1 # local',
      "DB_DATABASE='lv_oms'",
      'DB_USERNAME=root',
      'DB_PASSWORD=',
      '# DB_PORT=1',
      'MAIL_FROM="a#b@example.test" # comment',
    ].join('\r\n'),
  );

  test('parses quotes, export, comments and CRLF', () => {
    expect(env).toEqual({
      APP_NAME: 'Zoon OMS',
      DB_CONNECTION: 'mysql',
      DB_HOST: '127.0.0.1',
      DB_DATABASE: 'lv_oms',
      DB_USERNAME: 'root',
      DB_PASSWORD: '',
      MAIL_FROM: 'a#b@example.test',
    });
  });

  test('extracts MySQL credentials only', () => {
    expect(databaseFromEnv(env)).toEqual({ connection: 'mysql', name: 'lv_oms', username: 'root', hasPassword: false, password: '' });
    expect(databaseFromEnv({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'x' })).toBeNull();
    expect(databaseFromEnv(null)).toBeNull();
  });
});

describe('detection', () => {
  const base = mkdtempSync(join(tmpdir(), 'devkit-detect-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const project = (name: string, files: Record<string, string>) => {
    const root = join(base, name);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return root;
  };

  test('recognises project types and docroots', () => {
    const laravel = project('lv-oms', {
      artisan: '',
      'composer.json': JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }),
      'public/index.php': '',
    });
    const angular = project('ng-oms', { 'angular.json': '{}' });
    const php = project('legacy', { 'composer.json': '{}', 'public/index.php': '' });
    const plain = project('plain-php', { 'index.php': '' });
    const html = project('Hello Site', { 'index.html': '' });

    expect(detectType(laravel)).toBe('laravel');
    expect(docrootFor('laravel', laravel)).toBe(join(laravel, 'public'));
    expect(detectType(angular)).toBe('angular');
    expect(detectType(php)).toBe('php');
    expect(docrootFor('php', php)).toBe(join(php, 'public'));
    expect(detectType(plain)).toBe('php');
    expect(docrootFor('php', plain)).toBe(plain);
    expect(detectType(html)).toBe('static');
    expect(domainFromFolder(html)).toBe('hello-site.test');
    expect(domainFromFolder(laravel)).toBe('lv-oms.test');
  });
});

describe('php site config', () => {
  const site: Site = {
    id: '1',
    domain: 'lv-oms.test',
    root: '/home/dev/lv-oms',
    docroot: '/home/dev/lv-oms/public',
    type: 'laravel',
    phpVersion: '8.4',
    nodeVersion: null,
    port: null,
    createdAt: 1,
  };

  test('vhost routes through the front controller to the pool', () => {
    const conf = renderPhpVhost(site, { cert: '/c.crt', key: '/c.key' }, '/run/php/devkit-php8.4.sock');
    expect(conf).toContain('root "/home/dev/lv-oms/public";');
    expect(conf).toContain('try_files $uri $uri/ /index.php?$query_string;');
    expect(conf).toContain('fastcgi_pass unix:/run/php/devkit-php8.4.sock;');
    expect(conf).toContain('location ~ \\.php$ {');
  });

  test('pool runs as the project user', () => {
    const pool = renderPool('8.4', 'dev', 'devs');
    expect(pool).toContain('user = dev\ngroup = devs');
    expect(pool).toContain('listen = /run/php/devkit-php8.4.sock');
    expect(pool).toContain('listen.owner = dev');
  });

  test('shim map lists php sites only', () => {
    const map = renderPhpSitesMap([site, { ...site, id: '2', domain: 'a.test', type: 'static', phpVersion: null }]);
    expect(map).toBe('/home/dev/lv-oms\t8.4\n');
    expect(PHP_SHIM.startsWith('#!/bin/bash\n# Managed by DevKit')).toBe(true);
  });
});

describe('store migration', () => {
  test('v2 databases gain docroot and php_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-store-'));
    const file = join(dir, 'state.db');
    const old = new Database(file);
    old.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    old.exec('CREATE TABLE sites (id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, root TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.exec("INSERT INTO sites VALUES ('1', 'hello.test', '/home/dev/hello', 'static', 5)");
    old.exec('PRAGMA user_version = 2');
    old.close();

    const store = new Store(file);
    expect(store.listSites()).toEqual([
      { id: '1', domain: 'hello.test', root: '/home/dev/hello', docroot: '/home/dev/hello', type: 'static', phpVersion: null, nodeVersion: null, port: null, createdAt: 5 },
    ]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
