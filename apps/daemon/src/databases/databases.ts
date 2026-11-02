import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path/posix';
import type { DatabaseInfo } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { installedPackages } from '../services/system-tools.ts';
import { mysql, sqlIdent, sqlString } from '../sites/database.ts';

const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
const NAME = /^[A-Za-z0-9_$-]{1,64}$/;
const MYSQL_CLIENT = 'mysql --protocol=socket -uroot';

export function validateDatabaseName(name: string): string {
  if (!NAME.test(name)) throw new HttpError(422, 'Use letters, digits, _ $ or - (up to 64 characters)');
  if (SYSTEM_SCHEMAS.has(name.toLowerCase())) throw new HttpError(422, `${name} is a MySQL system schema`);
  return name;
}

export async function mysqlState(): Promise<{ installed: boolean; running: boolean }> {
  const installed = (await installedPackages(['mysql-server'])).has('mysql-server');
  const running = installed && (await run(['systemctl', 'is-active', 'mysql'])).stdout.trim() === 'active';
  return { installed, running };
}

/** Parses tab-separated `name tables bytes` rows from --batch output. */
export function parseDatabaseRows(text: string): DatabaseInfo[] {
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols[0])
    .map(([name, tables, bytes]) => ({ name: name!, tables: Number(tables) || 0, sizeBytes: Number(bytes) || 0 }));
}

export async function listDatabases(): Promise<DatabaseInfo[]> {
  const system = [...SYSTEM_SCHEMAS].map(sqlString).join(', ');
  const out = await mysql(
    `SELECT s.schema_name, COUNT(t.table_name), COALESCE(SUM(t.data_length + t.index_length), 0)
     FROM information_schema.schemata s
     LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
     WHERE s.schema_name NOT IN (${system})
     GROUP BY s.schema_name ORDER BY s.schema_name`,
  );
  return parseDatabaseRows(out);
}

async function databaseExists(name: string): Promise<boolean> {
  return (await listDatabases()).some((db) => db.name === name);
}

export async function createDatabase(name: string): Promise<void> {
  validateDatabaseName(name);
  if (await databaseExists(name)) throw new HttpError(409, `Database ${name} already exists`);
  await mysql(`CREATE DATABASE ${sqlIdent(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export async function dropDatabase(name: string): Promise<void> {
  validateDatabaseName(name);
  if (!(await databaseExists(name))) throw new HttpError(404, `Database ${name} does not exist`);
  await mysql(`DROP DATABASE ${sqlIdent(name)}`);
}

function requireDumpPath(file: string, mustExist: boolean): string {
  if (!file || !isAbsolute(file) || file.includes('\0')) throw new HttpError(422, 'Choose a file');
  if (!/\.sql(\.gz)?$/i.test(file)) throw new HttpError(422, 'Use a .sql or .sql.gz file');
  if (mustExist && !(existsSync(file) && statSync(file).isFile())) throw new HttpError(422, `${file} does not exist`);
  if (!mustExist && !existsSync(dirname(file))) throw new HttpError(422, `${dirname(file)} does not exist`);
  return file;
}

/** Validates up front so the request fails fast instead of queueing a doomed job. */
export async function prepareDump(name: string, file: string, direction: 'import' | 'export'): Promise<string> {
  validateDatabaseName(name);
  if (!(await databaseExists(name))) throw new HttpError(404, `Database ${name} does not exist`);
  return requireDumpPath(file, direction === 'import');
}

/** Paths go to bash as positional arguments, never spliced into the script; pipefail surfaces dump errors. */
export async function importDatabase(ctx: JobContext, name: string, file: string): Promise<void> {
  const reader = /\.gz$/i.test(file) ? 'gunzip -c -- "$2"' : 'cat -- "$2"';
  await ctx.exec(['bash', '-c', `set -o pipefail; ${reader} | ${MYSQL_CLIENT} "$1"`, 'import', name, file]);
  const db = (await listDatabases()).find((d) => d.name === name);
  ctx.log(`Imported into ${name}: ${db?.tables ?? 0} tables.`);
}

export async function exportDatabase(ctx: JobContext, name: string, file: string): Promise<void> {
  const writer = /\.gz$/i.test(file) ? '| gzip -c > "$2"' : '> "$2"';
  await ctx.exec([
    'bash',
    '-c',
    `set -o pipefail; mysqldump --protocol=socket -uroot --single-transaction --routines --triggers --no-tablespaces "$1" ${writer}`,
    'export',
    name,
    file,
  ]);
  ctx.log(`Wrote ${file} (${statSync(file).size} bytes).`);
}
