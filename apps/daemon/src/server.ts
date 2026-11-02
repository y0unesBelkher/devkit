import { DAEMON_VERSION, type ApiError, type DaemonConfig, type PingResponse } from '@devkit/shared';
import { isAuthorized } from './auth.ts';
import { getSystemInfo } from './system.ts';

export interface ServerContext {
  config: DaemonConfig;
  token: string;
  startedAt: number;
}

type Handler = (request: Request, ctx: ServerContext) => Response | Promise<Response>;

interface Route {
  method: string;
  path: string;
  public?: boolean;
  handler: Handler;
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/ping',
    public: true,
    handler: () => Response.json({ name: 'devkitd', version: DAEMON_VERSION } satisfies PingResponse),
  },
  {
    method: 'GET',
    path: '/api/system',
    handler: (_req, ctx) => Response.json(getSystemInfo(ctx.config, ctx.startedAt)),
  },
];

function error(status: number, message: string): Response {
  return Response.json({ error: message } satisfies ApiError, { status });
}

export function createHandler(ctx: ServerContext) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const candidates = routes.filter((r) => r.path === pathname);
    if (candidates.length === 0) return error(404, `No route for ${pathname}`);
    const route = candidates.find((r) => r.method === request.method);
    if (!route) return error(405, `Method ${request.method} not allowed`);
    if (!route.public && !isAuthorized(request, ctx.token)) return error(401, 'Unauthorized');
    try {
      return await route.handler(request, ctx);
    } catch (e) {
      console.error(`${request.method} ${pathname} failed:`, e);
      return error(500, e instanceof Error ? e.message : String(e));
    }
  };
}
