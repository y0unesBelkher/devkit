import { randomUUID } from 'node:crypto';
import {
  PHP_VERSIONS,
  validateDomain,
  type CreateSiteRequest,
  type CreateSiteResponse,
  type ListenMode,
  type NetworkInfo,
  type Site,
  type SiteType,
} from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import type { Store } from '../store.ts';
import { ensureSiteCert, removeSiteCert } from './certs.ts';
import { ensureMysqlDatabase } from './database.ts';
import { docrootFor } from './detect.ts';
import { databaseFromEnv, readDotEnv } from './dotenv.ts';
import { ensurePool, fpmSocket } from './fpm.ts';
import { getNetworkInfo, setListenMode } from './network.ts';
import {
  applyConfig,
  ensureNginxBase,
  nginxFailed,
  nginxInstalled,
  removeVhost,
  renderPhpVhost,
  renderStaticVhost,
  testConfig,
  writeListen,
  writeVhost,
} from './nginx.ts';
import { syncPhpShim } from './php-shim.ts';
import { resolveRoot } from './root.ts';

const SITE_TYPES: readonly SiteType[] = ['static', 'php', 'laravel'];

/** Serializes every change to nginx/FPM config so concurrent requests cannot interleave. */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => undefined);
  return next;
}

function requirePhpVersion(version: string | null | undefined): string {
  if (!version || !(PHP_VERSIONS as readonly string[]).includes(version)) {
    throw new HttpError(422, `Choose a PHP version (${PHP_VERSIONS.join(', ')})`);
  }
  return version;
}

async function renderVhostFor(site: Site, user: string): Promise<string> {
  const cert = await ensureSiteCert(site.domain);
  if (site.type === 'static') return renderStaticVhost(site, cert);
  const version = requirePhpVersion(site.phpVersion);
  await ensurePool(version, user);
  return renderPhpVhost(site, cert, fpmSocket(version));
}

/** Writes the vhost, validates the whole nginx config, and restores `previous` (or removes it) on failure. */
async function installVhost(site: Site, content: string, previous: string | null): Promise<void> {
  writeVhost(site, content);
  const configError = await testConfig();
  if (configError) {
    if (previous === null) removeVhost(site.domain);
    else writeVhost(site, previous);
    throw new HttpError(422, `nginx rejected the configuration:\n${configError}`);
  }
}

export function createSite(store: Store, user: string, request: CreateSiteRequest): Promise<CreateSiteResponse> {
  return exclusive(async () => {
    const domain = String(request.domain ?? '').trim().toLowerCase();
    const domainError = validateDomain(domain);
    if (domainError) throw new HttpError(422, domainError);
    if (!SITE_TYPES.includes(request.type)) throw new HttpError(422, `Unsupported site type "${request.type}"`);
    if (store.findSiteByDomain(domain)) throw new HttpError(409, `${domain} already exists`);
    const root = resolveRoot(String(request.root ?? '').trim());
    const phpVersion = request.type === 'static' ? null : requirePhpVersion(request.phpVersion);

    const network = await getNetworkInfo(store);
    await ensureNginxBase(user, network.mode, network.wslIp);
    const site: Site = {
      id: randomUUID(),
      domain,
      root,
      docroot: docrootFor(request.type, root),
      type: request.type,
      phpVersion,
      createdAt: Date.now(),
    };
    await installVhost(site, await renderVhostFor(site, user), null);

    // The site works without its database, so a MySQL problem is reported rather than fatal.
    const notes: string[] = [];
    if (request.createDatabase && site.type === 'laravel') {
      const database = databaseFromEnv(readDotEnv(root));
      if (!database) notes.push('No MySQL database configured in .env; nothing to create.');
      else notes.push(...(await ensureMysqlDatabase(database).catch((e: Error) => [`Database not created: ${e.message}`])));
    }

    store.insertSite(site);
    await applyConfig();
    syncPhpShim(store.listSites());
    return { site, notes };
  });
}

export function setSitePhpVersion(store: Store, user: string, id: string, version: string): Promise<Site> {
  return exclusive(async () => {
    const site = store.getSite(id);
    if (!site) throw new HttpError(404, 'Unknown site');
    if (site.type === 'static') throw new HttpError(422, 'Static sites do not use PHP');
    const updated: Site = { ...site, phpVersion: requirePhpVersion(version) };
    await installVhost(updated, await renderVhostFor(updated, user), await renderVhostFor(site, user).catch(() => null));
    store.setSitePhpVersion(id, updated.phpVersion!);
    await applyConfig();
    syncPhpShim(store.listSites());
    return updated;
  });
}

export function deleteSite(store: Store, id: string): Promise<void> {
  return exclusive(async () => {
    const site = store.getSite(id);
    if (!site) throw new HttpError(404, 'Unknown site');
    removeVhost(site.domain);
    removeSiteCert(site.domain);
    store.deleteSite(id);
    if (nginxInstalled()) await applyConfig();
    syncPhpShim(store.listSites());
  });
}

/**
 * Re-points nginx at the current WSL IP (it changes when WSL restarts) or at all addresses in
 * localhost mode. Runs at daemon startup and when the mode changes.
 */
export function syncNetwork(store: Store): Promise<NetworkInfo> {
  return exclusive(async () => {
    const network = await getNetworkInfo(store);
    if (!nginxInstalled() || store.listSites().length === 0) return network;
    const changed = writeListen(network.mode, network.wslIp);
    if (changed) {
      const configError = await testConfig();
      if (configError) throw new HttpError(500, `nginx rejected the listen configuration:\n${configError}`);
      await applyConfig();
    } else if (await nginxFailed()) {
      // Booted before we fixed the listen IP; a stopped-on-purpose nginx is left alone.
      await applyConfig();
    }
    return network;
  });
}

export async function changeListenMode(store: Store, mode: ListenMode): Promise<NetworkInfo> {
  if (mode !== 'wsl-ip' && mode !== 'localhost') throw new HttpError(422, `Unknown mode "${mode}"`);
  setListenMode(store, mode);
  return syncNetwork(store);
}
