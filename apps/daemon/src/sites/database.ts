import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { DatabaseCredentials } from './dotenv.ts';

const NAME = /^[A-Za-z0-9_$-]{1,64}$/;
const USER = /^[A-Za-z0-9_.-]{1,32}$/;

const sqlString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const sqlIdent = (value: string) => `\`${value.replace(/`/g, '``')}\``;

/** Runs SQL as MySQL's root over the unix socket (auth_socket: the root daemon needs no password). */
async function mysql(sql: string): Promise<string> {
  const result = await run(['mysql', '--protocol=socket', '-uroot', '--batch', '--skip-column-names', '-e', sql], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new HttpError(500, `MySQL: ${result.stderr.trim()}`);
  return result.stdout;
}

async function userExists(user: string, host: string): Promise<boolean> {
  const out = await mysql(`SELECT COUNT(*) FROM mysql.user WHERE user = ${sqlString(user)} AND host = ${sqlString(host)}`);
  return out.trim() === '1';
}

/**
 * Creates the .env database and lets the .env user reach it over TCP (Laravel's DB_HOST=127.0.0.1).
 * `root` keeps socket auth for localhost; a separate root@127.0.0.1 account gets the .env password,
 * matching how EnvKit and Herd set up local MySQL. Existing accounts are never changed.
 */
export async function ensureMysqlDatabase(db: DatabaseCredentials): Promise<string[]> {
  if (!NAME.test(db.name)) throw new HttpError(422, `Unsupported database name "${db.name}"`);
  if (!USER.test(db.username)) throw new HttpError(422, `Unsupported database user "${db.username}"`);
  const notes: string[] = [];

  const existed = (await mysql(`SHOW DATABASES LIKE ${sqlString(db.name.replace(/[\\_%]/g, '\\$&'))}`)).trim() !== '';
  await mysql(`CREATE DATABASE IF NOT EXISTS ${sqlIdent(db.name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  notes.push(existed ? `Database ${db.name} already existed.` : `Created database ${db.name}.`);

  const hosts = db.username === 'root' ? ['127.0.0.1'] : ['localhost', '127.0.0.1'];
  const scope = db.username === 'root' ? '*.*' : `${sqlIdent(db.name)}.*`;
  for (const host of hosts) {
    const account = `${sqlString(db.username)}@${sqlString(host)}`;
    if (await userExists(db.username, host)) {
      notes.push(`MySQL user ${db.username}@${host} already existed; its password was left unchanged.`);
    } else {
      await mysql(`CREATE USER ${account} IDENTIFIED BY ${sqlString(db.password)}`);
      notes.push(`Created MySQL user ${db.username}@${host}.`);
    }
    await mysql(`GRANT ALL PRIVILEGES ON ${scope} TO ${account}${db.username === 'root' ? ' WITH GRANT OPTION' : ''}`);
  }
  return notes;
}
