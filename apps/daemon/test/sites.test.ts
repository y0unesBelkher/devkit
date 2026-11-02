import { describe, expect, test } from 'bun:test';
import { HOSTS_BEGIN, HOSTS_END, applyHostsBlock, hostsConflicts, validateDomain, type Site } from '@devkit/shared';
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
  const windowsHosts = '# Copyright\r\n127.0.0.1 lv-oms.test\r\n127.0.0.1 lv-oms.test\r\n';

  test('appends a block and keeps CRLF and other lines', () => {
    const out = applyHostsBlock(windowsHosts, [{ ip: '172.29.1.2', domain: 'hello.test' }]);
    expect(out).toBe(`# Copyright\r\n127.0.0.1 lv-oms.test\r\n127.0.0.1 lv-oms.test\r\n\r\n${HOSTS_BEGIN}\r\n172.29.1.2 hello.test\r\n${HOSTS_END}\r\n`);
  });

  test('replaces an existing block and is idempotent', () => {
    const once = applyHostsBlock(windowsHosts, [{ ip: '1.1.1.1', domain: 'b.test' }]);
    const twice = applyHostsBlock(once, [
      { ip: '2.2.2.2', domain: 'b.test' },
      { ip: '2.2.2.2', domain: 'a.test' },
    ]);
    expect(twice).toContain('2.2.2.2 a.test\r\n2.2.2.2 b.test');
    expect(twice).not.toContain('1.1.1.1');
    expect(applyHostsBlock(twice, [{ ip: '2.2.2.2', domain: 'a.test' }, { ip: '2.2.2.2', domain: 'b.test' }])).toBe(twice);
  });

  test('removing every site removes the block', () => {
    const withBlock = applyHostsBlock(windowsHosts, [{ ip: '1.1.1.1', domain: 'b.test' }]);
    expect(applyHostsBlock(withBlock, [])).toBe(windowsHosts);
  });

  test('reports domains shadowed by lines outside the block', () => {
    const content = applyHostsBlock(windowsHosts, [{ ip: '1.1.1.1', domain: 'hello.test' }]);
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
