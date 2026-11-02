import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path/posix';

/** Returns the API token, creating it (mode 0600) on first start. */
export function ensureToken(file: string): string {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Missing: create below.
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function tokenMatches(candidate: string, token: string): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return tokenMatches(match?.[1] ?? '', token);
}
