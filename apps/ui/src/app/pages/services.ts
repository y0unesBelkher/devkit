import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import type { ActiveState, ServiceCategory, ServiceStatus } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';

const MAX_LOG_LINES = 2000;

const CATEGORIES: { id: ServiceCategory; label: string }[] = [
  { id: 'web', label: 'Web server' },
  { id: 'php', label: 'PHP' },
  { id: 'database', label: 'Databases' },
  { id: 'cache', label: 'Cache & queues' },
];

const STATE_LABELS: Record<ActiveState, { label: string; dot: string }> = {
  active: { label: 'Running', dot: 'bg-emerald-400' },
  inactive: { label: 'Stopped', dot: 'bg-zinc-500' },
  failed: { label: 'Failed', dot: 'bg-red-500' },
  activating: { label: 'Starting…', dot: 'bg-amber-400' },
  deactivating: { label: 'Stopping…', dot: 'bg-amber-400' },
  reloading: { label: 'Reloading…', dot: 'bg-amber-400' },
  missing: { label: 'No unit', dot: 'bg-zinc-600' },
};

type Panel = { kind: 'logs'; serviceId: string; sourceId: string } | { kind: 'job'; serviceId: string; jobId: string };

@Component({
  selector: 'app-services',
  imports: [ConsoleView],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-5xl p-8">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold">Services</h1>
            <p class="mt-1 text-sm text-zinc-400">
              {{ store.runningCount() }} running · {{ store.installedCount() }} of {{ store.services().length }} installed
              @if (!daemon.live()) {
                <span class="ml-2 text-amber-300">· live updates offline</span>
              }
            </p>
          </div>
          <button class="btn" [disabled]="store.loading()" (click)="store.load()">Refresh</button>
        </div>

        @if (store.error(); as error) {
          <div class="mt-4 flex items-start justify-between gap-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            <span class="whitespace-pre-wrap">{{ error }}</span>
            <button class="text-red-300 hover:text-white" (click)="store.error.set(null)">Dismiss</button>
          </div>
        }

        @for (group of groups(); track group.id) {
          <h2 class="mt-8 mb-3 text-xs font-medium tracking-wide text-zinc-500 uppercase">{{ group.label }}</h2>
          <div class="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
            @for (service of group.services; track service.id) {
              <div class="flex items-center gap-4 px-4 py-3" [class.bg-zinc-800/40]="isOpen(service.id)">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">{{ service.name }}</span>
                    @if (service.version) {
                      <span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-400">{{ service.version }}</span>
                    }
                  </div>
                  <div class="truncate text-xs text-zinc-500">{{ service.description }}</div>
                </div>

                @if (store.activeJob(service.id); as job) {
                  <button class="text-sm text-amber-300 hover:underline" (click)="openJob(service, job.id)">
                    {{ job.status === 'queued' ? 'Queued…' : job.title + '…' }}
                  </button>
                } @else if (!service.installed) {
                  <span class="text-sm text-zinc-500">Not installed</span>
                  <button class="btn-primary" (click)="install(service)">Install</button>
                } @else {
                  <div class="flex w-28 items-center gap-2 text-sm">
                    <span class="size-2 rounded-full" [class]="state(service).dot"></span>
                    <span [class.text-red-300]="service.active === 'failed'">{{ state(service).label }}</span>
                  </div>
                  <label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-400" title="Start automatically when WSL boots">
                    <input
                      type="checkbox"
                      class="accent-emerald-500"
                      [checked]="service.enabled"
                      [disabled]="!!store.pending()[service.id]"
                      (change)="store.act(service, service.enabled ? 'disable' : 'enable')"
                    />
                    At boot
                  </label>
                  <div class="flex items-center gap-1">
                    @if (service.active === 'active') {
                      <button class="btn" [disabled]="!!store.pending()[service.id]" (click)="store.act(service, 'stop')">Stop</button>
                    } @else {
                      <button class="btn" [disabled]="!!store.pending()[service.id]" (click)="store.act(service, 'start')">Start</button>
                    }
                    <button class="btn" [disabled]="!!store.pending()[service.id]" (click)="store.act(service, 'restart')">Restart</button>
                    <button class="btn" (click)="openLogs(service)">Logs</button>
                    <button class="btn text-zinc-500 hover:text-red-300" title="Uninstall (data is kept)" (click)="uninstall(service)">✕</button>
                  </div>
                }
              </div>
            }
          </div>
        }
      </div>
    </div>

    @if (panel(); as p) {
      <section class="flex h-80 shrink-0 flex-col border-t border-zinc-800 bg-zinc-900">
        <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
          <span class="font-medium">{{ panelTitle() }}</span>
          @if (p.kind === 'logs') {
            <div class="flex gap-1">
              @for (source of panelService()?.logSources ?? []; track source.id) {
                <button
                  class="rounded px-2 py-0.5 text-xs"
                  [class]="source.id === p.sourceId ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'"
                  (click)="openLogs(panelService()!, source.id)"
                >
                  {{ source.label }}
                </button>
              }
            </div>
          } @else if (panelJob(); as job) {
            <span class="text-xs" [class]="jobStatusClass(job.status)">{{ job.status }}</span>
          }
          <span class="flex-1"></span>
          @if (p.kind === 'logs') {
            <button class="text-xs text-zinc-400 hover:text-white" (click)="logLines.set([])">Clear</button>
          }
          <button class="text-xs text-zinc-400 hover:text-white" (click)="closePanel()">Close</button>
        </header>
        <app-console-view
          class="flex-1"
          [lines]="p.kind === 'logs' ? logLines() : (panelJob()?.output ?? [])"
          [placeholder]="p.kind === 'logs' ? 'Waiting for log lines…' : 'Waiting for the job to start…'"
        />
      </section>
    }
  `,
  styles: `
    .btn {
      border-radius: 0.375rem;
      border: 1px solid var(--color-zinc-700);
      padding: 0.25rem 0.625rem;
      font-size: 0.8125rem;
    }
    .btn:hover:not(:disabled) {
      background: var(--color-zinc-800);
    }
    .btn:disabled {
      opacity: 0.5;
    }
    .btn-primary {
      border-radius: 0.375rem;
      background: var(--color-emerald-500);
      padding: 0.25rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-zinc-950);
    }
    .btn-primary:hover {
      background: var(--color-emerald-400);
    }
  `,
})
export class Services implements OnInit {
  protected readonly daemon = inject(Daemon);
  protected readonly store = inject(ServicesStore);

  protected readonly panel = signal<Panel | null>(null);
  protected readonly logLines = signal<string[]>([]);

  protected readonly groups = computed(() =>
    CATEGORIES.map((c) => ({ ...c, services: this.store.services().filter((s) => s.category === c.id) })).filter(
      (g) => g.services.length > 0,
    ),
  );
  protected readonly panelService = computed(() => {
    const p = this.panel();
    return p ? this.store.services().find((s) => s.id === p.serviceId) : undefined;
  });
  protected readonly panelJob = computed(() => {
    const p = this.panel();
    return p?.kind === 'job' ? this.store.job(p.jobId) : undefined;
  });
  protected readonly panelTitle = computed(() => {
    const p = this.panel();
    if (!p) return '';
    if (p.kind === 'job') return this.panelJob()?.title ?? 'Job';
    return `${this.panelService()?.name ?? p.serviceId} logs`;
  });

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      const p = this.panel();
      if (event.type !== 'log' || p?.kind !== 'logs') return;
      if (event.serviceId !== p.serviceId || event.sourceId !== p.sourceId) return;
      this.logLines.update((lines) => {
        const next = [...lines, ...event.lines];
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      });
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      if (this.panel()?.kind === 'logs') this.daemon.send({ type: 'logs.unsubscribe' });
    });
  }

  ngOnInit(): void {
    void this.store.load();
  }

  protected state(service: ServiceStatus) {
    return STATE_LABELS[service.active];
  }

  protected isOpen(serviceId: string): boolean {
    return this.panel()?.serviceId === serviceId;
  }

  protected openLogs(service: ServiceStatus, sourceId = service.logSources[0]?.id ?? 'journal'): void {
    this.logLines.set([]);
    this.panel.set({ kind: 'logs', serviceId: service.id, sourceId });
    this.daemon.send({ type: 'logs.subscribe', serviceId: service.id, sourceId });
  }

  protected openJob(service: ServiceStatus, jobId: string): void {
    if (this.panel()?.kind === 'logs') this.daemon.send({ type: 'logs.unsubscribe' });
    this.panel.set({ kind: 'job', serviceId: service.id, jobId });
  }

  protected closePanel(): void {
    if (this.panel()?.kind === 'logs') this.daemon.send({ type: 'logs.unsubscribe' });
    this.panel.set(null);
  }

  protected async install(service: ServiceStatus): Promise<void> {
    const jobId = await this.store.queue(service, 'install');
    if (jobId) this.openJob(service, jobId);
  }

  protected async uninstall(service: ServiceStatus): Promise<void> {
    if (!confirm(`Uninstall ${service.name}? Its packages are removed; data and config files are kept.`)) return;
    const jobId = await this.store.queue(service, 'uninstall');
    if (jobId) this.openJob(service, jobId);
  }

  protected jobStatusClass(status: string): string {
    return status === 'failed' ? 'text-red-300' : status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300';
  }
}
