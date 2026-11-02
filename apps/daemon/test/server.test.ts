import { describe, expect, test } from 'bun:test';
import { createHandler } from '../src/server.ts';

const handler = createHandler({ config: { user: 'dev', port: 0 }, token: 'secret', startedAt: Date.now() });
const call = (path: string, init?: RequestInit) => handler(new Request(`http://127.0.0.1${path}`, init));

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
    const res = await call('/api/system', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: string }).user).toBe('dev');
  });

  test('unknown route and wrong method', async () => {
    expect((await call('/api/nope')).status).toBe(404);
    expect((await call('/api/ping', { method: 'POST' })).status).toBe(405);
  });
});
