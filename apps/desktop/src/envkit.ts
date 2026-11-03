import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DumpResult } from '@devkit/shared';
import { wsl } from './wsl';

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const ENVKIT_MYSQL = 'C:\\ProgramData\\envkit\\services\\mysql';

/**
 * mysqldump.exe matching the server EnvKit runs on port 3306. EnvKit ships MySQL and MariaDB side by side
 * (services\mysql\8.4.3, …\10.11.10) and its mysqld may run with rights that hide its path from us, so
 * ask the server for its version and pick the folder with that name.
 */
async function envkitMysqldump(): Promise<string | null> {
  if (!existsSync(ENVKIT_MYSQL)) return null;
  const versions = readdirSync(ENVKIT_MYSQL).filter((dir) => existsSync(join(ENVKIT_MYSQL, dir, 'bin', 'mysql.exe')));
  // A MariaDB client cannot sign in to MySQL 8 (caching_sha2_password) and vice versa may fail too: try each.
  let server = '';
  for (const dir of versions) {
    const probe = await run(
      join(ENVKIT_MYSQL, dir, 'bin', 'mysql.exe'),
      ['--host=127.0.0.1', '--port=3306', '--user=root', '-N', '-e', 'SELECT VERSION()'],
      15_000,
    );
    if (probe.code === 0) {
      server = probe.stdout.trim(); // "8.4.3" or "10.11.10-MariaDB"
      break;
    }
  }
  const match = versions.find((dir) => server.startsWith(dir));
  if (!match) return null;
  for (const name of ['mysqldump.exe', 'mariadb-dump.exe']) {
    const candidate = join(ENVKIT_MYSQL, match, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Dumps one database from EnvKit's MySQL (root, no password, as EnvKit configures it). Read-only on
 * EnvKit's side. WSL cannot reach EnvKit's 127.0.0.1:3306, so the dump has to happen on Windows.
 */
export async function dumpEnvKitDatabase(database: string): Promise<DumpResult> {
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) return { ok: false, message: `Invalid database name "${database}"` };
  const mysqldump = await envkitMysqldump();
  if (!mysqldump) return { ok: false, message: "EnvKit's MySQL is not running on port 3306 (start it in EnvKit first)." };

  const file = join(tmpdir(), `devkit-envkit-${database}-${Date.now()}.sql`);
  const args = [
    '--host=127.0.0.1',
    '--port=3306',
    '--user=root',
    '--single-transaction',
    '--routines',
    '--triggers',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    `--result-file=${file}`,
    // MySQL only: keeps GTID statements out of a dump that is imported into another server.
    ...(/mariadb/i.test(mysqldump) || /\\10\.\d+\.\d+\\/.test(mysqldump) ? [] : ['--set-gtid-purged=OFF']),
    database,
  ];
  const result = await run(mysqldump, args, 30 * 60_000);
  if (result.code !== 0 || !existsSync(file)) {
    return { ok: false, message: `mysqldump failed: ${(result.stderr || result.stdout).trim().split(/\r?\n/).pop()}` };
  }
  const converted = await wsl(['wslpath', '-a', file]);
  if (converted.code !== 0) return { ok: false, message: 'Could not convert the dump path for WSL' };
  const size = statSync(file).size;
  return { ok: true, file: converted.stdout.trim(), message: `Dumped ${database} from EnvKit (${(size / 1024 / 1024).toFixed(1)} MB).` };
}
