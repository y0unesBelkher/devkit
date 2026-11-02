import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path/posix';
import { DAEMON_PATHS, type ListenMode, type Site } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';

const NGINX_CONF = '/etc/nginx/nginx.conf';
const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const LISTEN_HTTP = join(DAEMON_PATHS.nginxIncludes, 'listen-http.conf');
const LISTEN_HTTPS = join(DAEMON_PATHS.nginxIncludes, 'listen-https.conf');

const vhostName = (domain: string) => `devkit-${domain}.conf`;

/** The `listen` lines every DevKit server block includes, so switching modes rewrites two files only. */
export function renderListen(mode: ListenMode, ip: string | null): { http: string; https: string } {
  const header = '# Managed by DevKit (listen mode: ' + mode + ')\n';
  if (mode === 'localhost' || !ip) {
    return {
      http: `${header}listen 80;\nlisten [::]:80;\n`,
      https: `${header}listen 443 ssl http2;\nlisten [::]:443 ssl http2;\n`,
    };
  }
  // Bound to WSL's own IP only: WSL does not forward it to Windows' 127.0.0.1, so another stack keeps 80/443 there.
  return { http: `${header}listen ${ip}:80;\n`, https: `${header}listen ${ip}:443 ssl http2;\n` };
}

interface CertPaths {
  cert: string;
  key: string;
}

/** Shared wrapper: HTTP→HTTPS redirect plus the TLS server with `body` inside. */
function serverBlocks(site: Site, cert: CertPaths, body: string): string {
  const { domain } = site;
  return `# Managed by DevKit - edits are overwritten.
server {
    include ${LISTEN_HTTP};
    server_name ${domain} *.${domain};
    return 301 https://$host$request_uri;
}

server {
    include ${LISTEN_HTTPS};
    server_name ${domain} *.${domain};

    ssl_certificate ${cert.cert};
    ssl_certificate_key ${cert.key};

    root "${site.docroot}";
    charset utf-8;

    access_log /var/log/nginx/${domain}-access.log;
    error_log /var/log/nginx/${domain}-error.log;
${body}}
`;
}

export function renderStaticVhost(site: Site, cert: CertPaths): string {
  return serverBlocks(
    site,
    cert,
    `    index index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }
`,
  );
}

/** Dev servers (ng serve): TLS ends here, HTTP and WebSocket (live reload) go to the loopback port. */
export function renderProxyVhost(site: Site, cert: CertPaths, port: number): string {
  const downPage =
    `<!doctype html><title>Dev server not running</title><body style="font:16px system-ui;padding:3rem;max-width:40rem">` +
    `<h1>The dev server for ${site.domain} is not running</h1>` +
    `<p>Start <b>ng serve</b> for this site on the Sites page in DevKit, or check its logs there.</p></body>`;
  return serverBlocks(
    site,
    cert,
    `    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $devkit_connection_upgrade;
        # Vite rejects unknown hosts (DNS-rebinding protection) and always allows localhost.
        proxy_set_header Host localhost;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }

    error_page 502 504 = @devkit_dev_server_down;
    location @devkit_dev_server_down {
        default_type text/html;
        return 502 '${downPage}';
    }
`,
  );
}

/** PHP and Laravel: front controller routing to the per-version DevKit FPM pool. */
export function renderPhpVhost(site: Site, cert: CertPaths, fpmSocket: string): string {
  return serverBlocks(
    site,
    cert,
    `    index index.php index.html;
    client_max_body_size 100M;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    location ~ \\.php$ {
        fastcgi_pass unix:${fpmSocket};
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_hide_header X-Powered-By;
        fastcgi_read_timeout 300;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
`,
  );
}

export function nginxInstalled(): boolean {
  return existsSync(NGINX_CONF);
}

/**
 * One-time adjustments so DevKit owns nginx: workers run as the project user (so files in ~ are readable
 * without loosening home permissions), Ubuntu's default site is disabled, and the listen includes exist.
 */
export async function ensureNginxBase(user: string, mode: ListenMode, ip: string | null): Promise<void> {
  if (!nginxInstalled()) throw new HttpError(409, 'nginx is not installed. Install it on the Services page first.');
  const conf = readFileSync(NGINX_CONF, 'utf8');
  const updated = conf.replace(/^user\s+[^;]+;/m, `user ${user};`);
  if (updated !== conf) writeFileSync(NGINX_CONF, updated);
  // Request bodies and proxy buffers are written here by the workers.
  await run(['chown', '-R', user, '/var/lib/nginx']);
  rmSync(join(SITES_ENABLED, 'default'), { force: true });
  // http-level helper for proxied WebSockets (conf.d is included in the http block).
  writeFileSync(
    '/etc/nginx/conf.d/devkit-maps.conf',
    '# Managed by DevKit\nmap $http_upgrade $devkit_connection_upgrade {\n    default upgrade;\n    \'\' close;\n}\n',
  );
  writeListen(mode, ip);
}

/** Writes the listen includes; returns true when they changed. */
export function writeListen(mode: ListenMode, ip: string | null): boolean {
  mkdirSync(DAEMON_PATHS.nginxIncludes, { recursive: true });
  const listen = renderListen(mode, ip);
  const current = existsSync(LISTEN_HTTP) && existsSync(LISTEN_HTTPS)
    ? readFileSync(LISTEN_HTTP, 'utf8') + readFileSync(LISTEN_HTTPS, 'utf8')
    : '';
  if (current === listen.http + listen.https) return false;
  writeFileSync(LISTEN_HTTP, listen.http);
  writeFileSync(LISTEN_HTTPS, listen.https);
  return true;
}

export function writeVhost(site: Site, content: string): void {
  const file = join(SITES_AVAILABLE, vhostName(site.domain));
  writeFileSync(file, content);
  const link = join(SITES_ENABLED, vhostName(site.domain));
  rmSync(link, { force: true });
  symlinkSync(file, link);
}

export function readVhost(domain: string): string | null {
  try {
    return readFileSync(join(SITES_AVAILABLE, vhostName(domain)), 'utf8');
  } catch {
    return null;
  }
}

export function removeVhost(domain: string): void {
  rmSync(join(SITES_ENABLED, vhostName(domain)), { force: true });
  rmSync(join(SITES_AVAILABLE, vhostName(domain)), { force: true });
}

export async function testConfig(): Promise<string | null> {
  const result = await run(['nginx', '-t'], { timeoutMs: 30_000 });
  return result.code === 0 ? null : result.stderr.trim();
}

export async function nginxFailed(): Promise<boolean> {
  const result = await run(['systemctl', 'is-failed', 'nginx']);
  return result.stdout.trim() === 'failed';
}

/** Applies config: reload when running, otherwise start (a stale listen IP leaves nginx failed after reboot). */
export async function applyConfig(): Promise<void> {
  const active = await run(['systemctl', 'is-active', 'nginx']);
  const verb = active.stdout.trim() === 'active' ? 'reload' : 'restart';
  const result = await run(['systemctl', verb, 'nginx'], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new HttpError(500, `systemctl ${verb} nginx failed: ${result.stderr.trim()}`);
}
