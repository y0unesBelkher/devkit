import { describe, expect, test } from 'bun:test';
import { HOSTS_BEGIN, HOSTS_DISABLED, HOSTS_END, applyHostsBlock, hostsConflicts, validateDomain, type Site } from '@devkit/shared';
import { parseIpAddr } from '../src/sites/network.ts';
import { renderListen, renderStaticVhost } from '../src/sites/nginx.ts';
import { Store } from '../src/store.ts';

const site: Site = {
  id: '1',
  domain: 'hello.test',
  root: '/home/dev/hello',
  docroot: '/home/dev/hello',
  type: 'static',
  phpVersion: null,
  nodeVersion: null,
  port: null,
  createdAt: 1,
};

describe('validateDomain', () => {
  test.each(['hello.test', 'lv-oms.test', 'a.test', 'app2.test'])('accepts %s', (domain) => {
    expect(validateDomain(domain)).toBeNull();
  });

  test.each(['hello', 'hello.dev', 'Hello.test', 'a.b.test', '-x.test', 'x-.test', 'has space.test', '.test'])('rejects %s', (domain) => {
    expect(validateDomain(domain)).not.toBeNull();
  });
});

describe('hosts block', () => {
  // Shaped like the real file: Microsoft header, then Herd and EnvKit blocks.
  const windowsHosts = [
    '# Copyright (c) Microsoft Corp.',
    '#',
    '#\t::1             localhost',
    '',
    '# Herd generated Hosts. Do not change.',
    '127.0.0.1 lv-oms.test',
    '# End Herd generated Hosts',
    '',
    '# BEGIN envkit',
    '127.0.0.1 lv-oms.test',
    '# END envkit',
    '',
  ].join('\r\n');

  test('goes before the first block of entries, keeps that block header with it, and keeps CRLF', () => {
    const out = applyHostsBlock(windowsHosts, [{ ip: '172.29.1.2', domain: 'lv-oms.test' }]);
    expect(out.split('\r\n').slice(0, 9)).toEqual([
      '# Copyright (c) Microsoft Corp.',
      '#',
      '#\t::1             localhost',
      '',
      HOSTS_BEGIN,
      '172.29.1.2 lv-oms.test',
      HOSTS_END,
      '',
      '# Herd generated Hosts. Do not change.',
    ]);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test('replaces an existing block in place and is idempotent', () => {
    const once = applyHostsBlock(windowsHosts, [{ ip: '1.1.1.1', domain: 'b.test' }]);
    const entries = [
      { ip: '2.2.2.2', domain: 'b.test' },
      { ip: '2.2.2.2', domain: 'a.test' },
    ];
    const twice = applyHostsBlock(once, entries);
    expect(twice).toContain('2.2.2.2 a.test\r\n2.2.2.2 b.test');
    expect(twice).not.toContain('1.1.1.1');
    expect(applyHostsBlock(twice, entries)).toBe(twice);
  });

  test('moves an old block from the end to the front', () => {
    const legacy = windowsHosts + [HOSTS_BEGIN, '1.1.1.1 b.test', HOSTS_END, ''].join('\r\n');
    const out = applyHostsBlock(legacy, [{ ip: '1.1.1.1', domain: 'b.test' }]);
    expect(out.indexOf(HOSTS_BEGIN)).toBeLessThan(out.indexOf('# Herd'));
    expect(out.split(HOSTS_BEGIN).length).toBe(2);
  });

  test('removing every site restores the original file', () => {
    const withBlock = applyHostsBlock(windowsHosts, [{ ip: '1.1.1.1', domain: 'b.test' }]);
    expect(applyHostsBlock(withBlock, [])).toBe(windowsHosts);
  });

  test('works on a file with no entries yet', () => {
    expect(applyHostsBlock('# header\n', [{ ip: '1.1.1.1', domain: 'a.test' }])).toBe(
      `# header\n\n${HOSTS_BEGIN}\n1.1.1.1 a.test\n${HOSTS_END}\n`,
    );
  });

  test('switches off other tools\' lines for names DevKit serves, and restores them later', () => {
    const multi = windowsHosts.replace('# END envkit', '127.0.0.1 ng-oms.test lv-oms.test\r\n# END envkit');
    const out = applyHostsBlock(multi, [{ ip: '172.29.1.2', domain: 'lv-oms.test' }]);
    const lines = out.split('\r\n');
    // Only DevKit's line for lv-oms.test is still active.
    expect(lines.filter((l) => !l.startsWith('#') && l.includes('lv-oms.test'))).toEqual(['172.29.1.2 lv-oms.test']);
    expect(lines).toContain(`${HOSTS_DISABLED}127.0.0.1 lv-oms.test`);
    // A line listing several names keeps the ones DevKit does not serve.
    expect(lines).toContain(`${HOSTS_DISABLED}127.0.0.1 ng-oms.test lv-oms.test`);
    expect(lines).toContain('127.0.0.1 ng-oms.test #DevKit-kept');
    expect(applyHostsBlock(out, [{ ip: '172.29.1.2', domain: 'lv-oms.test' }])).toBe(out);
    // Removing the DevKit site brings the original lines back.
    expect(applyHostsBlock(out, [])).toBe(multi);
  });

  test('reports names also listed by other tools', () => {
    const content = applyHostsBlock(windowsHosts, [
      { ip: '1.1.1.1', domain: 'lv-oms.test' },
      { ip: '1.1.1.1', domain: 'hello.test' },
    ]);
    expect(hostsConflicts(content, ['lv-oms.test', 'hello.test'])).toEqual(['lv-oms.test']);
  });
});

describe('nginx rendering', () => {
  test('wsl-ip mode binds only the WSL address', () => {
    const listen = renderListen('wsl-ip', '172.29.151.73');
    expect(listen.http).toContain('listen 172.29.151.73:80;');
    expect(listen.https).toContain('listen 172.29.151.73:443 ssl http2;');
    expect(listen.https).not.toContain('[::]');
  });

  test('localhost mode binds every address', () => {
    expect(renderListen('localhost', '172.29.151.73').https).toContain('listen 443 ssl http2;\nlisten [::]:443 ssl http2;');
  });

  test('static vhost redirects http and serves the root over https', () => {
    const conf = renderStaticVhost(site, { cert: '/c.crt', key: '/c.key' });
    expect(conf).toContain('return 301 https://$host$request_uri;');
    expect(conf).toContain('root "/home/dev/hello";');
    expect(conf).toContain('ssl_certificate /c.crt;');
    expect(conf).toContain('server_name hello.test *.hello.test;');
  });

  test('parses the eth0 address', () => {
    expect(parseIpAddr('2: eth0    inet 172.29.151.73/20 brd 172.29.159.255 scope global eth0')).toBe('172.29.151.73');
    expect(parseIpAddr('')).toBeNull();
  });
});

describe('Store', () => {
  test('sites and settings round-trip', () => {
    const store = new Store(':memory:');
    store.insertSite(site);
    expect(store.listSites()).toEqual([site]);
    expect(store.findSiteByDomain('hello.test')?.id).toBe('1');
    expect(() => store.insertSite({ ...site, id: '2' })).toThrow();
    store.deleteSite('1');
    expect(store.listSites()).toEqual([]);

    expect(store.getSetting('network.mode')).toBeNull();
    store.setSetting('network.mode', 'localhost');
    store.setSetting('network.mode', 'wsl-ip');
    expect(store.getSetting('network.mode')).toBe('wsl-ip');
  });
});
