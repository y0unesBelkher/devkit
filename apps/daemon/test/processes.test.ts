import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import type { Site } from '@devkit/shared';
import { pickNodeVersion } from '../src/node/fnm.ts';
import { detectType, nodeRequirement } from '../src/sites/detect.ts';
import { renderProxyVhost } from '../src/sites/nginx.ts';
import { versionSatisfies } from '../src/sites/php-constraint.ts';
import { allowedKinds, ngServeCommand, renderScript, renderUnit, validateCommand } from '../src/sites/processes.ts';
import { Store, type ProcessRow } from '../src/store.ts';

const angular: Site = {
  id: 's1',
  domain: 'ng-demo.test',
  root: '/home/dev/projects/ng demo',
  docroot: '/home/dev/projects/ng demo',
  type: 'angular',
  phpVersion: null,
  nodeVersion: '22.12.0',
  port: 5300,
  createdAt: 1,
};

const ngServe: ProcessRow = {
  id: 'p1',
  siteId: 's1',
  kind: 'ng-serve',
  name: 'ng serve',
  command: ngServeCommand(angular),
  autostart: true,
};

describe('node versions', () => {
  const installed = ['20.18.1', '24.11.0', '22.12.0'];

  test.each([
    [null, '24.11.0'],
    ['lts/*', '24.11.0'],
    ['22', '22.12.0'],
    ['v20', '20.18.1'],
    ['^20.19.0 || ^22.12.0', '22.12.0'],
    ['>=18.19 <21', '20.18.1'],
    ['^20.19.0', null],
  ])('%s → %s', (requirement, expected) => {
    expect(pickNodeVersion(requirement, installed)).toBe(expected);
  });

  test('npm ranges', () => {
    expect(versionSatisfies('^20.19.0 || ^22.12.0 || >=24.0.0', '20.18.1')).toBe(false);
    expect(versionSatisfies('^20.19.0 || ^22.12.0 || >=24.0.0', '26.0.0')).toBe(true);
  });
});

describe('angular detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-ng-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads .nvmrc before engines.node', () => {
    writeFileSync(join(dir, 'angular.json'), '{}');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: '^22.12.0' } }));
    expect(detectType(dir)).toBe('angular');
    expect(nodeRequirement(dir)).toBe('^22.12.0');
    writeFileSync(join(dir, '.nvmrc'), 'v20\n');
    expect(nodeRequirement(dir)).toBe('v20');
  });
});

describe('process units', () => {
  test('ng serve binds loopback on the site port', () => {
    expect(ngServeCommand(angular)).toBe('npx ng serve --host 127.0.0.1 --port 5300');
  });

  test('script changes into the (quoted) root and runs the command', () => {
    expect(renderScript(ngServe, angular)).toContain("cd '/home/dev/projects/ng demo' || exit 1\nnpx ng serve");
  });

  test('unit runs as the user with the site Node first on PATH and always restarts', () => {
    const unit = renderUnit(ngServe, angular, 'dev', 'dev', '22.12.0');
    expect(unit).toContain('User=dev\nGroup=dev');
    expect(unit).toMatch(/Environment="PATH=\/.+\/fnm\/node-versions\/v22\.12\.0\/installation\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"/);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('ExecStart=/bin/bash /var/lib/devkit/processes/p1.sh');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  test('allowed kinds per site type', () => {
    expect(allowedKinds(angular)).toEqual(['ng-serve', 'custom']);
    expect(allowedKinds({ ...angular, type: 'laravel' })).toEqual(['queue', 'schedule', 'horizon', 'custom']);
    expect(allowedKinds({ ...angular, type: 'static' })).toEqual(['custom']);
  });

  test('commands must be one non-empty line', () => {
    expect(validateCommand('  php artisan reverb:start  ')).toBe('php artisan reverb:start');
    expect(() => validateCommand('   ')).toThrow();
    expect(() => validateCommand('a\nb')).toThrow();
  });
});

describe('proxy vhost', () => {
  test('proxies HTTP and WebSockets to the dev server with a friendly 502', () => {
    const conf = renderProxyVhost(angular, { cert: '/c.crt', key: '/c.key' }, 5300);
    expect(conf).toContain('proxy_pass http://127.0.0.1:5300;');
    expect(conf).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(conf).toContain('proxy_set_header Connection $devkit_connection_upgrade;');
    expect(conf).toContain('proxy_set_header Host localhost;');
    expect(conf).toContain('proxy_set_header X-Forwarded-Host $host;');
    expect(conf).toContain('error_page 502 504 = @devkit_dev_server_down;');
  });
});

describe('Store processes', () => {
  test('crud and ports', () => {
    const store = new Store(':memory:');
    store.insertSite(angular);
    store.insertProcess(ngServe);
    expect(store.listSites()[0]?.port).toBe(5300);
    expect(store.listProcesses('s1')).toEqual([ngServe]);
    store.updateProcess({ ...ngServe, autostart: false, command: 'npm start' });
    expect(store.getProcess('p1')).toEqual({ ...ngServe, autostart: false, command: 'npm start' });
    store.deleteProcess('p1');
    expect(store.listProcesses()).toEqual([]);
    store.close();
  });
});
