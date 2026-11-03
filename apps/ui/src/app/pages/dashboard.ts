import { Component, DestroyRef, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ServiceStatus, SystemResources, ToolsInfo } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Icon } from '../components/icon';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';
import { SitesStore, formatBytes } from '../core/sites-store';
import { HEALTH_DOT } from './sites';

const RECOMMENDED = [
  { id: 'nginx', label: 'nginx' },
  { id: 'php', label: 'PHP' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'redis', label: 'Redis' },
];

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, ConsoleView, Icon],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-6xl p-8">
        <div class="flex items-baseline gap-3">
          <h1 class="text-2xl font-semibold">Dashboard</h1>
          @if (daemon.system(); as sys) {
            <span class="text-xs text-zinc-500">devkitd {{ sys.daemon.version }} · {{ sys.distro.name }} · {{ resources()?.cpus ?? '?' }} CPUs</span>
          }
        </div>

        <!-- Daemon not ready -->
        @if (!daemon.inDesktopApp) {
          <p class="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">Open this UI through the DevKit desktop app.</p>
        } @else if (daemon.connection().status !== 'connected') {
          <section class="dk-card mt-6 flex items-center gap-4 p-5">
            <div class="flex-1">
              @switch (daemon.connection().status) {
                @case ('connecting') { <p class="text-zinc-300">Connecting to WSL…</p> }
                @case ('not-installed') { <p class="text-zinc-300">DevKit's service is not installed in WSL yet.</p> }
                @case ('outdated') { <p class="text-amber-300">DevKit's service in WSL is older than this app.</p> }
                @case ('unreachable') { <p class="text-red-300">{{ connectionMessage() }}</p> }
              }
              @if (daemon.installLog(); as log) {
                <pre class="mt-3 max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-400">{{ log }}</pre>
              }
            </div>
            @if (daemon.connection().status !== 'connecting') {
              <button class="dk-btn-primary" [disabled]="daemon.installing()" (click)="daemon.install()">
                {{ daemon.installing() ? 'Installing…' : daemon.connection().status === 'not-installed' ? 'Install' : 'Update / repair' }}
              </button>
            }
          </section>
        }

        @if (daemon.system()?.packagesNeedingRepair; as broken) {
          <section class="mt-6 flex items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
            <p class="flex-1 text-sm text-amber-100">Ubuntu's package system has {{ broken }} half-configured packages from an interrupted upgrade; installs fail until it is repaired.</p>
            <button class="dk-btn-primary" [disabled]="running()" (click)="startJob('/api/system/repair-packages')">Repair</button>
          </section>
        }

        <!-- Setup -->
        @if (missing().length && daemon.connected()) {
          <section class="mt-6 flex items-center gap-4 rounded-xl border border-sky-500/40 bg-sky-500/10 p-4">
            <div class="flex-1 text-sm text-sky-100">
              <div class="font-medium">Finish setting up</div>
              <div class="text-sky-100/80">Missing: {{ missing().join(', ') }}. One click installs everything a Laravel + Angular machine needs (newest PHP with the usual extensions, MySQL, Redis, Composer, Node LTS, Angular CLI); anything already there is skipped.</div>
            </div>
            <button class="dk-btn-primary" [disabled]="running()" (click)="startJob('/api/setup/recommended')">{{ running() ? 'Installing…' : 'Install recommended stack' }}</button>
          </section>
        }

        <!-- Stats -->
        <section class="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="stat">
            <div class="stat-label">Services</div>
            <div class="stat-value">{{ runningServices().length }}<span class="text-base text-zinc-500"> / {{ installedServices().length }}</span></div>
            <div class="stat-hint" [class.text-red-300]="failedServices() > 0">{{ failedServices() ? failedServices() + ' failed' : 'running' }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Sites</div>
            <div class="stat-value">{{ sites.sites().length }}</div>
            <div class="stat-hint">{{ requestsLastHour() }} requests in the last hour</div>
          </div>
          <div class="stat">
            <div class="stat-label">WSL memory</div>
            <div class="stat-value">{{ memoryUsed() }}</div>
            <div class="stat-hint">of {{ bytes(resources()?.memory?.totalBytes) }} · sites use {{ bytes(sitesMemory()) }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Load · disk</div>
            <div class="stat-value">{{ load() }}</div>
            <div class="stat-hint">{{ bytes(resources()?.disk?.freeBytes) }} free in WSL</div>
          </div>
        </section>

        <div class="mt-6 grid gap-6 lg:grid-cols-2">
          <!-- Services -->
          <section class="dk-card overflow-hidden">
            <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <h2 class="text-sm font-medium">Services</h2>
              <div class="flex items-center gap-3">
                <button class="text-xs text-zinc-400 hover:text-white disabled:opacity-40" [disabled]="!runningServices().length" (click)="restartAll()">Restart all</button>
                <a routerLink="/services" class="text-xs text-emerald-300 hover:underline">Manage →</a>
              </div>
            </header>
            @for (s of installedServices(); track s.id) {
              <div class="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2 text-sm last:border-0">
                <span class="size-2 rounded-full" [class]="serviceDot(s)"></span>
                <span class="flex-1">{{ s.name }}</span>
                <span class="font-mono text-xs text-zinc-500">{{ s.version }}</span>
                @if (s.active === 'active') {
                  <button class="icon-btn" title="Stop" [disabled]="!!services.pending()[s.id]" (click)="services.act(s, 'stop')"><app-icon name="stop" [size]="12" /></button>
                } @else {
                  <button class="icon-btn" title="Start" [disabled]="!!services.pending()[s.id]" (click)="services.act(s, 'start')"><app-icon name="play" [size]="12" /></button>
                }
                <button class="icon-btn" title="Restart" [disabled]="!!services.pending()[s.id]" (click)="services.act(s, 'restart')"><app-icon name="restart" [size]="14" /></button>
              </div>
            } @empty {
              <p class="px-4 py-4 text-sm text-zinc-500">Nothing installed yet.</p>
            }
          </section>

          <!-- Sites -->
          <section class="dk-card overflow-hidden">
            <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <h2 class="text-sm font-medium">Sites</h2>
              <a routerLink="/sites" class="text-xs text-emerald-300 hover:underline">All sites →</a>
            </header>
            @for (site of sites.sites(); track site.id) {
              <div class="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2 text-sm last:border-0">
                <span class="size-2 rounded-full" [class]="siteDot(site.id)"></span>
                <a class="flex-1 truncate hover:text-emerald-300" [routerLink]="['/sites', site.id]">{{ site.domain }}</a>
                <span class="w-16 text-right text-xs text-zinc-500">{{ siteMemory(site.id) }}</span>
                <span class="w-16 text-right text-xs text-zinc-500">{{ sites.insightsFor(site.id)?.requests?.lastHour ?? 0 }} req/h</span>
                <button class="icon-btn" title="Open" (click)="sites.openInBrowser(site)"><app-icon name="external" [size]="14" /></button>
              </div>
            } @empty {
              <p class="px-4 py-4 text-sm text-zinc-500">No sites yet. <a routerLink="/sites" class="text-emerald-300 hover:underline">Add one</a>.</p>
            }
          </section>
        </div>
      </div>
    </div>

    @if (job(); as j) {
      <section class="flex h-64 shrink-0 flex-col border-t border-zinc-800 bg-zinc-900">
        <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
          <span class="font-medium">{{ j.title }}</span>
          <span class="text-xs" [class]="j.status === 'failed' ? 'text-red-300' : j.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'">{{ j.status }}</span>
          <span class="flex-1"></span>
          <button class="text-xs text-zinc-400 hover:text-white" (click)="jobId.set(null)">Close</button>
        </header>
        <app-console-view class="flex-1" [lines]="j.output" />
      </section>
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
      font-size: 1.5rem;
      font-weight: 600;
    }
    .stat-hint {
      font-size: 0.6875rem;
      color: var(--color-zinc-500);
    }
    .icon-btn {
      display: inline-grid;
      place-items: center;
      width: 1.625rem;
      height: 1.625rem;
      border-radius: 0.375rem;
      color: var(--color-zinc-400);
    }
    .icon-btn:hover:not(:disabled) {
      background: var(--color-zinc-800);
      color: var(--color-zinc-100);
    }
    .icon-btn:disabled {
      opacity: 0.4;
    }
  `,
})
export class Dashboard implements OnInit {
  protected readonly daemon = inject(Daemon);
  protected readonly services = inject(ServicesStore);
  protected readonly sites = inject(SitesStore);

  protected readonly resources = signal<SystemResources | null>(null);
  private readonly tools = signal<ToolsInfo | null>(null);
  protected readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.services.job(this.jobId() ?? undefined));
  protected readonly running = computed(() => ['queued', 'running'].includes(this.job()?.status ?? ''));
  protected readonly bytes = formatBytes;

  protected readonly installedServices = computed(() => this.services.services().filter((s) => s.installed));
  protected readonly runningServices = computed(() => this.installedServices().filter((s) => s.active === 'active'));
  protected readonly failedServices = computed(() => this.installedServices().filter((s) => s.active === 'failed').length);
  protected readonly sitesMemory = computed(() => this.sites.insights().reduce((sum, i) => sum + i.memoryBytes, 0));
  protected readonly requestsLastHour = computed(() => this.sites.insights().reduce((sum, i) => sum + i.requests.lastHour, 0));
  protected readonly memoryUsed = computed(() => {
    const m = this.resources()?.memory;
    return m ? formatBytes(m.totalBytes - m.availableBytes) : '–';
  });
  protected readonly load = computed(() => {
    const r = this.resources();
    return r ? r.load[0].toFixed(2) : '–';
  });
  protected readonly missing = computed(() => {
    const services = this.services.services();
    if (!services.length) return [];
    const has = (id: string) => services.some((s) => s.installed && (id === 'php' ? s.category === 'php' : s.id === id));
    const missing = RECOMMENDED.filter((r) => !has(r.id)).map((r) => r.label);
    const tools = this.tools();
    if (tools && !tools.composer.installed) missing.push('Composer');
    if (tools && !tools.node.length) missing.push('Node.js');
    return missing;
  });
  protected readonly connectionMessage = computed(() => {
    const c = this.daemon.connection();
    return c.status === 'unreachable' ? c.message : '';
  });

  constructor() {
    const timer = setInterval(() => void this.refreshLive(), 10_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      if (this.daemon.connected()) untracked(() => void this.loadAll());
    });
    effect(() => {
      if (['succeeded', 'failed'].includes(this.job()?.status ?? '')) {
        untracked(() => {
          void this.daemon.refresh();
          void this.loadAll();
        });
      }
    });
  }

  ngOnInit(): void {
    if (this.daemon.connected()) void this.loadAll();
  }

  protected serviceDot(s: ServiceStatus): string {
    if (s.active === 'active') return 'bg-emerald-400';
    if (s.active === 'failed') return 'bg-red-500';
    return s.active === 'activating' || s.active === 'deactivating' ? 'bg-amber-400' : 'bg-zinc-600';
  }

  protected siteDot(id: string): string {
    return HEALTH_DOT[this.sites.health(id)];
  }

  protected siteMemory(id: string): string {
    const bytes = this.sites.insightsFor(id)?.memoryBytes;
    return bytes ? formatBytes(bytes) : '';
  }

  protected async restartAll(): Promise<void> {
    for (const service of this.runningServices()) await this.services.act(service, 'restart');
  }

  protected async startJob(path: string): Promise<void> {
    const id = await this.services.startJob(path);
    if (id) this.jobId.set(id);
  }

  private async loadAll(): Promise<void> {
    const [tools] = await Promise.all([
      this.daemon.api<ToolsInfo>({ method: 'GET', path: '/api/tools' }),
      this.services.load(),
      this.sites.load(),
      this.refreshLive(),
    ]);
    if (tools.ok) this.tools.set(tools.data);
  }

  private async refreshLive(): Promise<void> {
    if (!this.daemon.connected()) return;
    const [resources] = await Promise.all([
      this.daemon.api<SystemResources>({ method: 'GET', path: '/api/system/resources' }),
      this.sites.loadInsights(),
    ]);
    if (resources.ok) this.resources.set(resources.data);
  }
}
