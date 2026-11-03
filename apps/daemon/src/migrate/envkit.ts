import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path/posix';
import { SITE_TLD, type EnvKitImport, type EnvKitQueueWorker, type EnvKitSite } from '@devkit/shared';
import { userHome } from '../node/fnm.ts';
import { detectType } from '../sites/detect.ts';
import { databaseFromEnv, readDotEnv } from '../sites/dotenv.ts';
import type { Store } from '../store.ts';

/** EnvKit's site list, as WSL sees C:\ProgramData. */
export const ENVKIT_SITES = '/mnt/c/ProgramData/envkit/sites.json';

interface RawEnvKitSite {
  name?: string;
  root?: string;
  group?: string;
  queue_workers?: { queue?: string; tries?: number; timeout?: number; sleep?: number; enabled?: boolean }[];
  dev_server?: { enabled?: boolean; port?: number; script?: string };
}

/** "C:\Users\me\app" → "/mnt/c/Users/me/app"; null for anything that is not a drive path. */
export function windowsToLinux(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path.trim());
  if (!match) return null;
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/').replace(/\/+$/, '')}`;
}

export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

/** ~/projects/<group>/<name>, so an API and its front end land next to each other. */
export function suggestTarget(home: string, name: string, group: string | null): string {
  return group ? join(home, 'projects', slug(group), slug(name)) : join(home, 'projects', slug(name));
}

export function parseQueueWorkers(raw: RawEnvKitSite['queue_workers']): EnvKitQueueWorker[] {
  return (raw ?? []).map((w) => ({
    queue: w.queue || 'default',
    tries: w.tries ?? 3,
    timeout: w.timeout ?? 60,
    sleep: w.sleep ?? 3,
    enabled: w.enabled !== false,
  }));
}

export function readEnvKit(store: Store, user: string, file = ENVKIT_SITES): EnvKitImport {
  if (!existsSync(file)) return { found: false, sitesFile: file, sites: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawEnvKitSite[];
  const home = userHome(user);
  const sites: EnvKitSite[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry.name || !entry.root) continue;
    const source = windowsToLinux(entry.root);
    if (!source) continue;
    const sourceExists = existsSync(source) && statSync(source).isDirectory();
    const domain = `${slug(entry.name)}.${SITE_TLD}`;
    const migrated = store.findSiteByDomain(domain);
    const dev = entry.dev_server;
    sites.push({
      name: entry.name,
      domain,
      windowsRoot: entry.root,
      source,
      sourceExists,
      type: sourceExists ? detectType(source) : 'static',
      group: entry.group ?? null,
      queueWorkers: parseQueueWorkers(entry.queue_workers),
      devServer: dev && dev.enabled !== false && dev.port ? { port: dev.port, script: dev.script ?? 'ng serve' } : null,
      database: sourceExists ? (databaseFromEnv(readDotEnv(source))?.name ?? null) : null,
      suggestedTarget: suggestTarget(home, entry.name, entry.group ?? null),
      migrated: migrated ? { siteId: migrated.id, root: migrated.root } : null,
    });
  }
  return { found: true, sitesFile: file, sites };
}
