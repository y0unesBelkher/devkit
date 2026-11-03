import { randomUUID } from 'node:crypto';
import type { Job } from '@devkit/shared';
import { streamLines } from './exec.ts';

const MAX_OUTPUT_LINES = 2000;
const MAX_JOBS = 20;
// eslint-disable-next-line no-control-regex
const ANSI = /[[0-9;?]*[A-Za-z]/g;

export interface JobContext {
  log(line: string): void;
  /** Runs a program, streaming its output into the job; rejects on a non-zero exit. */
  exec(argv: string[], env?: Record<string, string>, cwd?: string): Promise<void>;
}

export interface JobEvents {
  onJob(job: Job): void;
  onOutput(jobId: string, lines: string[]): void;
}

/** Runs privileged long-running work (apt) strictly one job at a time. */
export class JobQueue {
  private readonly jobs: Job[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly events: JobEvents) {}

  list(): Job[] {
    return [...this.jobs].reverse();
  }

  get(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  enqueue(title: string, work: (ctx: JobContext) => Promise<void>, onSettled?: () => void): Job {
    const job: Job = {
      id: randomUUID(),
      title,
      status: 'queued',
      createdAt: Date.now(),
      finishedAt: null,
      output: [],
      error: null,
    };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.splice(0, this.jobs.length - MAX_JOBS);
    this.events.onJob(job);

    const append = (raw: string[]) => {
      // Some tools force colours (Laravel's composer scripts pass --ansi); the UI shows plain text.
      const lines = raw.map((line) => line.replace(ANSI, ''));
      job.output.push(...lines);
      if (job.output.length > MAX_OUTPUT_LINES) job.output.splice(0, job.output.length - MAX_OUTPUT_LINES);
      this.events.onOutput(job.id, lines);
    };
    const ctx: JobContext = {
      log: (line) => append([line]),
      exec: async (argv, env, cwd) => {
        append([`$ ${argv.join(' ')}`]);
        const code = await streamLines(argv, append, { env, cwd }).exited;
        if (code !== 0) throw new Error(`${argv[0]} exited with code ${code}`);
      },
    };

    this.tail = this.tail.then(async () => {
      job.status = 'running';
      this.events.onJob(job);
      try {
        await work(ctx);
        job.status = 'succeeded';
      } catch (e) {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
        append([`ERROR: ${job.error}`]);
      }
      job.finishedAt = Date.now();
      this.events.onJob(job);
      onSettled?.();
    });
    return job;
  }
}
