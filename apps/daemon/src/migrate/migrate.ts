import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import { validateDomain, type MigrateRequest } from '@devkit/shared';
import { importDatabase } from '../databases/databases.ts';
import { cleanPath, requireInsideHome } from '../files/files.ts';
import { run as runCommand } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import type { JobContext } from '../jobs.ts';
import { listNodeVersions, nodeBinDir, userHome } from '../node/fnm.ts';
import { databaseFromEnv, readDotEnv } from '../sites/dotenv.ts';
import { assignSite, createGroup } from '../sites/groups.ts';
import { createProcess, createSite } from '../sites/sites.ts';
import type { Store } from '../store.ts';
import { COMPOSER_BIN } from '../tools/composer.ts';
import { asUser } from '../user-exec.ts';

/** Checks everything that can be checked before a long copy starts. */
export function validateMigration(store: Store, user: string, request: MigrateRequest): { source: string; target: string; domain: string } {
  const source = cleanPath(String(request.source ?? ''));
  if (!source.startsWith('/mnt/')) throw new HttpError(422, 'The source must be a Windows folder (/mnt/c/…)');
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new HttpError(422, `${source} does not exist`);

  const target = requireInsideHome(String(request.target ?? ''), userHome(user));
  if (existsSync(target) && readdirSync(target).length > 0) throw new HttpError(409, `${target} already exists and is not empty`);

  const domain = String(request.domain ?? '').trim().toLowerCase();
  const domainError = validateDomain(domain);
  if (domainError) throw new HttpError(422, domainError);
  if (store.findSiteByDomain(domain)) throw new HttpError(409, `${domain} is already a DevKit site`);
  if (request.databaseDump && !existsSync(request.databaseDump)) throw new HttpError(422, 'The database dump was not found');
  return { source, target, domain };
}

/** rsync arguments: node_modules is never copied (Windows builds of native packages do not run on Linux). */
export function rsyncArgs(source: string, target: string, reinstallVendor: boolean): string[] {
  return [
    'rsync',
    // -rlt plus an explicit mode: drvfs reports 777 for everything, which would make every file executable.
    '-rlt',
    '--chmod=D755,F644',
    '--info=stats1',
    '--exclude=node_modules/',
    ...(reinstallVendor ? ['--exclude=/vendor/'] : []),
    '--exclude=Thumbs.db',
    '--exclude=desktop.ini',
    `${source}/`,
    `${target}/`,
  ];
}

/** Paths git tracks as executable, from `git ls-files -s -z` ("100755 <sha> 0\tpath\0…"). */
export function executablePaths(lsFiles: string): string[] {
  return lsFiles
    .split('\0')
    .filter((entry) => entry.startsWith('100755 ') && entry.includes('\t'))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));
}

/** Points APP_URL at the new https:// address; returns the updated .env text, or null when nothing changes. */
export function rewriteAppUrl(env: string, domain: string): string | null {
  if (!/^APP_URL=/m.test(env)) return null;
  const updated = env.replace(/^APP_URL=.*$/m, `APP_URL=https://${domain}`);
  return updated === env ? null : updated;
}

export function queueCommand(worker: { queue: string; tries: number; timeout: number; sleep: number }): string {
  return `php artisan queue:work --queue=${worker.queue.replace(/[^\w,.-]/g, '')} --tries=${Math.trunc(worker.tries)} --timeout=${Math.trunc(worker.timeout)} --sleep=${Math.trunc(worker.sleep)}`;
}

/**
 * Copies a Windows project into WSL and turns it into a DevKit site: dependencies rebuilt for Linux,
 * the EnvKit database imported, its queue workers recreated, and its group kept. The Windows copy is
 * only read, never changed.
 */
