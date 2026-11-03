import { Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { EnvKitImport, EnvKitSite, MigrateRequest, NodeInfo, ServicesResponse } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';

interface Plan {
  site: EnvKitSite;
  target: string;
  phpVersion: string;
  nodeVersion: string;
  reinstallVendor: boolean;
  copyDatabase: boolean;
}

@Component({
  selector: 'app-migrate',
  imports: [FormsModule, ConsoleView],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-5xl p-8">
        <h1 class="text-2xl font-semibold">Migrate from EnvKit</h1>
        <p class="mt-1 text-sm text-zinc-400">
          Copies a project from Windows into WSL, rebuilds its dependencies for Linux, brings its database and queue
          workers along, and serves it under the same .test name. The Windows copy is only read, never changed.
        </p>

        @if (notice(); as n) {
          <p class="mt-4 rounded-lg border p-3 text-sm whitespace-pre-wrap"
            [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'">
            {{ n.message }}
          </p>
        }

        @if (envkit(); as e) {
          @if (!e.found) {
            <p class="mt-6 text-sm text-zinc-400">EnvKit's site list was not found at {{ e.sitesFile }}.</p>
          } @else {
            <p class="mt-6 text-xs text-zinc-500">{{ remaining() }} of {{ e.sites.length }} EnvKit sites still to move · {{ e.sitesFile }}</p>
            <div class="dk-card mt-2 divide-y divide-zinc-800 overflow-hidden">
              @for (site of e.sites; track site.name) {
                <div class="px-4 py-3">
                  <div class="flex items-center gap-3 text-sm">
                    <span class="w-28 shrink-0 font-medium">{{ site.domain }}</span>
                    <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{{ site.type }}</span>
                    <span class="min-w-0 flex-1 truncate text-xs text-zinc-500" [title]="site.windowsRoot">{{ site.windowsRoot }}</span>
                    <span class="shrink-0 text-xs text-zinc-500">{{ extras(site) }}</span>
                    @if (site.migrated; as m) {
                      <a class="shrink-0 text-xs text-emerald-300 hover:underline" [href]="'https://' + site.domain" target="_blank">Migrated</a>
                    } @else if (!site.sourceExists) {
                      <span class="shrink-0 text-xs text-red-300">Folder not found</span>
                    } @else {
                      <button class="dk-btn shrink-0" [disabled]="running() || plan()?.site?.name === site.name" (click)="prepare(site)">Migrate…</button>
                    }
                  </div>

                  @if (plan(); as p) {
                    @if (p.site.name === site.name) {
                      <div class="mt-3 grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm md:grid-cols-2">
                        <label class="text-xs text-zinc-400 md:col-span-2">
                          Copy into (inside WSL)
                          <input class="dk-input mt-1 w-full font-mono" name="target" [(ngModel)]="p.target" autocomplete="off" />
                        </label>
                        @if (p.site.type === 'laravel' || p.site.type === 'php') {
                          <label class="text-xs text-zinc-400">
                            PHP version
                            <select class="dk-input mt-1 w-full" name="php" [(ngModel)]="p.phpVersion">
                              @for (v of phpVersions(); track v) {
                                <option [value]="v">PHP {{ v }}</option>
                              }
                            </select>
                          </label>
                          <label class="flex items-center gap-2 text-sm">
                            <input type="checkbox" class="accent-emerald-500" name="vendor" [(ngModel)]="p.reinstallVendor" />
                            Rebuild vendor/ with composer install
                          </label>
                        }
                        @if (p.site.type === 'angular') {
                          <label class="text-xs text-zinc-400">
                            Node version
                            <select class="dk-input mt-1 w-full" name="node" [(ngModel)]="p.nodeVersion">
                              @for (v of nodeVersions(); track v) {
                                <option [value]="v">Node {{ v }}</option>
                              }
                            </select>
                          </label>
                        }
                        @if (p.site.database) {
                          <label class="flex items-center gap-2 text-sm">
                            <input type="checkbox" class="accent-emerald-500" name="db" [(ngModel)]="p.copyDatabase" />
                            Copy database <span class="font-mono">{{ p.site.database }}</span> from EnvKit's MySQL
                          </label>
                        }
                        <p class="text-xs text-zinc-500 md:col-span-2">
                          node_modules is always reinstalled (Windows builds of native packages don't run on Linux).
                          @if (p.site.queueWorkers.length) { Queue workers: {{ p.site.queueWorkers.length }}. }
                          @if (p.site.group) { Group: {{ p.site.group }}. }
                          After this, the hosts file is updated so {{ p.site.domain }} opens the WSL copy.
                        </p>
                        <div class="flex gap-2 md:col-span-2">
                          <button class="dk-btn-primary" [disabled]="running() || dumping()" (click)="start(p)">
                            {{ dumping() ? 'Dumping database…' : 'Start migration' }}
                          </button>
                          <button class="dk-btn" (click)="plan.set(null)">Cancel</button>
                        </div>
                      </div>
                    }
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    </div>

    @if (job(); as j) {
      <section class="flex h-72 shrink-0 flex-col border-t border-zinc-800 bg-zinc-900">
        <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
          <span class="font-medium">{{ j.title }}</span>
          <span class="text-xs" [class]="j.status === 'failed' ? 'text-red-300' : j.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'">
            {{ j.status }}{{ j.error ? ': ' + j.error : '' }}
          </span>
          <span class="flex-1"></span>
          <button class="text-xs text-zinc-400 hover:text-white" (click)="jobId.set(null)">Close</button>
        </header>
        <app-console-view class="flex-1" [lines]="j.output" />
      </section>
    }
  `,
})
export class Migrate implements OnInit {
  private readonly daemon = inject(Daemon);
  private readonly store = inject(ServicesStore);

  protected readonly envkit = signal<EnvKitImport | null>(null);
  protected readonly plan = signal<Plan | null>(null);
  protected readonly phpVersions = signal<string[]>([]);
  protected readonly nodeVersions = signal<string[]>([]);
  protected readonly notice = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly dumping = signal(false);
  protected readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.store.job(this.jobId() ?? undefined));
  protected readonly running = computed(() => {
    const status = this.job()?.status;
    return status === 'queued' || status === 'running';
  });
  protected readonly remaining = computed(() => this.envkit()?.sites.filter((s) => !s.migrated).length ?? 0);

  constructor() {
    effect(() => {
      const job = this.job();
      if (job?.status !== 'succeeded' && job?.status !== 'failed') return;
      untracked(async () => {
        if (job.status === 'succeeded') {
          this.plan.set(null);
          const hosts = await this.daemon.windows.syncHosts();
          this.notice.set(hosts.ok ? { ok: true, message: `${job.title} finished. ${hosts.message}` } : hosts);
        }
        await this.load();
      });
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected extras(site: EnvKitSite): string {
    const parts: string[] = [];
    if (site.group) parts.push(site.group);
    if (site.database) parts.push(`db ${site.database}`);
    if (site.queueWorkers.length) parts.push(`${site.queueWorkers.length} worker${site.queueWorkers.length > 1 ? 's' : ''}`);
    if (site.devServer) parts.push(`dev :${site.devServer.port}`);
    return parts.join(' · ');
  }

  protected prepare(site: EnvKitSite): void {
    this.notice.set(null);
    this.plan.set({
      site,
      target: site.suggestedTarget,
      phpVersion: this.phpVersions().at(-1) ?? '',
      nodeVersion: this.nodeVersions()[0] ?? '',
      reinstallVendor: true,
      copyDatabase: !!site.database,
    });
  }

  protected async start(p: Plan): Promise<void> {
    this.notice.set(null);
    let databaseDump: string | null = null;
    if (p.copyDatabase && p.site.database) {
      this.dumping.set(true);
      const dump = await this.daemon.windows.dumpEnvKitDatabase(p.site.database);
      this.dumping.set(false);
      if (!dump.ok || !dump.file) return this.notice.set(dump);
      databaseDump = dump.file;
      this.notice.set({ ok: true, message: dump.message });
    }
    const request: MigrateRequest = {
      source: p.site.source,
      target: p.target.trim(),
      domain: p.site.domain,
      type: p.site.type,
      phpVersion: p.site.type === 'laravel' || p.site.type === 'php' ? p.phpVersion : null,
      nodeVersion: p.site.type === 'angular' ? p.nodeVersion : null,
      reinstallVendor: p.reinstallVendor,
      databaseDump,
      queueWorkers: p.site.queueWorkers,
      group: p.site.group,
    };
    const id = await this.store.startJob('/api/migrate', request);
    if (id) this.jobId.set(id);
    else this.notice.set({ ok: false, message: this.store.error() ?? 'Could not start the migration' });
  }

  private async load(): Promise<void> {
    const [envkit, services, node] = await Promise.all([
      this.daemon.api<EnvKitImport>({ method: 'GET', path: '/api/migrate/envkit' }),
      this.daemon.api<ServicesResponse>({ method: 'GET', path: '/api/services' }),
      this.daemon.api<NodeInfo>({ method: 'GET', path: '/api/node' }),
    ]);
    if (envkit.ok) this.envkit.set(envkit.data);
    else this.notice.set({ ok: false, message: envkit.error });
    if (services.ok) {
      this.phpVersions.set(services.data.services.filter((s) => s.category === 'php' && s.installed).map((s) => s.id.replace(/^php/, '')));
    }
    if (node.ok) this.nodeVersions.set(node.data.versions);
  }
}
