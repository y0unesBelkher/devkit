import type { Server } from 'bun';
import { existsSync } from 'node:fs';
import {
  DAEMON_VERSION,
  PHP_EXTENSION_ACTIONS,
  PROCESS_ACTIONS,
  SERVICE_ACTIONS,
  type ApiError,
  type CreateDatabaseRequest,
  type CreateProcessRequest,
  type CreateSiteRequest,
  type DaemonConfig,
  type DatabaseFileRequest,
  type DatabasesResponse,
  type DetectRequest,
  type EnvKitImport,
  type FileOpRequest,
  type GroupRequest,
  type GroupsResponse,
  type InstallNodeRequest,
  type MigrateRequest,
  type NodeGlobalRequest,
  type NodeInfo,
  type PhpExtensionAction,
  type ProcessAction,
  type ProcessesResponse,
  type SetNetworkRequest,
  type SetSiteGroupRequest,
  type SitesResponse,
  type ToolsInfo,
  type UpdateProcessRequest,
  type UpdateSiteRequest,
  type JobsResponse,
  type LogsResponse,
  type PingResponse,
  type ServiceAction,
  type ServicesResponse,
} from '@devkit/shared';
import { isAuthorized, tokenMatches } from './auth.ts';
import { run } from './exec.ts';
import { HttpError } from './http-error.ts';
import type { Hub, SocketData } from './hub.ts';
import type { JobQueue } from './jobs.ts';
import { logCommand } from './services/logs.ts';
import {
  installService,
  listServices,
  repairPackages,
  requireService,
  runServiceAction,
  uninstallService,
} from './services/services.ts';
import { getCaInfo } from './sites/certs.ts';
import { getNetworkInfo } from './sites/network.ts';
import { FNM_BIN, installNode, listNodeVersions, validateNodeVersion } from './node/fnm.ts';
import { adminerStatus, disableAdminer, enableAdminer } from './databases/adminer.ts';
import {
  createDatabase,
  dropDatabase,
  exportDatabase,
  importDatabase,
  listDatabases,
  mysqlState,
  prepareDump,
} from './databases/databases.ts';
import { fileOperation, listFiles, previewFile } from './files/files.ts';
import { readEnvKit } from './migrate/envkit.ts';
import { migrateProject, validateMigration } from './migrate/migrate.ts';
import { detectProject, installedPhpVersions } from './sites/detect.ts';
import { assignSite, createGroup, groupAction, renameGroup, requireGroup } from './sites/groups.ts';
import { composerVersion, installComposer } from './tools/composer.ts';
import { applyUpdates, healthCheck, refreshPackageLists, toolUpdates, uninstallNode } from './tools/maintenance.ts';
import { changeGlobal, nodeToolInfo, requireNodeVersion, validatePackageName } from './tools/npm-globals.ts';
import {
  installExtension,
  isQueuedAction,
  phpToolInfo,
  requireExtension,
  requirePhpVersion,
  toggleExtension,
  uninstallExtension,
} from './tools/php-extensions.ts';
import { getProcess, listProcesses, processAction } from './sites/processes.ts';
import {
  changeListenMode,
  createProcess,
  createSite,
  deleteProcess,
  deleteSite,
  setSitePhpVersion,
  updateProcess,
} from './sites/sites.ts';
import type { Store } from './store.ts';
import { getSystemInfo } from './system.ts';

export interface ServerContext {
  config: DaemonConfig;
  token: string;
  startedAt: number;
  jobs: JobQueue;
  hub: Hub;
  store: Store;
}

interface RouteRequest {
  request: Request;
  url: URL;
  params: Record<string, string>;
  ctx: ServerContext;
}

