import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DAEMON_PATHS, type CaInfo } from '@devkit/shared';
import { run } from '../exec.ts';

/** Locations, overridable for tests. */
export const certPaths = {
  caDir: process.env.DEVKIT_CA_DIR ?? DAEMON_PATHS.caDir,
  certsDir: process.env.DEVKIT_CERTS_DIR ?? DAEMON_PATHS.certsDir,
};

const SYSTEM_CA_COPY = '/usr/local/share/ca-certificates/devkit-ca.crt';
/** Browsers reject leaf certificates valid for more than 398 days. */
const LEAF_DAYS = 397;
const RENEW_BEFORE_SEC = 30 * 24 * 3600;

const caCert = () => join(certPaths.caDir, 'ca.crt');
const caKey = () => join(certPaths.caDir, 'ca.key');

export function siteCertPaths(domain: string): { cert: string; key: string } {
  return { cert: join(certPaths.certsDir, `${domain}.crt`), key: join(certPaths.certsDir, `${domain}.key`) };
}

async function openssl(args: string[]): Promise<string> {
  const result = await run(['openssl', ...args], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Creates the CA on first use and makes WSL itself trust it (curl, PHP, Node inside WSL). */
export async function ensureCa(): Promise<void> {
  if (existsSync(caCert()) && existsSync(caKey())) return;
  mkdirSync(certPaths.caDir, { recursive: true, mode: 0o700 });
  const created = new Date().toISOString().slice(0, 10);
  await openssl([
    'req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '3650',
    '-keyout', caKey(), '-out', caCert(),
    '-subj', `/O=DevKit/CN=DevKit Local CA (${hostname()} ${created})`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  if (process.getuid?.() === 0) {
    writeFileSync(SYSTEM_CA_COPY, readFileSync(caCert()));
    await run(['update-ca-certificates'], { timeoutMs: 60_000 });
  }
}

export async function getCaInfo(): Promise<CaInfo> {
  await ensureCa();
  const out = await openssl(['x509', '-in', caCert(), '-noout', '-fingerprint', '-sha1', '-subject', '-enddate', '-nameopt', 'RFC2253']);
  const field = (name: string) => out.match(new RegExp(`^${name}=(.*)$`, 'mi'))?.[1]?.trim() ?? '';
  return {
    pem: readFileSync(caCert(), 'utf8'),
    thumbprint: field('sha1 Fingerprint').replace(/:/g, '').toUpperCase(),
    subject: field('subject'),
    notAfter: field('notAfter'),
  };
}

async function certIsUsable(cert: string, domain: string): Promise<boolean> {
  if (!existsSync(cert)) return false;
  const expiring = await run(['openssl', 'x509', '-in', cert, '-noout', '-checkend', String(RENEW_BEFORE_SEC)]);
  if (expiring.code !== 0) return false;
  const san = await run(['openssl', 'x509', '-in', cert, '-noout', '-ext', 'subjectAltName']);
  return san.stdout.includes(`DNS:${domain}`);
}

/** Issues (or reuses) the certificate for `domain`, also valid for `*.domain`. */
export async function ensureSiteCert(domain: string): Promise<{ cert: string; key: string }> {
  await ensureCa();
  const paths = siteCertPaths(domain);
  if (await certIsUsable(paths.cert, domain)) return paths;

  mkdirSync(certPaths.certsDir, { recursive: true, mode: 0o700 });
  const csr = join(certPaths.certsDir, `${domain}.csr`);
  const ext = join(certPaths.certsDir, `${domain}.ext`);
  writeFileSync(
    ext,
    [
      `subjectAltName=DNS:${domain},DNS:*.${domain}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
    ].join('\n') + '\n',
  );
  try {
    await openssl(['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-keyout', paths.key, '-out', csr, '-subj', `/CN=${domain}`]);
    await openssl([
      'x509', '-req', '-in', csr, '-CA', caCert(), '-CAkey', caKey(), '-set_serial', `0x${crypto.randomUUID().replace(/-/g, '')}`,
      '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext, '-out', paths.cert,
    ]);
  } finally {
    rmSync(csr, { force: true });
    rmSync(ext, { force: true });
  }
  return paths;
}

export function removeSiteCert(domain: string): void {
  const paths = siteCertPaths(domain);
  rmSync(paths.cert, { force: true });
  rmSync(paths.key, { force: true });
}
