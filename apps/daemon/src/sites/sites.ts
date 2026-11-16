import { randomUUID } from 'node:crypto';
import {
  DEV_SERVER_PORT_START,
  validateDomain,
  type CreateProcessRequest,
  type CreateSiteRequest,
  type CreateSiteResponse,
  type ListenMode,
  type NetworkInfo,
  type Site,
  type SiteProcess,
  type SiteType,
  type UpdateProcessRequest,
} from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import { listNodeVersions } from '../node/fnm.ts';
import type { ProcessRow, Store } from '../store.ts';
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
  readVhost,
  removeVhost,
  renderPhpVhost,
  renderProxyVhost,
  renderStaticVhost,
  testConfig,
  writeListen,
  writeVhost,
} from './nginx.ts';
import { phpVersions } from '../services/php-versions.ts';
import { syncPhpShim } from './php-shim.ts';
import {
  LARAVEL_PROCESSES,
  allocatePort,
  allowedKinds,
  getProcess,
  installProcessUnit,
  ngServeCommand,
  processAction,
  removeProcessUnit,
  validateCommand,
} from './processes.ts';
import { resolveRoot } from './root.ts';

const SITE_TYPES: readonly SiteType[] = ['static', 'php', 'laravel', 'angular'];

/** Serializes every change to nginx/FPM config so concurrent requests cannot interleave. */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => undefined);
  return next;
}

function requirePhpVersion(version: string | null | undefined): string {
  if (!version || !phpVersions().includes(version)) {
    throw new HttpError(422, `Choose a PHP version (${phpVersions().join(', ')})`);
  }
  return version;
}

function requireNodeVersion(user: string, version: string | null | undefined): string {
  const installed = listNodeVersions(user);
  if (installed.length === 0) throw new HttpError(422, 'Node.js is not installed. Install it on the Tools page first.');
  if (!version || !installed.includes(version)) throw new HttpError(422, `Choose an installed Node version (${installed.join(', ')})`);
  return version;
}

async function renderVhostFor(site: Site, user: string): Promise<string> {
  const cert = await ensureSiteCert(site.domain);
  if (site.type === 'static') return renderStaticVhost(site, cert);
  if (site.type === 'angular') return renderProxyVhost(site, cert, site.port!);
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
    const usesPhp = request.type === 'php' || request.type === 'laravel';
    const phpVersion = usesPhp ? requirePhpVersion(request.phpVersion) : null;
    const nodeVersion = request.type === 'angular' ? requireNodeVersion(user, request.nodeVersion) : null;
    const port = request.type === 'angular' ? await allocatePort(store, DEV_SERVER_PORT_START) : null;

    const network = await getNetworkInfo(store);
    await ensureNginxBase(user, network.mode, network.wslIp);
    const site: Site = {
      id: randomUUID(),
      domain,
      root,
      docroot: docrootFor(request.type, root),
      type: request.type,
      phpVersion,
      nodeVersion,
      port,
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

    if (site.type === 'angular') {
      const process: ProcessRow = {
        id: randomUUID(),
        siteId: site.id,
        kind: 'ng-serve',
        name: 'ng serve',
        command: ngServeCommand(site),
        autostart: true,
      };
      store.insertProcess(process);
      try {
        await installProcessUnit(process, site, user);
        await processAction(process.id, 'start');
        notes.push(`Started ng serve on port ${site.port}; the first build can take a minute.`);
      } catch (e) {
        notes.push(`ng serve was set up but did not start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { site, notes };
  });
}

export function setSitePhpVersion(store: Store, user: string, id: string, version: string): Promise<Site> {
  return exclusive(async () => {
    const site = store.getSite(id);
    if (!site) throw new HttpError(404, 'Unknown site');
    if (site.type !== 'php' && site.type !== 'laravel') throw new HttpError(422, 'Only PHP and Laravel sites use PHP');
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
    for (const process of store.listProcesses(id)) {
      await removeProcessUnit(process.id);
      store.deleteProcess(process.id);
    }
    removeVhost(site.domain);
    removeSiteCert(site.domain);
    store.deleteSite(id);
    if (nginxInstalled()) await applyConfig();
    syncPhpShim(store.listSites());
  });
}

// ---------------------------------------------------------------------------
// Site processes

export function createProcess(store: Store, user: string, siteId: string, request: CreateProcessRequest): Promise<SiteProcess> {
  return exclusive(async () => {
    const site = store.getSite(siteId);
    if (!site) throw new HttpError(404, 'Unknown site');
    const kind = request.kind;
    if (!allowedKinds(site).includes(kind)) throw new HttpError(422, `A ${site.type} site cannot run "${kind}"`);
    if (kind !== 'custom' && store.listProcesses(siteId).some((p) => p.kind === kind)) {
      throw new HttpError(409, `${site.domain} already has this process`);
    }

    const defaults = kind === 'queue' || kind === 'schedule' || kind === 'horizon' ? LARAVEL_PROCESSES[kind] : null;
    const name = (request.name ?? defaults?.name ?? (kind === 'ng-serve' ? 'ng serve' : '')).trim();
    if (!name || name.length > 60) throw new HttpError(422, 'Give the process a short name');
    const command = validateCommand(request.command ?? defaults?.command ?? (kind === 'ng-serve' ? ngServeCommand(site) : ''));

    const process: ProcessRow = { id: randomUUID(), siteId, kind, name, command, autostart: request.autostart ?? true };
    store.insertProcess(process);
    try {
      await installProcessUnit(process, site, user);
      await processAction(process.id, 'start');
    } catch (e) {
      await removeProcessUnit(process.id);
      store.deleteProcess(process.id);
      throw e;
    }
    return getProcess(store, process.id);
  });
}

export function updateProcess(store: Store, user: string, id: string, request: UpdateProcessRequest): Promise<SiteProcess> {
  return exclusive(async () => {
    const current = store.getProcess(id);
    if (!current) throw new HttpError(404, 'Unknown process');
    const site = store.getSite(current.siteId)!;
    const updated: ProcessRow = {
      ...current,
      name: request.name?.trim() || current.name,
      command: request.command === undefined ? current.command : validateCommand(request.command),
      autostart: request.autostart ?? current.autostart,
    };
    store.updateProcess(updated);
    await installProcessUnit(updated, site, user);
    const wasActive = (await getProcess(store, id)).active === 'active';
    if (wasActive && updated.command !== current.command) await processAction(id, 'restart');
    return getProcess(store, id);
  });
}

export function deleteProcess(store: Store, id: string): Promise<void> {
  return exclusive(async () => {
    if (!store.getProcess(id)) throw new HttpError(404, 'Unknown process');
    await removeProcessUnit(id);
    store.deleteProcess(id);
  });
}

/**
 * Re-renders every site's vhost from the current templates, so fixes in a new DevKit version reach
 * existing sites. A site whose new config nginx rejects keeps its old one.
 */
export function refreshVhosts(store: Store, user: string): Promise<string[]> {
  return exclusive(async () => {
    const sites = store.listSites();
    if (!nginxInstalled() || sites.length === 0) return [];
    const network = await getNetworkInfo(store);
    await ensureNginxBase(user, network.mode, network.wslIp);
    const updated: string[] = [];
    for (const site of sites) {
      try {
        const content = await renderVhostFor(site, user);
        const current = readVhost(site.domain);
        if (content === current) continue;
        await installVhost(site, content, current);
        updated.push(site.domain);
      } catch (e) {
        console.error(`vhost refresh for ${site.domain} failed:`, e);
      }
    }
    if (updated.length) await applyConfig();
    return updated;
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
