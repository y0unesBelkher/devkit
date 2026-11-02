import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path/posix';
import type { Group, ProcessKind, Site, SiteType } from '@devkit/shared';

interface SiteRow {
  id: string;
  domain: string;
  root: string;
  docroot: string;
  type: string;
  php_version: string | null;
  node_version: string | null;
  port: number | null;
  created_at: number;
}

/** A site process as stored; its live state comes from systemd. */
export interface ProcessRow {
  id: string;
  siteId: string;
  kind: ProcessKind;
  name: string;
  command: string;
  autostart: boolean;
}

interface ProcessDbRow {
  id: string;
  site_id: string;
  kind: string;
  name: string;
  command: string;
  autostart: number;
}

/** Each migration is a list of single statements, applied in a transaction. */
const MIGRATIONS: string[][] = [
  [`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`],
  [
    `CREATE TABLE sites (
       id TEXT PRIMARY KEY,
       domain TEXT NOT NULL UNIQUE,
       root TEXT NOT NULL,
       type TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ],
  [
    `ALTER TABLE sites ADD COLUMN docroot TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE sites ADD COLUMN php_version TEXT`,
    `UPDATE sites SET docroot = root WHERE docroot = ''`,
  ],
  [
    `ALTER TABLE sites ADD COLUMN node_version TEXT`,
    `ALTER TABLE sites ADD COLUMN port INTEGER`,
    `CREATE TABLE processes (
       id TEXT PRIMARY KEY,
       site_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       command TEXT NOT NULL,
       autostart INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ],
  [
    `CREATE TABLE site_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
    `ALTER TABLE sites ADD COLUMN group_id TEXT`,
  ],
];

const toSite = (row: SiteRow): Site => ({
  id: row.id,
  domain: row.domain,
  root: row.root,
  docroot: row.docroot,
  type: row.type as SiteType,
  phpVersion: row.php_version,
  nodeVersion: row.node_version,
  port: row.port,
  createdAt: row.created_at,
});

const toProcess = (row: ProcessDbRow): ProcessRow => ({
  id: row.id,
  siteId: row.site_id,
  kind: row.kind as ProcessKind,
  name: row.name,
  command: row.command,
  autostart: row.autostart === 1,
});

/** Daemon state in SQLite (sites, settings). Pass ':memory:' in tests. */
export class Store {
  private readonly db: Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        for (const statement of MIGRATIONS[i]!) this.db.exec(statement);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  getSetting(key: string): string | null {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  listSites(): Site[] {
    return this.db.query<SiteRow, []>('SELECT * FROM sites ORDER BY domain').all().map(toSite);
  }

  getSite(id: string): Site | null {
    const row = this.db.query<SiteRow, [string]>('SELECT * FROM sites WHERE id = ?').get(id);
    return row ? toSite(row) : null;
  }

  findSiteByDomain(domain: string): Site | null {
    const row = this.db.query<SiteRow, [string]>('SELECT * FROM sites WHERE domain = ?').get(domain);
    return row ? toSite(row) : null;
  }

  insertSite(site: Site): void {
    this.db
      .query(
        'INSERT INTO sites (id, domain, root, docroot, type, php_version, node_version, port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(site.id, site.domain, site.root, site.docroot, site.type, site.phpVersion, site.nodeVersion, site.port, site.createdAt);
  }

  setSitePhpVersion(id: string, phpVersion: string): void {
    this.db.query('UPDATE sites SET php_version = ? WHERE id = ?').run(phpVersion, id);
  }

  deleteSite(id: string): void {
    this.db.query('DELETE FROM sites WHERE id = ?').run(id);
  }

  listProcesses(siteId?: string): ProcessRow[] {
    const rows = siteId
      ? this.db.query<ProcessDbRow, [string]>('SELECT * FROM processes WHERE site_id = ? ORDER BY created_at').all(siteId)
      : this.db.query<ProcessDbRow, []>('SELECT * FROM processes ORDER BY created_at').all();
    return rows.map(toProcess);
  }

  getProcess(id: string): ProcessRow | null {
    const row = this.db.query<ProcessDbRow, [string]>('SELECT * FROM processes WHERE id = ?').get(id);
    return row ? toProcess(row) : null;
  }

  insertProcess(process: ProcessRow): void {
    this.db
      .query('INSERT INTO processes (id, site_id, kind, name, command, autostart, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(process.id, process.siteId, process.kind, process.name, process.command, process.autostart ? 1 : 0, Date.now());
  }

  updateProcess(process: ProcessRow): void {
    this.db
      .query('UPDATE processes SET name = ?, command = ?, autostart = ? WHERE id = ?')
      .run(process.name, process.command, process.autostart ? 1 : 0, process.id);
  }

  deleteProcess(id: string): void {
    this.db.query('DELETE FROM processes WHERE id = ?').run(id);
  }

  listGroups(): Group[] {
    const groups = this.db.query<{ id: string; name: string }, []>('SELECT id, name FROM site_groups ORDER BY name COLLATE NOCASE').all();
    const members = this.db
      .query<{ id: string; group_id: string }, []>('SELECT id, group_id FROM sites WHERE group_id IS NOT NULL ORDER BY domain')
      .all();
    return groups.map((g) => ({ ...g, siteIds: members.filter((m) => m.group_id === g.id).map((m) => m.id) }));
  }

  getGroup(id: string): Group | null {
    return this.listGroups().find((g) => g.id === id) ?? null;
  }

  findGroupByName(name: string): Group | null {
    return this.listGroups().find((g) => g.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  insertGroup(id: string, name: string): void {
    this.db.query('INSERT INTO site_groups (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
  }

  renameGroup(id: string, name: string): void {
    this.db.query('UPDATE site_groups SET name = ? WHERE id = ?').run(name, id);
  }

  /** Deleting a group leaves its sites in place, ungrouped. */
  deleteGroup(id: string): void {
    this.db.transaction(() => {
      this.db.query('UPDATE sites SET group_id = NULL WHERE group_id = ?').run(id);
      this.db.query('DELETE FROM site_groups WHERE id = ?').run(id);
    })();
  }

  setSiteGroup(siteId: string, groupId: string | null): void {
    this.db.query('UPDATE sites SET group_id = ? WHERE id = ?').run(groupId, siteId);
  }

  close(): void {
    this.db.close();
  }
}