export async function migrateProject(ctx: JobContext, store: Store, user: string, request: MigrateRequest): Promise<void> {
  const { source, target, domain } = validateMigration(store, user, request);
  const run = (argv: string[], pathPrefix: string[] = []) => ctx.exec(asUser(user, argv, pathPrefix), undefined, target);

  ctx.log(`Copying ${source} → ${target}`);
  await ctx.exec(asUser(user, ['mkdir', '-p', target]));
  await ctx.exec(asUser(user, rsyncArgs(source, target, request.reinstallVendor)));

  if (existsSync(join(target, '.git'))) {
    // Windows checkouts usually have CRLF files and no exec bits; without this every file shows as modified.
    await run(['git', 'config', 'core.autocrlf', 'input']);
    await run(['git', 'config', 'core.filemode', 'false']);
    // Give scripts tracked as executable (mode 100755) their x bit back after the F644 copy.
    const listed = await runCommand(asUser(user, ['git', '-C', target, 'ls-files', '-s', '-z']), { timeoutMs: 120_000 });
    const executables = executablePaths(listed.stdout);
    for (let i = 0; i < executables.length; i += 200) {
      await ctx.exec(asUser(user, ['chmod', '+x', '--', ...executables.slice(i, i + 200).map((p) => join(target, p))]));
    }
    ctx.log(`Git: core.autocrlf=input, core.filemode=false; ${executables.length} executable file(s) restored from the index.`);
  }
  const envFile = join(target, '.env');
  if (existsSync(envFile)) {
    const updated = rewriteAppUrl(readFileSync(envFile, 'utf8'), domain);
    // Writing in place keeps the file owned by the user.
    if (updated) {
      writeFileSync(envFile, updated);
      ctx.log(`.env: APP_URL=https://${domain}`);
    }
  }

  const newestNode = listNodeVersions(user)[0] ?? null;
  const nodeVersion = request.type === 'angular' ? (request.nodeVersion ?? newestNode) : newestNode;
  const npmInstall = async () => {
    if (!existsSync(join(target, 'package.json'))) return;
    if (!nodeVersion) return ctx.log('Skipping npm install: no Node version installed (Tools page).');
    const bin = nodeBinDir(user, nodeVersion);
    const ci = existsSync(join(target, 'package-lock.json'));
    await run([`${bin}/npm`, ci ? 'ci' : 'install', '--no-audit', '--no-fund'], [bin]);
  };

  // Angular: dependencies first, so ng serve starts against a complete node_modules.
  if (request.type === 'angular') await npmInstall();

  const created = await createSite(store, user, {
    domain,
    root: target,
    type: request.type,
    phpVersion: request.phpVersion ?? null,
    nodeVersion: request.type === 'angular' ? nodeVersion : null,
    createDatabase: request.type === 'laravel',
  });
  created.notes.forEach((note) => ctx.log(note));

  if (request.type === 'laravel' || request.type === 'php') {
    // After createSite, so the php shim already maps this folder to the site's PHP version.
    if (request.reinstallVendor && existsSync(join(target, 'composer.json'))) {
      if (!existsSync(COMPOSER_BIN)) throw new Error('Composer is not installed (Tools page).');
      await run(['php', COMPOSER_BIN, 'install', '--no-interaction', '--no-progress', '--no-ansi']);
    }
    await npmInstall();
  }

  if (request.databaseDump) {
    const database = databaseFromEnv(readDotEnv(target));
    if (!database) {
      ctx.log('The project has no MySQL database in .env; the dump was not imported.');
    } else {
      await importDatabase(ctx, database.name, request.databaseDump);
    }
    // The dump was a temporary file written by the desktop app.
    if (/\/devkit-envkit-[^/]+\.sql$/.test(request.databaseDump)) rmSync(request.databaseDump, { force: true });
  }

  const workers = (request.queueWorkers ?? []).filter((w) => w.enabled);
  for (const [i, worker] of workers.entries()) {
    const process = await createProcess(store, user, created.site.id, {
      kind: i === 0 ? 'queue' : 'custom',
      name: i === 0 ? 'Queue worker' : `Queue: ${worker.queue}`,
      command: queueCommand(worker),
    });
    ctx.log(`Started ${process.name}: ${process.command}`);
  }

  if (request.group) {
    const group = store.findGroupByName(request.group) ?? createGroup(store, request.group);
    assignSite(store, created.site.id, group.id);
    ctx.log(`Added to group ${group.name}.`);
  }
  ctx.log(`Done: https://${domain} now runs from ${target}. Update the hosts file to switch your browser over.`);
}
