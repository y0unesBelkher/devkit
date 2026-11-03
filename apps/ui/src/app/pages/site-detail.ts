import { Component, DestroyRef, OnInit, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type {
  ActiveState,
  ProcessKind,
  ServicesResponse,
  Site,
  SiteEnv,
  SiteLogSource,
  SiteLogSourcesResponse,
  SiteProcess,
} from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Dialogs } from '../components/dialogs';
import { Icon } from '../components/icon';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';
import { SitesStore, formatBytes } from '../core/sites-store';
import { EnvEditor } from '../components/env-editor';
import { HEALTH_DOT, TYPE_LABELS } from './sites';

type Tab = 'overview' | 'logs' | 'env' | 'settings';
const MAX_LOG_LINES = 3000;
const KIND_LABELS: Record<ProcessKind, string> = {
  'ng-serve': 'ng serve',
  queue: 'Queue worker',
  schedule: 'Scheduler',
  horizon: 'Horizon',
  custom: 'Custom command…',
};
const ARTISAN_SHORTCUTS = [
  { label: 'Clear caches', command: 'optimize:clear' },
  { label: 'Migrate', command: 'migrate --force' },
  { label: 'Storage link', command: 'storage:link' },
  { label: 'Restart queues', command: 'queue:restart' },
];

@Component({
  selector: 'app-site-detail',
  imports: [FormsModule, RouterLink, ConsoleView, Icon, EnvEditor],
  host: { class: 'flex h-full flex-col' },
  template: `
    @if (site(); as s) {
      <header class="border-b border-zinc-800 px-8 pt-6">
        <a routerLink="/sites" class="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"><app-icon name="back" [size]="13" /> Sites</a>
        <div class="mt-2 flex items-center gap-3">
          <span class="size-2.5 rounded-full" [class]="healthDot()"></span>
          <h1 class="text-2xl font-semibold">{{ s.domain }}</h1>
          <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{{ labels[s.type] }}</span>
          @if (s.phpVersion) { <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">PHP {{ s.phpVersion }}</span> }
          @if (s.nodeVersion) { <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">Node {{ s.nodeVersion }}</span> }
          @if (group(); as g) { <span class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300">{{ g.name }}</span> }
          <span class="flex-1"></span>
          <button class="dk-btn-primary flex items-center gap-1.5" (click)="sites.openInBrowser(s)"><app-icon name="external" [size]="14" /> Open</button>
          <button class="dk-btn flex items-center gap-1.5" (click)="sites.open('editor', s.root)"><app-icon name="code" [size]="14" /> Editor</button>
          <button class="dk-btn flex items-center gap-1.5" (click)="sites.open('terminal', s.root)"><app-icon name="terminal" [size]="14" /> Terminal</button>
          <button class="dk-btn flex items-center gap-1.5" (click)="sites.open('explorer', s.root)"><app-icon name="folder" [size]="14" /> Explorer</button>
        </div>
        <p class="mt-1 font-mono text-xs text-zinc-500">{{ s.root }}</p>
        <nav class="mt-4 flex gap-1">
          @for (t of tabs(); track t.id) {
            <button class="-mb-px border-b-2 px-3 py-2 text-sm" (click)="setTab(t.id)"
              [class]="tab() === t.id ? 'border-emerald-400 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'">{{ t.label }}</button>
          }
        </nav>
      </header>

      @if (sites.notice(); as n) {
        <div class="flex items-start justify-between gap-4 border-b px-8 py-2 text-sm whitespace-pre-wrap"
          [class]="n.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'">
          <span>{{ n.message }}</span>
          <button class="opacity-70 hover:opacity-100" (click)="sites.notice.set(null)">Dismiss</button>
        </div>
      }

      <div class="min-h-0 flex-1 overflow-y-auto">
        @switch (tab()) {
          @case ('overview') {
            <div class="mx-auto max-w-5xl space-y-6 p-8">
              <!-- Insights -->
              <section class="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div class="stat"><div class="stat-label">Memory</div><div class="stat-value">{{ bytes(insights()?.memoryBytes) }}</div><div class="stat-hint">its processes</div></div>
                <div class="stat"><div class="stat-label">CPU</div><div class="stat-value">{{ cpu() }}</div><div class="stat-hint">its processes</div></div>
                <div class="stat"><div class="stat-label">Requests</div><div class="stat-value">{{ insights()?.requests?.lastHour ?? '–' }}<span class="text-sm text-zinc-500"> /h</span></div>
                  <div class="stat-hint">{{ insights()?.requests?.last24h ?? 0 }} today · <span [class.text-red-300]="(insights()?.requests?.errors24h ?? 0) > 0">{{ insights()?.requests?.errors24h ?? 0 }} errors</span></div></div>
                <div class="stat"><div class="stat-label">Disk</div><div class="stat-value">{{ bytes(insights()?.disk?.bytes) }}</div><div class="stat-hint">project folder</div></div>
                @if (insights()?.fpm; as f) {
                  <div class="stat"><div class="stat-label">PHP {{ f.version }} FPM</div><div class="stat-value">{{ bytes(f.memoryBytes) }}</div><div class="stat-hint">shared pool</div></div>
                } @else {
                  <div class="stat"><div class="stat-label">Served by</div><div class="stat-value text-base">{{ s.type === 'angular' ? 'ng serve' : 'nginx' }}</div><div class="stat-hint">{{ s.port ? 'port ' + s.port : 'static files' }}</div></div>
                }
              </section>

              <!-- Processes -->
              <section class="dk-card overflow-hidden">
                <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
                  <h2 class="text-sm font-medium">Processes</h2>
                  @if (kinds().length) {
                    <div class="flex items-center gap-2">
                      <select #kind class="dk-input">
                        @for (k of kinds(); track k) { <option [value]="k">{{ kindLabels[k] }}</option> }
                      </select>
                      <button class="dk-btn" (click)="addProcess(s, $any(kind.value))">Add</button>
                    </div>
                  }
                </header>
                @for (p of processes(); track p.id) {
                  <div class="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2 text-sm last:border-0">
                    <span class="size-2 shrink-0 rounded-full" [class]="stateDot(p.active)" [title]="p.active"></span>
                    <span class="w-32 shrink-0 truncate">{{ p.name }}</span>
                    <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500" [title]="p.command">{{ p.command }}</span>
                    <span class="w-16 text-right text-xs text-zinc-500">{{ processMemory(p.id) }}</span>
                    <label class="flex items-center gap-1.5 text-xs text-zinc-400" title="Start when WSL boots">
                      <input type="checkbox" class="accent-emerald-500" [checked]="p.autostart" (change)="sites.setAutostart(p, !p.autostart)" /> At boot
                    </label>
                    @if (p.active === 'active' || p.active === 'activating') {
                      <button class="icon-btn" title="Stop" (click)="sites.processAction(p, 'stop')"><app-icon name="stop" [size]="13" /></button>
                    } @else {
                      <button class="icon-btn" title="Start" (click)="sites.processAction(p, 'start')"><app-icon name="play" [size]="13" /></button>
                    }
                    <button class="icon-btn" title="Restart" (click)="sites.processAction(p, 'restart')"><app-icon name="restart" [size]="14" /></button>
                    <button class="icon-btn" title="Logs" (click)="showLogs('process:' + p.id)"><app-icon name="logs" [size]="14" /></button>
                    <button class="icon-btn hover:text-red-300" title="Remove" (click)="removeProcess(p)"><app-icon name="trash" [size]="14" /></button>
                  </div>
                } @empty {
                  <p class="px-4 py-3 text-sm text-zinc-500">
                    {{ s.type === 'laravel' ? 'Nothing running in the background. Add a queue worker, the scheduler or Horizon.' : 'No background processes.' }}
                  </p>
                }
              </section>

              @if (s.type === 'laravel') {
                <section class="dk-card overflow-hidden">
                  <header class="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium">Artisan</header>
                  <div class="flex flex-wrap items-center gap-2 p-4">
                    @for (a of artisanShortcuts; track a.command) {
                      <button class="dk-btn" [disabled]="jobRunning()" (click)="artisan(s, a.command)">{{ a.label }}</button>
                    }
                    <form class="flex min-w-64 flex-1 gap-2" (ngSubmit)="artisan(s, artisanInput)">
                      <span class="self-center font-mono text-xs text-zinc-500">php artisan</span>
                      <input class="dk-input flex-1 font-mono" name="artisan" [(ngModel)]="artisanInput" placeholder="route:list" autocomplete="off" />
                      <button class="dk-btn" type="submit" [disabled]="jobRunning() || !artisanInput.trim()">Run</button>
                    </form>
                  </div>
                  @if (job(); as j) {
                    <div class="flex items-center gap-2 border-t border-zinc-800 px-4 py-1.5 text-xs">
                      <span class="font-mono">{{ j.title }}</span>
                      <span [class]="j.status === 'failed' ? 'text-red-300' : j.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'">{{ j.status }}</span>
                    </div>
                    <app-console-view class="h-56" [lines]="j.output" />
                  }
                </section>
              }

              <section class="dk-card grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm">
                <div class="text-zinc-500">Address</div><div class="font-mono">https://{{ s.domain }}</div>
                <div class="text-zinc-500">Project folder</div><div class="truncate font-mono">{{ s.root }}</div>
                <div class="text-zinc-500">nginx serves</div><div class="truncate font-mono">{{ s.type === 'angular' ? 'proxy to 127.0.0.1:' + s.port : s.docroot }}</div>
                <div class="text-zinc-500">Added</div><div>{{ added() }}</div>
              </section>
            </div>
          }
          @case ('logs') {
            <div class="flex h-full flex-col">
              <div class="flex flex-wrap gap-1 border-b border-zinc-800 px-8 py-2">
                @for (source of logSources(); track source.id) {
                  <button class="rounded px-2.5 py-1 text-xs" (click)="subscribe(source.id)"
                    [class]="source.id === logSource() ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'">{{ source.label }}</button>
                }
                <span class="flex-1"></span>
                <button class="text-xs text-zinc-400 hover:text-white" (click)="logLines.set([])">Clear</button>
              </div>
              <app-console-view class="min-h-0 flex-1" [lines]="logLines()" placeholder="Waiting for log lines…" />
            </div>
          }
          @case ('env') {
            <app-env-editor [site]="s" (saved)="envSaved(s)" />
          }
          @case ('settings') {
            <div class="mx-auto max-w-3xl space-y-6 p-8">
              @if (s.type === 'laravel' || s.type === 'php') {
                <section class="dk-card p-4">
                  <h2 class="text-sm font-medium">PHP version</h2>
                  <p class="mt-1 text-xs text-zinc-500">The site's FPM pool and the php command inside this folder switch together.</p>
                  <select class="dk-input mt-3 w-48" [ngModel]="s.phpVersion" (ngModelChange)="changePhp(s, $event)">
                    @for (v of phpVersions(); track v) { <option [value]="v">PHP {{ v }}</option> }
                  </select>
                </section>
              }
              <section class="dk-card p-4">
                <h2 class="text-sm font-medium">Group</h2>
                <select class="dk-input mt-3 w-64" [ngModel]="group()?.id ?? ''" (ngModelChange)="sites.assign(s.id, $event || null)">
                  <option value="">No group</option>
                  @for (g of sites.groups(); track g.id) { <option [value]="g.id">{{ g.name }}</option> }
                </select>
              </section>
              <section class="dk-card border-red-500/30 p-4">
                <h2 class="text-sm font-medium text-red-300">Remove site</h2>
                <p class="mt-1 text-xs text-zinc-500">Deletes its nginx config, certificate and processes. The project folder and database are not touched.</p>
                <button class="dk-btn dk-btn-danger mt-3" (click)="remove(s)">Remove {{ s.domain }}</button>
              </section>
            </div>
          }
        }
      </div>
    } @else {
      <p class="p-8 text-sm text-zinc-500">Loading…</p>
    }
  `,
  styles: `
    .stat {
      border-radius: 0.75rem;
      border: 1px solid var(--color-zinc-800);
      background: color-mix(in oklab, var(--color-zinc-900) 60%, transparent);
      padding: 0.875rem 1rem;
    }
    .stat-label {
      font-size: 0.75rem;
      color: var(--color-zinc-500);
    }
    .stat-value {
      margin-top: 0.25rem;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .stat-hint {
      font-size: 0.6875rem;
      color: var(--color-zinc-500);
    }
    .icon-btn {
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.375rem;
      color: var(--color-zinc-400);
    }
    .icon-btn:hover {
      background: var(--color-zinc-800);
      color: var(--color-zinc-100);
    }
  `,
})
export class SiteDetail implements OnInit {
  readonly id = input.required<string>();

