import { describe, expect, test } from 'bun:test';
import { Hub } from '../src/hub.ts';
import { JobQueue } from '../src/jobs.ts';
import { createFetch, matchPath } from '../src/server.ts';

const fetchHandler = createFetch({
  config: { user: 'dev', port: 0 },
  token: 'secret',
  startedAt: Date.now(),
  jobs: new JobQueue({ onJob: () => {}, onOutput: () => {} }),
  hub: new Hub(),
});
const call = async (path: string, init?: RequestInit) => {
  const res = await fetchHandler(new Request(`http://127.0.0.1${path}`, init));
  if (!res) throw new Error('expected a response');
  return res;
};
const auth = { authorization: 'Bearer secret' };

describe('server', () => {
  test('ping is public', async () => {
    const res = await call('/api/ping');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('devkitd');
  });

  test('system requires the token', async () => {
    expect((await call('/api/system')).status).toBe(401);
    expect((await call('/api/system', { headers: { authorization: 'Bearer wrong!' } })).status).toBe(401);
  });

  test('system returns info with a valid token', async () => {
    const res = await call('/api/system', { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: string }).user).toBe('dev');
  });

  test('unknown route and wrong method', async () => {
    expect((await call('/api/nope')).status).toBe(404);
    expect((await call('/api/ping', { method: 'POST' })).status).toBe(405);
  });

  test('service routes validate ids and actions before touching the system', async () => {
    expect((await call('/api/services/nope/start', { method: 'POST', headers: auth })).status).toBe(404);
    expect((await call('/api/services/nginx/explode', { method: 'POST', headers: auth })).status).toBe(404);
    expect((await call('/api/services/nginx/logs?source=nope', { headers: auth })).status).toBe(404);
    expect((await call('/api/services/nginx/start', { method: 'POST' })).status).toBe(401);
  });

  test('websocket requires the token', async () => {
    expect((await call('/api/ws')).status).toBe(401);
    expect((await call('/api/ws?token=secret')).status).toBe(400);
  });

  test('jobs list starts empty', async () => {
    const res = await call('/api/jobs', { headers: auth });
    expect(await res.json()).toEqual({ jobs: [] });
  });
});

describe('matchPath', () => {
  test('captures parameters', () => {
    expect(matchPath('/api/services/:id/:action', '/api/services/php8.4/start')).toEqual({ id: 'php8.4', action: 'start' });
  });

  test('rejects different shapes', () => {
    expect(matchPath('/api/services/:id/:action', '/api/services/nginx')).toBeNull();
    expect(matchPath('/api/services/:id/logs', '/api/services/nginx/start')).toBeNull();
    expect(matchPath('/api/jobs/:id', '/api/jobs/')).toBeNull();
  });
});
