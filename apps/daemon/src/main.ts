import { DAEMON_VERSION } from '@devkit/shared';
import { ensureToken } from './auth.ts';
import { loadConfig, paths } from './config.ts';
import { createHandler } from './server.ts';

if (process.argv.includes('--version')) {
  console.log(DAEMON_VERSION);
  process.exit(0);
}

const config = loadConfig();
const token = ensureToken(paths.token);

// Loopback only: Windows reaches it through WSL localhost forwarding, the LAN never does.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: createHandler({ config, token, startedAt: Date.now() }),
});

console.log(`devkitd ${DAEMON_VERSION} listening on ${server.url} (project user: ${config.user})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
