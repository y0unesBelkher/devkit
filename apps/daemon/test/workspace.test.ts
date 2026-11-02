import { describe, expect, test } from 'bun:test';
import type { Site } from '@devkit/shared';
import { renderAdminerIndex } from '../src/databases/adminer.ts';
import { parseDatabaseRows, validateDatabaseName } from '../src/databases/databases.ts';
import { cleanPath, parseFindOutput, requireInsideHome } from '../src/files/files.ts';
import { assignSite, createGroup, formatJournalJson, groupUnits, renameGroup } from '../src/sites/groups.ts';
import { Store } from '../src/store.ts';

const site = (id: string, domain: string): Site => ({
  id,
  domain,
  root: `/home/dev/${domain}`,
  docroot: `/home/dev/${domain}`,
  type: 'laravel',
  phpVersion: '8.4',
  nodeVersion: null,
  port: null,
  createdAt: 1,
});

describe('groups', () => {
  test('create, assign, rename, delete keeps sites', () => {
    const store = new Store(':memory:');
    store.insertSite(site('a', 'lv-oms.test'));
    store.insertSite(site('b', 'ng-oms.test'));
    const group = createGroup(store, ' Zoon OMS ');
    expect(group.name).toBe('Zoon OMS');
    expect(() => createGroup(store, 'zoon oms')).toThrow();
    expect(() => createGroup(store, '   ')).toThrow();

    assignSite(store, 'a', group.id);
    assignSite(store, 'b', group.id);
    expect(store.getGroup(group.id)?.siteIds).toEqual(['a', 'b']);
    expect(() => assignSite(store, 'a', 'missing')).toThrow();

    expect(renameGroup(store, group.id, 'OMS').name).toBe('OMS');
    store.deleteGroup(group.id);
    expect(store.listGroups()).toEqual([]);
    expect(store.listSites().map((s) => s.id)).toEqual(['a', 'b']);
    store.close();
  });

  test('group units are labelled by site and process', () => {
    const store = new Store(':memory:');
    store.insertSite(site('a', 'lv-oms.test'));
    const group = createGroup(store, 'OMS');
    assignSite(store, 'a', group.id);
    store.insertProcess({ id: 'p1', siteId: 'a', kind: 'horizon', name: 'Horizon', command: 'php artisan horizon', autostart: true });
    expect([...groupUnits(store, group.id)]).toEqual([['devkit-proc-p1.service', 'lv-oms.test · Horizon']]);
    store.close();
  });

  test('journal json lines become labelled lines', () => {
    const labels = new Map([['devkit-proc-p1.service', 'lv-oms.test · Horizon']]);
    expect(formatJournalJson(JSON.stringify({ _SYSTEMD_UNIT: 'devkit-proc-p1.service', MESSAGE: 'Horizon started.' }), labels)).toBe(
      '[lv-oms.test · Horizon] Horizon started.',
    );
    expect(
      formatJournalJson(JSON.stringify({ _SYSTEMD_UNIT: 'init.scope', UNIT: 'devkit-proc-p1.service', MESSAGE: 'Started.' }), labels),
    ).toBe('[lv-oms.test · Horizon] Started.');
    expect(formatJournalJson(JSON.stringify({ MESSAGE: [104, 105] }), labels)).toBeNull();
    expect(formatJournalJson('garbage', labels)).toBeNull();
  });
});

describe('databases', () => {
  test('names', () => {
    expect(validateDatabaseName('lv_oms')).toBe('lv_oms');
    expect(() => validateDatabaseName('mysql')).toThrow();
    expect(() => validateDatabaseName('a b')).toThrow();
    expect(() => validateDatabaseName('x`; DROP')).toThrow();
  });

  test('rows', () => {
    expect(parseDatabaseRows('lv_demo\t0\t0\nlv_oms\t42\t1048576\n')).toEqual([
      { name: 'lv_demo', tables: 0, sizeBytes: 0 },
      { name: 'lv_oms', tables: 42, sizeBytes: 1048576 },
    ]);
  });

  test('adminer wrapper escapes the password and only pre-fills fresh visits', () => {
    const php = renderAdminerIndex("p'a\\ss");
    expect(php).toContain("'password' => 'p\\'a\\\\ss',");
    expect(php).toContain("if (!isset($_GET['username']) && empty($_POST['auth'])) {");
    expect(php).toContain('return new class extends \\Adminer\\Adminer {');
    expect(php).toContain("require __DIR__ . '/adminer.php';");
  });
});

describe('files', () => {
  test('find output: folders first, names with tabs survive', () => {
    const out = ['f\t120\t1793650000.5\t644\tdev\tREADME.md', 'd\t4096\t1793650000\t755\tdev\tsrc', 'l\t9\t1793650000\t777\tdev\tcurrent', 'f\t1\t1\t600\tdev\ta\tb'].join('\n');
    expect(parseFindOutput(out)).toEqual([
      { name: 'src', type: 'dir', size: 4096, modified: 1793650000000, mode: '755', owner: 'dev' },
      { name: 'a\tb', type: 'file', size: 1, modified: 1000, mode: '600', owner: 'dev' },
      { name: 'current', type: 'link', size: 9, modified: 1793650000000, mode: '777', owner: 'dev' },
      { name: 'README.md', type: 'file', size: 120, modified: 1793650000500, mode: '644', owner: 'dev' },
    ]);
  });

  test('paths are normalised and changes stay inside home', () => {
    expect(cleanPath('/home/dev/projects/../x/')).toBe('/home/dev/x');
    expect(cleanPath('/')).toBe('/');
    expect(() => cleanPath('relative')).toThrow();
    expect(requireInsideHome('/home/dev/projects/app', '/home/dev')).toBe('/home/dev/projects/app');
    expect(() => requireInsideHome('/home/dev', '/home/dev')).toThrow();
    expect(() => requireInsideHome('/home/dev/../other', '/home/dev')).toThrow();
    expect(() => requireInsideHome('/home/devil/x', '/home/dev')).toThrow();
    expect(() => requireInsideHome('/etc/passwd', '/home/dev')).toThrow();
  });
});