interface Route {
  method: string;
  /** Segments starting with ":" capture a parameter. */
  path: string;
  public?: boolean;
  handler: (req: RouteRequest) => Response | Promise<Response>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function readJson<T>(request: Request): Promise<T> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === 'object') return body as T;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, 'Expected a JSON object body');
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/ping',
    public: true,
    handler: () => json({ name: 'devkitd', version: DAEMON_VERSION } satisfies PingResponse),
  },
  {
    method: 'GET',
    path: '/api/system',
    handler: async ({ ctx }) => json(await getSystemInfo(ctx.config, ctx.startedAt)),
  },
  {
    method: 'POST',
    path: '/api/system/repair-packages',
    handler: ({ ctx }) =>
      json(ctx.jobs.enqueue('Repair package system', repairPackages, () => void ctx.hub.refresh()), 202),
  },
  {
    method: 'GET',
    path: '/api/services',
    handler: async () => json({ services: await listServices() } satisfies ServicesResponse),
  },
  {
    method: 'POST',
    path: '/api/services/:id/:action',
    handler: async ({ params, ctx }) => {
      const def = requireService(params['id'] ?? '');
      const action = params['action'] ?? '';
      if (action === 'install' || action === 'uninstall') {
        const verb = action === 'install' ? 'Install' : 'Uninstall';
        const work = action === 'install' ? installService : uninstallService;
        const job = ctx.jobs.enqueue(`${verb} ${def.name}`, (jobCtx) => work(def, jobCtx), () => void ctx.hub.refresh());
        return json(job, 202);
      }
      if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `Unknown action "${action}"`);
      const status = await runServiceAction(def, action as ServiceAction);
      void ctx.hub.refresh();
      return json(status);
    },
  },
  {
    method: 'GET',
    path: '/api/services/:id/logs',
    handler: async ({ params, url }) => {
      const def = requireService(params['id'] ?? '');
      const sourceId = url.searchParams.get('source') ?? 'journal';
      const lines = Number(url.searchParams.get('lines') ?? 200);
      const result = await run(logCommand(def, sourceId, lines, false), { timeoutMs: 15_000 });
      const text = (result.stdout || result.stderr).replace(/\n$/, '');
      return json({ serviceId: def.id, sourceId, lines: text ? text.split('\n') : [] } satisfies LogsResponse);
    },
  },
  {
    method: 'GET',
    path: '/api/network',
    handler: async ({ ctx }) => json(await getNetworkInfo(ctx.store)),
  },
  {
    method: 'PUT',
    path: '/api/network',
    handler: async ({ request, ctx }) => {
      const body = await readJson<SetNetworkRequest>(request);
      return json(await changeListenMode(ctx.store, body.mode));
    },
  },
  {
    method: 'GET',
    path: '/api/ca',
    handler: async () => json(await getCaInfo()),
  },
  {
    method: 'GET',
    path: '/api/sites',
    handler: ({ ctx }) => json({ sites: ctx.store.listSites() } satisfies SitesResponse),
  },
  {
    method: 'POST',
    path: '/api/sites',
    handler: async ({ request, ctx }) => {
      const body = await readJson<CreateSiteRequest>(request);
      return json(await createSite(ctx.store, ctx.config.user, body), 201);
    },
  },
  {
    method: 'POST',
    path: '/api/sites/detect',
    handler: async ({ request, ctx }) => {
      const body = await readJson<DetectRequest>(request);
      return json(await detectProject(String(body.root ?? '').trim(), ctx.config.user));
    },
  },
  {
    method: 'GET',
    path: '/api/processes',
    handler: async ({ ctx }) => json({ processes: await listProcesses(ctx.store) } satisfies ProcessesResponse),
  },
  {
    method: 'POST',
    path: '/api/sites/:id/processes',
    handler: async ({ request, params, ctx }) => {
      const body = await readJson<CreateProcessRequest>(request);
      const process = await createProcess(ctx.store, ctx.config.user, params['id'] ?? '', body);
      void ctx.hub.refresh();
      return json(process, 201);
    },
  },
  {
    method: 'PATCH',
    path: '/api/processes/:id',
    handler: async ({ request, params, ctx }) => {
      const body = await readJson<UpdateProcessRequest>(request);
      const process = await updateProcess(ctx.store, ctx.config.user, params['id'] ?? '', body);
      void ctx.hub.refresh();
      return json(process);
    },
  },
  {
    method: 'DELETE',
    path: '/api/processes/:id',
    handler: async ({ params, ctx }) => {
      await deleteProcess(ctx.store, params['id'] ?? '');
      void ctx.hub.refresh();
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'POST',
    path: '/api/processes/:id/:action',
    handler: async ({ params, ctx }) => {
      const id = params['id'] ?? '';
      const action = params['action'] ?? '';
      if (!(PROCESS_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `Unknown action "${action}"`);
      if (!ctx.store.getProcess(id)) throw new HttpError(404, 'Unknown process');
      await processAction(id, action as ProcessAction);
      void ctx.hub.refresh();
      return json(await getProcess(ctx.store, id));
    },
  },
  {
    method: 'GET',
    path: '/api/node',
    handler: ({ ctx }) => json({ fnmInstalled: existsSync(FNM_BIN), versions: listNodeVersions(ctx.config.user) } satisfies NodeInfo),
  },
  {
    method: 'POST',
    path: '/api/node/install',
    handler: async ({ request, ctx }) => {
      const body = await readJson<InstallNodeRequest>(request);
      const version = validateNodeVersion(String(body.version ?? '').trim());
      return json(ctx.jobs.enqueue(`Install Node ${version}`, (jobCtx) => installNode(jobCtx, ctx.config.user, version)), 202);
    },
  },
  {
    method: 'PATCH',
    path: '/api/sites/:id',
    handler: async ({ request, params, ctx }) => {
      const body = await readJson<UpdateSiteRequest>(request);
      return json(await setSitePhpVersion(ctx.store, ctx.config.user, params['id'] ?? '', body.phpVersion));
    },
  },
  {
    method: 'DELETE',
    path: '/api/sites/:id',
    handler: async ({ params, ctx }) => {
      await deleteSite(ctx.store, params['id'] ?? '');
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'DELETE',
    path: '/api/node/:version',
    handler: ({ params, ctx }) => {
      const version = requireNodeVersion(ctx.config.user, params['version'] ?? '');
      const usedBy = ctx.store.listSites().filter((s) => s.nodeVersion === version).map((s) => s.domain);
      return json(ctx.jobs.enqueue(`Uninstall Node ${version}`, (job) => uninstallNode(job, ctx.config.user, version, usedBy)), 202);
    },
  },
  {
    method: 'GET',
    path: '/api/tools',
    handler: async ({ ctx }) => {
      const [php, composer, node] = await Promise.all([
        installedPhpVersions().then((versions) => Promise.all(versions.map(phpToolInfo))),
        composerVersion(),
        nodeToolInfo(ctx.config.user),
      ]);
      return json({
        php,
        composer: { installed: composer !== null, version: composer },
        fnmInstalled: existsSync(FNM_BIN),
        node,
      } satisfies ToolsInfo);
    },
  },
  {
    method: 'POST',
    path: '/api/tools/php/:version/extensions/:name/:action',
    handler: async ({ params, ctx }) => {
      const version = requirePhpVersion(params['version'] ?? '');
      const name = requireExtension(params['name'] ?? '').name;
      const action = params['action'] as PhpExtensionAction;
      if (!(PHP_EXTENSION_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `Unknown action "${action}"`);
      if (isQueuedAction(action)) {
        const work = action === 'install' ? installExtension : uninstallExtension;
        const title = `${action === 'install' ? 'Install' : 'Uninstall'} ${name} for PHP ${version}`;
        return json(ctx.jobs.enqueue(title, (job) => work(job, version, name)), 202);
      }
      await toggleExtension(version, name, action);
      return json(await phpToolInfo(version));
    },
  },
  {
    method: 'POST',
    path: '/api/tools/composer/install',
    handler: ({ ctx }) => json(ctx.jobs.enqueue('Install Composer', (job) => installComposer(job, ctx.config.user)), 202),
  },
  {
    method: 'POST',
    path: '/api/tools/node/:version/globals',
    handler: async ({ request, params, ctx }) => {
      const version = requireNodeVersion(ctx.config.user, params['version'] ?? '');
      const body = await readJson<NodeGlobalRequest>(request);
      const name = validatePackageName(String(body.package ?? ''));
      if (!['install', 'uninstall', 'update'].includes(body.action)) throw new HttpError(422, `Unknown action "${body.action}"`);
      const title = `${body.action[0]!.toUpperCase()}${body.action.slice(1)} ${name} (Node ${version})`;
      return json(ctx.jobs.enqueue(title, (job) => changeGlobal(job, ctx.config.user, version, name, body.action)), 202);
    },
  },
  {
    method: 'POST',
    path: '/api/tools/health',
    handler: ({ ctx }) => json(ctx.jobs.enqueue('Health check', (job) => healthCheck(job, ctx.config.user)), 202),
  },
  {
    method: 'GET',
    path: '/api/tools/updates',
    handler: async ({ ctx }) => json(await toolUpdates(ctx.config.user)),
  },
  {
    method: 'POST',
    path: '/api/tools/updates/check',
    handler: ({ ctx }) => json(ctx.jobs.enqueue('Check for updates', refreshPackageLists), 202),
  },
  {
    method: 'POST',
    path: '/api/tools/updates/apply',
    handler: async ({ request, ctx }) => {
      const body = await readJson<{ target: 'apt' | 'composer' | 'npm'; nodeVersion?: string }>(request);
      if (!['apt', 'composer', 'npm'].includes(body.target)) throw new HttpError(422, `Unknown target "${body.target}"`);
      const nodeVersion = body.target === 'npm' ? requireNodeVersion(ctx.config.user, String(body.nodeVersion ?? '')) : undefined;
      const title = body.target === 'apt' ? 'Upgrade packages' : body.target === 'composer' ? 'Update Composer' : `Update npm globals (Node ${nodeVersion})`;
      return json(
        ctx.jobs.enqueue(title, (job) => applyUpdates(job, ctx.config.user, body.target, nodeVersion), () => void ctx.hub.refresh()),
        202,
      );
    },
  },
  // Groups
  {
    method: 'GET',
    path: '/api/groups',
    handler: ({ ctx }) => json({ groups: ctx.store.listGroups() } satisfies GroupsResponse),
  },
  {
    method: 'POST',
    path: '/api/groups',
    handler: async ({ request, ctx }) => json(createGroup(ctx.store, (await readJson<GroupRequest>(request)).name), 201),
  },
  {
    method: 'PATCH',
    path: '/api/groups/:id',
    handler: async ({ request, params, ctx }) =>
      json(renameGroup(ctx.store, params['id'] ?? '', (await readJson<GroupRequest>(request)).name)),
  },
  {
    method: 'DELETE',
    path: '/api/groups/:id',
    handler: ({ params, ctx }) => {
      requireGroup(ctx.store, params['id'] ?? '');
      ctx.store.deleteGroup(params['id'] ?? '');
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'POST',
    path: '/api/groups/:id/:action',
    handler: async ({ params, ctx }) => {
      const action = params['action'] ?? '';
      if (!(PROCESS_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `Unknown action "${action}"`);
      const result = await groupAction(ctx.store, params['id'] ?? '', action as ProcessAction);
      void ctx.hub.refresh();
      return json(result);
    },
  },
  {
    method: 'PUT',
    path: '/api/sites/:id/group',
    handler: async ({ request, params, ctx }) => {
      const body = await readJson<SetSiteGroupRequest>(request);
      assignSite(ctx.store, params['id'] ?? '', body.groupId ?? null);
      return json({ groups: ctx.store.listGroups() } satisfies GroupsResponse);
    },
  },
  // Databases
  {
    method: 'GET',
    path: '/api/databases',
    handler: async ({ ctx }) => {
      const state = await mysqlState();
      return json({
        mysqlInstalled: state.installed,
        mysqlRunning: state.running,
        databases: state.running ? await listDatabases() : [],
        adminer: state.installed ? adminerStatus(ctx.store) : null,
      } satisfies DatabasesResponse);
    },
  },
  {
    method: 'POST',
    path: '/api/databases',
    handler: async ({ request }) => {
      const name = String((await readJson<CreateDatabaseRequest>(request)).name ?? '').trim();
      await createDatabase(name);
      return json({ name }, 201);
    },
  },
  {
    method: 'DELETE',
    path: '/api/databases/:name',
    handler: async ({ params }) => {
      await dropDatabase(params['name'] ?? '');
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'POST',
    path: '/api/databases/:name/:direction',
    handler: async ({ request, params, ctx }) => {
      const name = params['name'] ?? '';
      const direction = params['direction'];
      if (direction !== 'import' && direction !== 'export') throw new HttpError(404, `Unknown action "${direction}"`);
      const file = await prepareDump(name, String((await readJson<DatabaseFileRequest>(request)).file ?? ''), direction);
      const title = direction === 'import' ? `Import into ${name}` : `Export ${name}`;
      const work = direction === 'import' ? importDatabase : exportDatabase;
      return json(ctx.jobs.enqueue(title, (job) => work(job, name, file)), 202);
    },
  },
  {
    method: 'POST',
    path: '/api/adminer',
    handler: ({ ctx }) => json(ctx.jobs.enqueue('Set up Adminer', (job) => enableAdminer(job, ctx.store, ctx.config.user)), 202),
  },
  {
    method: 'DELETE',
    path: '/api/adminer',
    handler: async ({ ctx }) => {
      await disableAdminer(ctx.store);
      return new Response(null, { status: 204 });
    },
  },
  // Migration from EnvKit / Windows folders
  {
    method: 'GET',
    path: '/api/migrate/envkit',
    handler: ({ ctx }) => json(readEnvKit(ctx.store, ctx.config.user) satisfies EnvKitImport),
  },
  {
    method: 'POST',
    path: '/api/migrate',
    handler: async ({ request, ctx }) => {
      const body = await readJson<MigrateRequest>(request);
      const { domain } = validateMigration(ctx.store, ctx.config.user, body);
      return json(
        ctx.jobs.enqueue(`Migrate ${domain}`, (job) => migrateProject(job, ctx.store, ctx.config.user, body), () => void ctx.hub.refresh()),
        202,
      );
    },
  },
  // Files (as the project user)
  {
    method: 'GET',
    path: '/api/files',
    handler: async ({ url, ctx }) => json(await listFiles(ctx.config.user, url.searchParams.get('path') ?? undefined)),
  },
  {
    method: 'GET',
    path: '/api/files/preview',
    handler: async ({ url, ctx }) => json(await previewFile(ctx.config.user, url.searchParams.get('path') ?? '')),
  },
  {
    method: 'POST',
    path: '/api/files/:op',
    handler: async ({ request, params, ctx }) => {
      await fileOperation(ctx.config.user, params['op'] ?? '', await readJson<FileOpRequest>(request));
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    path: '/api/jobs',
    handler: ({ ctx }) => json({ jobs: ctx.jobs.list() } satisfies JobsResponse),
  },
  {
    method: 'GET',
    path: '/api/jobs/:id',
    handler: ({ params, ctx }) => {
      const job = ctx.jobs.get(params['id'] ?? '');
      if (!job) throw new HttpError(404, 'Unknown job');
      return json(job);
    },
  },
];

/** Matches a route pattern against a path; returns captured params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i] ?? '';
    const value = got[i] ?? '';
    if (segment.startsWith(':')) {
      if (!value) return null;
      params[segment.slice(1)] = decodeURIComponent(value);
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}

function error(status: number, message: string): Response {
  return json({ error: message } satisfies ApiError, status);
}

export function createFetch(ctx: ServerContext) {
  return async (request: Request, server?: Server<SocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws') {
      // Browsers cannot set headers on WebSocket requests, so the token travels in the query string (loopback only).
      if (!tokenMatches(url.searchParams.get('token') ?? '', ctx.token)) return error(401, 'Unauthorized');
      if (server?.upgrade(request, { data: { logStream: null } })) return undefined;
      return error(400, 'Expected a WebSocket upgrade');
    }

    // Several patterns can match one path (".../:id/logs" and ".../:id/:action"); the method picks between them.
    const matches = routes
      .map((route) => ({ route, params: matchPath(route.path, url.pathname) }))
      .filter((m): m is { route: Route; params: Record<string, string> } => m.params !== null);
    if (matches.length === 0) return error(404, `No route for ${url.pathname}`);
    const match = matches.find((m) => m.route.method === request.method);
    if (!match) return error(405, `Method ${request.method} not allowed`);
    if (!match.route.public && !isAuthorized(request, ctx.token)) return error(401, 'Unauthorized');

    try {
      return await match.route.handler({ request, url, params: match.params, ctx });
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      console.error(`${request.method} ${url.pathname} failed:`, e);
      return error(500, e instanceof Error ? e.message : String(e));
    }
  };
}
