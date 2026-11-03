export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}

/** Runs a program to completion (no shell) and collects its output. */
export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
  });
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

export interface LineStream {
  /** Resolves with the exit code once both output streams are drained. */
  exited: Promise<number>;
  stop(): void;
}

/** Spawns a program and delivers stdout and stderr to `onLines` as complete lines, batched per chunk. */
export function streamLines(argv: string[], onLines: (lines: string[]) => void, options: RunOptions = {}): LineStream {
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
  });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of stream) {
      const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = parts.pop() ?? '';
      // apt redraws progress with \r; keep only the final state of each line.
      const lines = parts.map((line) => line.slice(line.lastIndexOf('\r') + 1));
      if (lines.length) onLines(lines);
    }
    if (rest) onLines([rest]);
  };

  const exited = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => proc.exited);
  return { exited, stop: () => proc.kill() };
}
