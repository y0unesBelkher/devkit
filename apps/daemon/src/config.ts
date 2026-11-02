import { readFileSync } from 'node:fs';
import { DAEMON_PATHS, DAEMON_PORT, type DaemonConfig } from '@devkit/shared';

/** File locations, overridable through env so the daemon can run unprivileged in tests and dev. */
export const paths = {
  config: process.env.DEVKIT_CONFIG ?? DAEMON_PATHS.config,
  token: process.env.DEVKIT_TOKEN_FILE ?? DAEMON_PATHS.token,
};

export function loadConfig(file = paths.config): DaemonConfig {
  const defaults: DaemonConfig = { user: process.env.SUDO_USER ?? 'root', port: DAEMON_PORT };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return defaults;
  }
  const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
  return {
    user: typeof parsed.user === 'string' && parsed.user ? parsed.user : defaults.user,
    port: typeof parsed.port === 'number' ? parsed.port : defaults.port,
  };
}
