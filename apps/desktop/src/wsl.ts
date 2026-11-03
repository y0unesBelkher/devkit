import { spawn } from 'node:child_process';

/** WSL distro DevKit manages. */
export const DISTRO = process.env['DEVKIT_DISTRO'] ?? 'Ubuntu';

export interface WslResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WslOptions {
  user?: string;
  input?: string;
  timeoutMs?: number;
}

/**
 * Runs a program inside the distro. `-e` executes it directly instead of through a shell,
 * so arguments (e.g. Windows paths with backslashes) arrive untouched.
 * WSL_UTF8 stops wsl.exe from printing its own messages as UTF-16.
 */
export function wsl(args: string[], options: WslOptions = {}): Promise<WslResult> {
  const argv = ['-d', DISTRO, ...(options.user ? ['-u', options.user] : []), '-e', ...args];
  return run('wsl.exe', argv, options);
}

export async function listDistros(): Promise<string[]> {
  const result = await run('wsl.exe', ['-l', '-q'], { timeoutMs: 15_000 });
  return result.stdout
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** UNC path Windows uses for a file inside the distro: /home/u/app → \\wsl.localhost\Ubuntu\home\u\app */
export function toWslUnc(linuxPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${linuxPath.replace(/\//g, '\\')}`;
}

/** Quotes a value for a POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, argv: string[], options: WslOptions): Promise<WslResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${argv.join(' ')} timed out`));
    }, options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
