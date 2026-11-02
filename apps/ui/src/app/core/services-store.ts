import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { Job, JobsResponse, ServiceAction, ServiceStatus, ServicesResponse } from '@devkit/shared';
import { Daemon } from './daemon';

const MAX_JOB_LINES = 2000;

/** Service states and apt jobs, kept current by daemon events. */
@Injectable({ providedIn: 'root' })
export class ServicesStore {
  private readonly daemon = inject(Daemon);

  readonly services = signal<ServiceStatus[]>([]);
  readonly jobs = signal<Job[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Service id → action currently running (start, stop, …). */
  readonly pending = signal<Record<string, string>>({});
  /** Service id → id of its latest install/uninstall job. */
  readonly jobFor = signal<Record<string, string>>({});

  readonly runningCount = computed(() => this.services().filter((s) => s.active === 'active').length);
  readonly installedCount = computed(() => this.services().filter((s) => s.installed).length);

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      if (event.type === 'services') this.services.set(event.services);
      if (event.type === 'job') this.upsertJob(event.job);
      if (event.type === 'job.output') this.appendJobOutput(event.jobId, event.lines);
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  async load(): Promise<void> {
    this.loading.set(true);
    const [services, jobs] = await Promise.all([
      this.daemon.api<ServicesResponse>({ method: 'GET', path: '/api/services' }),
      this.daemon.api<JobsResponse>({ method: 'GET', path: '/api/jobs' }),
    ]);
    this.loading.set(false);
    if (services.ok) this.services.set(services.data.services);
    else this.error.set(services.error);
    if (jobs.ok) this.jobs.set(jobs.data.jobs);
  }

  job(id: string | undefined): Job | undefined {
    return id ? this.jobs().find((job) => job.id === id) : undefined;
  }

  activeJob(serviceId: string): Job | undefined {
    const job = this.job(this.jobFor()[serviceId]);
    return job && (job.status === 'queued' || job.status === 'running') ? job : undefined;
  }

  async act(service: ServiceStatus, action: ServiceAction): Promise<void> {
    this.error.set(null);
    this.pending.update((p) => ({ ...p, [service.id]: action }));
    const result = await this.daemon.api<ServiceStatus>({ method: 'POST', path: `/api/services/${service.id}/${action}` });
    this.pending.update(({ [service.id]: _, ...rest }) => rest);
    if (result.ok) {
      this.services.update((list) => list.map((s) => (s.id === service.id ? result.data : s)));
    } else {
      this.error.set(`${service.name}: ${result.error}`);
    }
  }

  /** Queues an apt install/uninstall; returns the job id so the caller can show its output. */
  async queue(service: ServiceStatus, action: 'install' | 'uninstall'): Promise<string | null> {
    this.error.set(null);
    const result = await this.daemon.api<Job>({ method: 'POST', path: `/api/services/${service.id}/${action}` });
    if (!result.ok) {
      this.error.set(`${service.name}: ${result.error}`);
      return null;
    }
    this.upsertJob(result.data);
    this.jobFor.update((map) => ({ ...map, [service.id]: result.data.id }));
    return result.data.id;
  }

  /** Starts a job that is not tied to one service (e.g. package repair); returns its id. */
  async startJob(path: string): Promise<string | null> {
    this.error.set(null);
    const result = await this.daemon.api<Job>({ method: 'POST', path });
    if (!result.ok) {
      this.error.set(result.error);
      return null;
    }
    this.upsertJob(result.data);
    return result.data.id;
  }

  private upsertJob(job: Job): void {
    this.jobs.update((jobs) => {
      const index = jobs.findIndex((j) => j.id === job.id);
      if (index === -1) return [job, ...jobs];
      const next = [...jobs];
      next[index] = job;
      return next;
    });
  }

  private appendJobOutput(jobId: string, lines: string[]): void {
    this.jobs.update((jobs) =>
      jobs.map((job) => {
        if (job.id !== jobId) return job;
        const output = [...job.output, ...lines];
        return { ...job, output: output.length > MAX_JOB_LINES ? output.slice(-MAX_JOB_LINES) : output };
      }),
    );
  }
}
