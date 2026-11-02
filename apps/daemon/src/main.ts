import { DAEMON_VERSION } from '@devkit/shared';
import { ensureToken } from './auth.ts';
import { loadConfig, paths } from './config.ts';
import { Hub, type SocketData } from './hub.ts';
import { JobQueue } from './jobs.ts';
import { createFetch } from './server.ts';

if (process.argv.includes('--version')) {
  console.log(DAEMON_VERSION);
  process.exit(0);
}

const config = loadConfig();
const token = ensureToken(paths.token);
const hub = new Hub();
const jobs = new JobQueue({
  onJob: (job) => hub.broadcast({ type: 'job', job }),
  onOutput: (jobId, lines) => hub.broadcast({ type: 'job.output', jobId, lines }),
});

// Loopback only: Windows reaches it through WSL localhost forwarding, the LAN never does.
const server = Bun.serve<SocketData>({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: createFetch({ config, token, startedAt: Date.now(), jobs, hub }),
  websocket: {
    open: (ws) => hub.add(ws),
    message: (ws, message) => hub.handleMessage(ws, message),
    close: (ws) => hub.remove(ws),
  },
});

console.log(`devkitd ${DAEMON_VERSION} listening on ${server.url} (project user: ${config.user})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
