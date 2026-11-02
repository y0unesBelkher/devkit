import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Site, SiteType } from '@devkit/shared';

interface SiteRow {
  id: string;
  domain: string;
  root: string;
  type: string;
  created_at: number;
}

const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE sites (
     id TEXT PRIMARY KEY,
     domain TEXT NOT NULL UNIQUE,
     root TEXT NOT NULL,
     type TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

const toSite = (row: SiteRow): Site => ({
  id: row.id,
  domain: row.domain,
  root: row.root,
  type: row.type as SiteType,
  createdAt: row.created_at,
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
        this.db.exec(MIGRATIONS[i]!);
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
      .query('INSERT INTO sites (id, domain, root, type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(site.id, site.domain, site.root, site.type, site.createdAt);
  }

  deleteSite(id: string): void {
    this.db.query('DELETE FROM sites WHERE id = ?').run(id);
  }
}