  protected readonly sites = inject(SitesStore);
  private readonly daemon = inject(Daemon);
  private readonly services = inject(ServicesStore);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);

  protected readonly labels = TYPE_LABELS;
  protected readonly kindLabels = KIND_LABELS;
  protected readonly artisanShortcuts = ARTISAN_SHORTCUTS;
  protected readonly tab = signal<Tab>('overview');
  protected readonly logSources = signal<SiteLogSource[]>([]);
  protected readonly logSource = signal<string | null>(null);
  protected readonly logLines = signal<string[]>([]);
  protected readonly phpVersions = signal<string[]>([]);
  private readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.services.job(this.jobId() ?? undefined));
  protected readonly jobRunning = computed(() => ['queued', 'running'].includes(this.job()?.status ?? ''));
  protected artisanInput = '';

  protected readonly site = computed(() => this.sites.site(this.id()));
  protected readonly group = computed(() => this.sites.groupOf(this.id()));
  protected readonly processes = computed(() => this.sites.processesFor(this.id()));
  protected readonly insights = computed(() => this.sites.insightsFor(this.id()));
  protected readonly healthDot = computed(() => HEALTH_DOT[this.sites.health(this.id())]);
  protected readonly tabs = computed(() => {
    const s = this.site();
    const tabs: { id: Tab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'logs', label: 'Logs' }];
    if (s && s.type !== 'static') tabs.push({ id: 'env', label: 'Environment' });
    tabs.push({ id: 'settings', label: 'Settings' });
    return tabs;
  });
  protected readonly kinds = computed<ProcessKind[]>(() => {
    const s = this.site();
    if (!s) return [];
    const allowed: ProcessKind[] = s.type === 'laravel' ? ['queue', 'schedule', 'horizon', 'custom'] : s.type === 'angular' ? ['ng-serve', 'custom'] : ['custom'];
    const existing = new Set(this.processes().map((p) => p.kind));
    return allowed.filter((k) => k === 'custom' || !existing.has(k));
  });
  protected readonly cpu = computed(() => {
    const value = this.insights()?.cpuPercent;
    return value === null || value === undefined ? '–' : `${value.toFixed(value < 10 ? 1 : 0)}%`;
  });
  protected readonly added = computed(() => new Date(this.site()?.createdAt ?? 0).toLocaleDateString());
  protected readonly bytes = formatBytes;

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      if (event.type === 'site-log' && event.siteId === this.id() && event.sourceId === this.logSource()) {
        this.logLines.update((lines) => [...lines, ...event.lines].slice(-MAX_LOG_LINES));
      }
    });
    const timer = setInterval(() => void this.sites.loadInsights(), 5000);
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      clearInterval(timer);
      if (this.logSource()) this.daemon.send({ type: 'logs.unsubscribe' });
    });
    // A finished artisan command may have changed processes or logs.
    effect(() => {
      if (['succeeded', 'failed'].includes(this.job()?.status ?? '')) untracked(() => void this.sites.load());
    });
  }

  async ngOnInit(): Promise<void> {
    if (!this.sites.sites().length) await this.sites.load();
    else void this.sites.loadInsights();
    const services = await this.daemon.api<ServicesResponse>({ method: 'GET', path: '/api/services' });
    if (services.ok) this.phpVersions.set(services.data.services.filter((s) => s.category === 'php' && s.installed).map((s) => s.id.slice(3)));
  }

  protected setTab(tab: Tab): void {
    if (this.tab() === 'logs' && tab !== 'logs' && this.logSource()) {
      this.daemon.send({ type: 'logs.unsubscribe' });
      this.logSource.set(null);
    }
    this.tab.set(tab);
    if (tab === 'logs') void this.openLogs();
  }

  protected async showLogs(sourceId: string): Promise<void> {
    this.tab.set('logs');
    await this.openLogs(sourceId);
  }

  private async openLogs(preferred?: string): Promise<void> {
    const result = await this.daemon.api<SiteLogSourcesResponse>({ method: 'GET', path: `/api/sites/${this.id()}/logs/sources` });
    if (!result.ok) return;
    this.logSources.set(result.data.sources);
    const first = preferred ?? this.logSource() ?? result.data.sources[0]?.id;
    if (first) this.subscribe(first);
  }

  protected subscribe(sourceId: string): void {
    this.logLines.set([]);
    this.logSource.set(sourceId);
    this.daemon.send({ type: 'site-logs.subscribe', siteId: this.id(), sourceId });
  }

  protected stateDot(state: ActiveState): string {
    if (state === 'active') return 'bg-emerald-400';
    if (state === 'failed') return 'bg-red-500';
    if (state === 'activating' || state === 'deactivating') return 'bg-amber-400';
    return 'bg-zinc-600';
  }

  protected processMemory(id: string): string {
    const usage = this.insights()?.processes.find((p) => p.id === id);
    return usage?.memoryBytes ? formatBytes(usage.memoryBytes) : '';
  }

  protected async addProcess(site: Site, kind: ProcessKind): Promise<void> {
    if (kind !== 'custom') return void this.sites.addProcess(site, { kind });
    const command = await this.dialogs.prompt('Custom command', {
      message: `Runs in ${site.root} as your user, restarted if it stops.`,
      placeholder: 'php artisan reverb:start',
      confirmLabel: 'Next',
    });
    if (!command) return;
    const name = await this.dialogs.prompt('Name', { value: command.split(' ').slice(0, 3).join(' '), confirmLabel: 'Add process' });
    if (name) await this.sites.addProcess(site, { kind, command, name });
  }

  protected async removeProcess(process: SiteProcess): Promise<void> {
    if (confirm(`Stop and remove "${process.name}"?`)) await this.sites.removeProcess(process);
  }

  protected async artisan(site: Site, command: string): Promise<void> {
    if (!command.trim()) return;
    const id = await this.services.startJob(`/api/sites/${site.id}/artisan`, { command });
    if (id) {
      this.jobId.set(id);
      this.artisanInput = '';
    } else this.sites.notice.set({ ok: false, message: this.services.error() ?? 'Could not run the command' });
  }

  protected envSaved(site: Site): void {
    this.sites.notice.set({ ok: true, message: `Saved .env for ${site.domain}.` });
  }

  protected async changePhp(site: Site, phpVersion: string): Promise<void> {
    const result = await this.daemon.api<Site>({ method: 'PATCH', path: `/api/sites/${site.id}`, body: { phpVersion } });
    this.sites.notice.set(result.ok ? { ok: true, message: `${site.domain} now runs PHP ${phpVersion}.` } : { ok: false, message: result.error });
    await this.sites.load();
  }

  protected async remove(site: Site): Promise<void> {
    if (!confirm(`Remove ${site.domain}? Its nginx config, certificate and processes are deleted; the folder and database stay.`)) return;
    const result = await this.daemon.api({ method: 'DELETE', path: `/api/sites/${site.id}` });
    if (!result.ok) return this.sites.notice.set({ ok: false, message: result.error });
    await this.daemon.windows.syncHosts();
    await this.sites.load();
    this.sites.notice.set({ ok: true, message: `${site.domain} was removed.` });
    void this.router.navigate(['/sites']);
  }
}
