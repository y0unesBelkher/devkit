import { userHome } from './node/fnm.ts';

/**
 * Wraps a command so it runs as the project user with a clean, predictable environment.
 * The root daemon uses this for composer, npm and anything else that writes into the user's files.
 */
export function asUser(user: string, argv: string[], pathPrefix: string[] = []): string[] {
  const path = [...pathPrefix, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return ['runuser', '-u', user, '--', 'env', `HOME=${userHome(user)}`, `USER=${user}`, `PATH=${path}`, 'NO_COLOR=1', ...argv];
}
