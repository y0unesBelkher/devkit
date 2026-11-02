import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateDomain, type CreateSiteRequest, type ListenMode, type NetworkInfo, type Site } from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import type { Store } from '../store.ts';
import { ensureSiteCert, removeSiteCert } from './certs.ts';
import { getNetworkInfo, setListenMode } from './network.ts';
import {
  applyConfig,
  ensureNginxBase,
  nginxFailed,
  nginxInstalled,
  removeVhost,
  renderStaticVhost,
  testConfig,
  writeListen,
  writeVhost,
} from './nginx.ts';

/** Serializes every change to nginx config so concurrent requests cannot interleave. */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => undefined);
  return next;
}

/** Checks the requested site root; returns its resolved path. */
export function resolveRoot(root: string): string {
  if (!root || !isAbsolute(root)) throw new HttpError(422, 'Root must be an absolute Linux path, e.g. /home/you/projects/app');
  if (root === '/mnt' || root.startsWith('/mnt/')) {
    throw new HttpError(422, 'Projects on /mnt (the Windows drive) are slow in WSL. Move the project into the Linux filesystem first.');
  }
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    throw new HttpError(422, `${root} does not exist`);
  }
  if (!statSync(resolved).isDirectory()) throw new HttpError(422, `${root} is not a directory`);
  return resolved;
}

export function createSite(store: Store, user: string, request: CreateSiteRequest): Promise<Site> {
  return exclusive(async () => {
    const domain = String(request.domain ?? '').trim().toLowerCase();
    const domainError = validateDomain(domain);
    if (domainError) throw new HttpError(422, domainError);
    if (request.type !== 'static') throw new HttpError(422, `Unsupported site type "${request.type}"`);
    if (store.findSiteByDomain(domain)) throw new HttpError(409, `${domain} already exists`);
    const root = resolveRoot(String(request.root ?? '').trim());

    const network = await getNetworkInfo(store);
    await ensureNginxBase(user, network.mode, network.wslIp);
    const cert = await ensureSiteCert(domain);
    const site: Site = { id: randomUUID(), domain, root, type: 'static', createdAt: Date.now() };

    writeVhost(site, renderStaticVhost(site, cert));
    const configError = await testConfig();
    if (configError) {
      removeVhost(domain);
      throw new HttpError(422, `nginx rejected the configuration:\n${configError}`);
    }
    store.insertSite(site);
    await applyConfig();
    return site;
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
