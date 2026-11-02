import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_PATHS, type Site } from '@devkit/shared';

const SHIM = '/usr/local/bin/php';
const MARKER = '# Managed by DevKit';
export const PHP_SITES_MAP = join(DAEMON_PATHS.stateDir, 'php-sites');

/**
 * `php` in a terminal runs the version of the site you are in (longest matching root), otherwise the
 * system default. It lives in /usr/local/bin, ahead of both /usr/bin and the Windows PATH that WSL
 * appends (EnvKit's php.exe), so no WSL settings need changing.
 */
export const PHP_SHIM = `#!/bin/bash
${MARKER}: runs the PHP version of the DevKit site you are in.
map=${PHP_SITES_MAP}
if [[ -r $map ]]; then
  best="" bestlen=0
  while IFS=$'\\t' read -r root version; do
    if [[ $PWD == "$root" || $PWD == "$root"/* ]] && (( \${#root} > bestlen )); then
      best=$version bestlen=\${#root}
    fi
  done < "$map"
  if [[ -n $best && -x /usr/bin/php$best ]]; then exec "/usr/bin/php$best" "$@"; fi
fi
exec /usr/bin/php "$@"
`;

export function renderPhpSitesMap(sites: Site[]): string {
  return sites
    .filter((site) => site.phpVersion)
    .map((site) => `${site.root}\t${site.phpVersion}\n`)
    .join('');
}

/** Installs the shim (unless someone else's file is there) and refreshes the site map. Root only. */
export function syncPhpShim(sites: Site[]): void {
  if (process.getuid?.() !== 0) return;
  writeFileSync(PHP_SITES_MAP, renderPhpSitesMap(sites), { mode: 0o644 });
  const current = existsSync(SHIM) ? readFileSync(SHIM, 'utf8') : null;
  if (current !== null && !current.includes(MARKER)) {
    console.warn(`${SHIM} exists and is not managed by DevKit; leaving it alone.`);
    return;
  }
  if (current !== PHP_SHIM) writeFileSync(SHIM, PHP_SHIM, { mode: 0o755 });
}
