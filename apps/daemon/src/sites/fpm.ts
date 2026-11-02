import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';

/** One DevKit pool per PHP version, shared by every site on that version. */
export const fpmSocket = (version: string) => `/run/php/devkit-php${version}.sock`;
const poolFile = (version: string) => `/etc/php/${version}/fpm/pool.d/devkit.conf`;

/** The pool runs as the project user, so Laravel can write storage/ and cache/ without chmod 777. */
export function renderPool(version: string, user: string, group: string): string {
  return `; Managed by DevKit - edits are overwritten.
[devkit]
user = ${user}
group = ${group}
listen = ${fpmSocket(version)}
listen.owner = ${user}
listen.group = ${group}
listen.mode = 0660

pm = dynamic
pm.max_children = 10
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 4
catch_workers_output = yes

php_value[upload_max_filesize] = 100M
php_value[post_max_size] = 100M
php_value[memory_limit] = 512M
php_value[max_execution_time] = 300
`;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(200);
  }
  return existsSync(path);
}

export async function ensurePool(version: string, user: string): Promise<void> {
  if (!existsSync(`/etc/php/${version}/fpm/pool.d`)) {
    throw new HttpError(409, `PHP ${version} FPM is not installed. Install it on the Services page first.`);
  }
  const group = (await run(['id', '-gn', user])).stdout.trim() || user;
  const content = renderPool(version, user, group);
  const file = poolFile(version);
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;

  if (previous !== content) {
    writeFileSync(file, content);
    const test = await run([`php-fpm${version}`, '-t'], { timeoutMs: 30_000 });
    if (test.code !== 0) {
      if (previous === null) rmSync(file, { force: true });
      else writeFileSync(file, previous);
      throw new HttpError(500, `PHP ${version} FPM rejected the DevKit pool:\n${test.stderr.trim()}`);
    }
    const reload = await run(['systemctl', 'reload-or-restart', `php${version}-fpm`], { timeoutMs: 60_000 });
    if (reload.code !== 0) throw new HttpError(500, `Could not reload php${version}-fpm: ${reload.stderr.trim()}`);
  } else {
    // Pool config is current; make sure the service is actually up.
    await run(['systemctl', 'start', `php${version}-fpm`], { timeoutMs: 60_000 });
  }

  if (!(await waitForSocket(fpmSocket(version), 10_000))) {
    throw new HttpError(500, `php${version}-fpm did not create ${fpmSocket(version)}`);
  }
}
