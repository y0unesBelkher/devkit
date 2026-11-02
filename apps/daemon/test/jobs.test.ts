import { describe, expect, test } from 'bun:test';
import type { Job } from '@devkit/shared';
import { JobQueue } from '../src/jobs.ts';

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
};

describe('JobQueue', () => {
  test('runs jobs one at a time in order and records failures', async () => {
    const order: string[] = [];
    const statuses: string[] = [];
    const queue = new JobQueue({ onJob: (job: Job) => statuses.push(`${job.title}:${job.status}`), onOutput: () => {} });

    const a = queue.enqueue('a', async (ctx) => {
      order.push('a-start');
      await Bun.sleep(20);
      ctx.log('hello');
      order.push('a-end');
    });
    const b = queue.enqueue('b', async () => {
      order.push('b');
      throw new Error('boom');
    });

    await waitFor(() => b.finishedAt !== null);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(a.status).toBe('succeeded');
    expect(a.output).toEqual(['hello']);
    expect(b.status).toBe('failed');
    expect(b.error).toBe('boom');
    expect(statuses).toEqual(['a:queued', 'b:queued', 'a:running', 'a:succeeded', 'b:running', 'b:failed']);
    expect(queue.list().map((j) => j.title)).toEqual(['b', 'a']);
  });
});
