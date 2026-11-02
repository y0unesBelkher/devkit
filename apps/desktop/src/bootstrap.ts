import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { DAEMON_PATHS, DAEMON_PORT, type BootstrapResult, type DaemonConfig } from '@devkit/shared';
import { forgetToken, waitForPing } from './daemon-client';
import { DISTRO, listDistros, shQuote, wsl } from './wsl';

/** The Linux daemon binary shipped with the app (built by `npm run build:daemon`). */
export function bundledDaemonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'devkitd')
    : resolve(app.getAppPath(), '..', 'daemon', 'dist', 'devkitd');
}

const unitFile = `[Unit]
Description=DevKit daemon
After=network.target

[Service]
ExecStart=${DAEMON_PATHS.binary}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

/**
 * Installs (or upgrades) devkitd as a root systemd service in the distro.
 * `wsl -u root` needs no password, so this never prompts.
 */
export async function installDaemon(): Promise<BootstrapResult> {
  const log: string[] = [];
  const fail = (message: string): BootstrapResult => {
    log.push(`ERROR: ${message}`);
    return { ok: false, log: log.join('\n') };
  };

  const distros = await listDistros();
  if (!distros.includes(DISTRO)) return fail(`WSL distro "${DISTRO}" not found (have: ${distros.join(', ') || 'none'}).`);
  log.push(`Distro: ${DISTRO}`);

  const binary = bundledDaemonPath();
  if (!existsSync(binary)) return fail(`Daemon binary missing at ${binary}. Run "npm run build:daemon".`);

  // The distro's default user owns the projects; the root daemon runs project commands as them.
  const who = await wsl(['id', '-un']);
  const user = who.stdout.trim();
  if (who.code !== 0 || !/^[a-z_][a-z0-9_-]*$/.test(user)) return fail(`Cannot determine the default WSL user: ${who.stderr}`);
  if (user === 'root') return fail('The distro default user is root; set a normal default user first.');
  log.push(`Project user: ${user}`);

  const converted = await wsl(['wslpath', '-a', binary]);
  const source = converted.stdout.trim();
  if (converted.code !== 0 || !source) return fail(`wslpath failed: ${converted.stderr}`);

  const config: DaemonConfig = { user, port: DAEMON_PORT };
  const script = [
    'set -euo pipefail',
    `install -D -m 0755 ${shQuote(source)} ${DAEMON_PATHS.binary}`,
    `install -d -m 0700 ${DAEMON_PATHS.configDir}`,
    `install -d -m 0755 ${DAEMON_PATHS.stateDir}`,
    `printf '%s\\n' ${shQuote(JSON.stringify(config, null, 2))} > ${DAEMON_PATHS.config}`,
    `printf '%s' ${shQuote(unitFile)} > ${DAEMON_PATHS.unit}`,
    'systemctl daemon-reload',
    'systemctl enable devkitd',
    'systemctl restart devkitd',
    `echo "installed $(${DAEMON_PATHS.binary} --version)"`,
  ].join('\n');

  const result = await wsl(['bash', '-s'], { user: 'root', input: script + '\n', timeoutMs: 120_000 });
  log.push(result.stdout.trim(), result.stderr.trim());
  if (result.code !== 0) return fail(`Install script exited with ${result.code}.`);

  forgetToken();
  const pong = await waitForPing(10_000);
  if (!pong) return fail(`devkitd did not answer on 127.0.0.1:${DAEMON_PORT}. Check "systemctl status devkitd" in WSL.`);
  log.push(`devkitd ${pong.version} is answering on port ${DAEMON_PORT}.`);
  return { ok: true, log: log.filter(Boolean).join('\n') };
}
