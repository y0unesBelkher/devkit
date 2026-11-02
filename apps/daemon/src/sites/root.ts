import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { HttpError } from '../http-error.ts';

/** Checks a requested project directory; returns its resolved path. */
export function resolveRoot(root: string): string {
  if (!root || !isAbsolute(root)) throw new HttpError(422, 'Root must be an absolute Linux path, e.g. /home/you/projects/app');
  if (root === '/mnt' || root.startsWith('/mnt/')) {
    throw new HttpError(422, 'Projects on /mnt (the Windows drive) are slow in WSL. Move the project into the Linux filesystem first.');
  }
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    throw new HttpError(422, `${root} does not exist`);
  }
  if (!statSync(resolved).isDirectory()) throw new HttpError(422, `${root} is not a directory`);
  return resolved;
}
