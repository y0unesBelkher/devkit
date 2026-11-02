import { readFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import type { SiteDatabase } from '@devkit/shared';

/** Parses a .env file: KEY=value, optional `export`, quotes, and trailing comments on unquoted values. */
export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match?.[1]) continue;
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[match[1]] = value;
  }
  return env;
}

export function readDotEnv(root: string): Record<string, string> | null {
  try {
    return parseDotEnv(readFileSync(join(root, '.env'), 'utf8'));
  } catch {
    return null;
  }
}

export interface DatabaseCredentials extends SiteDatabase {
  password: string;
}

/** The MySQL/MariaDB database a Laravel .env points at, if any. */
export function databaseFromEnv(env: Record<string, string> | null): DatabaseCredentials | null {
  if (!env) return null;
  const connection = (env['DB_CONNECTION'] ?? '').toLowerCase();
  const name = env['DB_DATABASE'] ?? '';
  if ((connection !== 'mysql' && connection !== 'mariadb') || !name) return null;
  const password = env['DB_PASSWORD'] ?? '';
  return { connection, name, username: env['DB_USERNAME'] || 'root', hasPassword: password !== '', password };
}
