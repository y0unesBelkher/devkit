import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, normalize } from 'node:path/posix';
import type { FileEntry, FileOpRequest, FilePreview, ListFilesResponse } from '@devkit/shared';
import { run } from '../exec.ts';
import { HttpError } from '../http-error.ts';
import { userHome } from '../node/fnm.ts';
import { asUser } from '../user-exec.ts';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const FIND_TYPES: Record<string, FileEntry['type']> = { d: 'dir', f: 'file', l: 'link' };

export function cleanPath(path: string): string {
  if (!path || !isAbsolute(path) || path.includes('\0')) throw new HttpError(422, 'Paths must be absolute, e.g. /home/you/projects');
  const cleaned = normalize(path);
  return cleaned.length > 1 ? cleaned.replace(/\/+$/, '') : cleaned;
}

/** Changes are only allowed inside the user's home (never the home folder itself). */
export function requireInsideHome(path: string, home: string): string {
  const cleaned = cleanPath(path);
  if (!cleaned.startsWith(`${home}/`)) throw new HttpError(403, `Changes are limited to your home folder (${home})`);
  return cleaned;
}

/** Parses `find -printf '%y\t%s\t%T@\t%m\t%u\t%f\n'`: directories first, then by name. */
export function parseFindOutput(text: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of text.split('\n')) {
    const [type, size, modified, mode, owner, ...name] = line.split('\t');
    if (!type || name.length === 0) continue;
    entries.push({
      name: name.join('\t'),
      type: FIND_TYPES[type] ?? 'other',
      size: Number(size) || 0,
      modified: Math.round(Number(modified) * 1000) || 0,
      mode: mode ?? '',
      owner: owner ?? '',
    });
  }
  return entries.sort((a, b) =>
    (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1,
  );
}

function failure(stderr: string, fallback: string): HttpError {
  const message = stderr.trim().split('\n').pop() || fallback;
  if (/permission denied/i.test(message)) return new HttpError(403, message);
  if (/no such file/i.test(message)) return new HttpError(404, message);
  return new HttpError(409, message);
}

async function asUserOrFail(user: string, argv: string[], fallback: string): Promise<string> {
  const result = await run(asUser(user, argv), { timeoutMs: 60_000 });
  if (result.code !== 0) throw failure(result.stderr, fallback);
  return result.stdout;
}

export async function listFiles(user: string, requested?: string): Promise<ListFilesResponse> {
  const home = userHome(user);
  const path = cleanPath(requested || home);
  if (!existsSync(path)) throw new HttpError(404, `${path} does not exist`);
  if (!statSync(path).isDirectory()) throw new HttpError(422, `${path} is not a folder`);
  const out = await asUserOrFail(
    user,
    ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%s\\t%T@\\t%m\\t%u\\t%f\\n'],
    `Cannot read ${path}`,
  );
  return { path, parent: path === '/' ? null : dirname(path), home, entries: parseFindOutput(out) };
}

export async function previewFile(user: string, requested: string): Promise<FilePreview> {
  const path = cleanPath(requested);
  if (!existsSync(path) || !statSync(path).isFile()) throw new HttpError(404, `${path} is not a file`);
  const size = statSync(path).size;
  const mime = IMAGE_TYPES[extname(path).toLowerCase()];
  if (mime) {
    if (size > IMAGE_LIMIT) return { path, size, kind: 'too-large' };
    const base64 = await asUserOrFail(user, ['base64', '-w0', '--', path], `Cannot read ${path}`);
    return { path, size, kind: 'image', dataUrl: `data:${mime};base64,${base64.trim()}` };
  }
  if (size > TEXT_LIMIT) return { path, size, kind: 'too-large' };
  const text = await asUserOrFail(user, ['cat', '--', path], `Cannot read ${path}`);
  return text.includes('\0') ? { path, size, kind: 'binary' } : { path, size, kind: 'text', text };
}

export async function fileOperation(user: string, op: string, request: FileOpRequest): Promise<void> {
  const home = userHome(user);
  const path = requireInsideHome(String(request.path ?? ''), home);
  switch (op) {
    case 'mkdir':
      await asUserOrFail(user, ['mkdir', '--', path], `Cannot create ${path}`);
      return;
    case 'touch':
      // noclobber: never truncates an existing file.
      await asUserOrFail(user, ['bash', '-c', 'set -C; : > "$1"', 'touch', path], `${path} already exists`);
      return;
    case 'rename': {
      const to = requireInsideHome(String(request.to ?? ''), home);
      if (existsSync(to)) throw new HttpError(409, `${to} already exists`);
      await asUserOrFail(user, ['mv', '-n', '-T', '--', path, to], `Cannot rename ${path}`);
      return;
    }
    case 'delete':
      if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) throw new HttpError(404, `${path} does not exist`);
      await asUserOrFail(user, ['rm', '-rf', '--', path], `Cannot delete ${path}`);
      return;
    case 'chmod': {
      const mode = String(request.mode ?? '');
      if (!/^[0-7]{3,4}$/.test(mode)) throw new HttpError(422, 'Mode must be octal, e.g. 755 or 644');
      await asUserOrFail(user, ['chmod', mode, '--', path], `Cannot change ${path}`);
      return;
    }
    default:
      throw new HttpError(404, `Unknown file operation "${op}"`);
  }
}
