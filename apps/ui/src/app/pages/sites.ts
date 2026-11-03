import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SITE_TLD,
  validateDomain,
  type ActionResult,
  type ActiveState,
  type CreateProcessRequest,
  type CreateSiteRequest,
  type CreateSiteResponse,
  type DetectResult,
  type ListenMode,
  type ProcessAction,
  type ProcessKind,
  type ProcessesResponse,
  type ServicesResponse,
  type Site,
  type SiteProcess,
  type SiteType,
  type SitesResponse,
  type WindowsStatus,
} from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { FolderPicker } from '../components/folder-picker';
import { Daemon } from '../core/daemon';

const MAX_LOG_LINES = 2000;

type Busy = null | 'load' | 'detect' | 'create' | 'update' | 'delete' | 'trust' | 'hosts' | 'mode';

@Component({
  selector: 'app-sites',
  imports: [FormsModule, ConsoleView, FolderPicker],
  template: `
    <div class="mx-auto max-w-5xl p-8">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold">Sites</h1>
          <p class="mt-1 text-sm text-zinc-400">Each site gets a .{{ tld }} domain, its own certificate and an nginx config.</p>
        </div>
        <button class="btn" [disabled]="busy() !== null" (click)="load()">Refresh</button>
      </div>

      @if (notice(); as n) {
        <div
          class="mt-4 flex items-start justify-between gap-4 rounded-lg border p-3 text-sm whitespace-pre-wrap"
          [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'"
        >
          <span>{{ n.message }}</span>
          <button class="opacity-70 hover:opacity-100" (click)="notice.set(null)">Dismiss</button>
        </div>
      }

      <!-- Windows integration -->
      @if (status(); as s) {
        <section class="mt-6 grid gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 md:grid-cols-3">
          <div class="bg-zinc-900 p-4">
            <div class="text-xs text-zinc-500">Certificate authority</div>
            @if (s.ca?.trusted) {
              <div class="mt-1 font-medium text-emerald-300">Trusted by Windows</div>
            } @else {
              <div class="mt-1 font-medium text-amber-300">Not trusted yet</div>
              <p class="mt-1 text-xs text-zinc-400">Browsers will warn until Windows trusts DevKit's CA.</p>
              <button class="btn-primary mt-3" [disabled]="busy() !== null" (click)="trustCa()">
                {{ busy() === 'trust' ? 'Waiting for Windows…' : 'Trust certificate' }}
              </button>
            }
          </div>
          <div class="bg-zinc-900 p-4">
            <div class="text-xs text-zinc-500">Windows hosts file</div>
            @if (s.hosts.inSync) {
              <div class="mt-1 font-medium text-emerald-300">Up to date</div>
            } @else {
              <div class="mt-1 font-medium text-amber-300">Needs update</div>
              <p class="mt-1 text-xs text-zinc-400">Windows asks for administrator approval.</p>
              <button class="btn-primary mt-3" [disabled]="busy() !== null" (click)="syncHosts()">
                {{ busy() === 'hosts' ? 'Waiting for approval…' : 'Update hosts file' }}
              </button>
            }
            @if (s.hosts.conflicts.length) {
              <p class="mt-2 text-xs text-amber-300">
                Also listed by EnvKit or Herd; DevKit switched those lines off while it serves them: {{ s.hosts.conflicts.join(', ') }}
              </p>
            }
          </div>
          <div class="bg-zinc-900 p-4">
            <div class="text-xs text-zinc-500">Sites are served on</div>
            <div class="mt-1 font-mono text-sm font-medium">{{ s.network.hostsTarget ?? 'unknown' }}</div>
            <p class="mt-1 text-xs text-zinc-400">
              @if (s.network.mode === 'wsl-ip') {
                WSL's own IP, so another stack can keep 127.0.0.1.
              } @else {
                127.0.0.1, forwarded into WSL.
              }
              @if (s.portOwners.length) {
                {{ owners(s) }} on Windows.
              }
            </p>
            @if (s.network.mode !== s.recommendedMode || s.network.mode === 'localhost') {
              <button class="btn mt-3" [disabled]="busy() !== null" (click)="switchMode(other(s.network.mode))">
                Switch to {{ other(s.network.mode) === 'localhost' ? '127.0.0.1' : 'WSL IP' }}
              </button>
            }
          </div>
        </section>
      } @else if (statusError(); as error) {
        <p class="mt-6 text-sm text-red-300">Could not read the Windows status: {{ error }}</p>
      }

      <!-- Add site -->
      <section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <h2 class="text-sm font-medium">Add a site</h2>
        <form class="mt-3 flex gap-3" (ngSubmit)="detect()">
          <label class="flex-1 text-xs text-zinc-400">
            Project folder (inside WSL)
            <input class="input mt-1 font-mono" name="root" [(ngModel)]="root" placeholder="/home/you/projects/lv-oms" autocomplete="off" />
          </label>
          <div class="flex items-end gap-2">
            <button class="btn h-9 px-4" type="button" (click)="picking.set(true)">Browse…</button>
            <button class="btn h-9 px-4" type="submit" [disabled]="busy() !== null || !root.trim()">
              {{ busy() === 'detect' ? 'Detecting…' : 'Detect' }}
            </button>
          </div>
        </form>
        @if (picking()) {
          <app-folder-picker [start]="root.trim() || undefined" (chosen)="pickedRoot($event)" (cancelled)="picking.set(false)" />
        }

        @if (detected(); as d) {
          <form class="mt-4 border-t border-zinc-800 pt-4" (ngSubmit)="create()">
            <p class="text-sm">
              Looks like a <span class="font-medium text-emerald-300">{{ typeLabels[d.type] }}</span> project
              <span class="font-mono text-xs text-zinc-500">({{ d.root }})</span>
            </p>
            @for (warning of d.warnings; track warning) {
              <p class="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{{ warning }}</p>
            }

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="text-xs text-zinc-400">
                Domain
                <input class="input mt-1" name="domain" [(ngModel)]="domain" autocomplete="off" />
              </label>
              <label class="text-xs text-zinc-400">
                Type
                <select class="input mt-1" name="type" [(ngModel)]="type">
                  <option value="laravel">Laravel</option>
                  <option value="angular">Angular</option>
                  <option value="php">PHP</option>
                  <option value="static">Static</option>
                </select>
              </label>
              @if (type === 'php' || type === 'laravel') {
                <label class="text-xs text-zinc-400">
                  PHP version{{ d.phpConstraint ? ' (composer: ' + d.phpConstraint + ')' : '' }}
                  <select class="input mt-1" name="php" [(ngModel)]="phpVersion">
                    @for (v of d.installedPhpVersions; track v) {
                      <option [value]="v">PHP {{ v }}</option>
                    } @empty {
                      <option value="" disabled>No PHP installed</option>
                    }
                  </select>
                </label>
              } @else if (type === 'angular') {
                <label class="text-xs text-zinc-400">
                  Node version{{ d.nodeRequirement ? ' (project: ' + d.nodeRequirement + ')' : '' }}
                  <select class="input mt-1" name="node" [(ngModel)]="nodeVersion">
                    @for (v of d.installedNodeVersions; track v) {
                      <option [value]="v">Node {{ v }}</option>
                    } @empty {
                      <option value="" disabled>No Node installed</option>
                    }
                  </select>
                </label>
              }
            </div>
            <p class="mt-2 font-mono text-xs text-zinc-500">
              @if (type === 'angular') {
                nginx proxies to ng serve, which DevKit runs and restarts for you
              } @else {
                nginx serves {{ type === 'static' ? d.root : d.docroot }}
              }
            </p>

            @if (type === 'laravel' && d.database; as db) {
              <label class="mt-3 flex items-center gap-2 text-sm" [class.opacity-50]="!d.mysqlInstalled">
                <input type="checkbox" class="accent-emerald-500" name="createDb" [(ngModel)]="createDatabase" [disabled]="!d.mysqlInstalled" />
                Create MySQL database <span class="font-mono">{{ db.name }}</span> for user
                <span class="font-mono">{{ db.username }}</span>{{ db.hasPassword ? '' : ' (no password)' }}
              </label>
            }

            <button class="btn-primary mt-4 h-9 px-4" type="submit" [disabled]="busy() !== null || !canCreate()">
              {{ busy() === 'create' ? 'Creating…' : 'Create ' + domain }}
            </button>
          </form>
        }
      </section>

      <!-- Site list -->
      <div class="mt-6 divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
        @for (site of sites(); track site.id) {
          <div>
          <div class="flex items-center gap-4 px-4 py-3">
            <div class="min-w-0 flex-1">
              <a class="font-medium text-emerald-300 hover:underline" [href]="'https://' + site.domain" target="_blank">
                https://{{ site.domain }}
              </a>
              <div class="truncate font-mono text-xs text-zinc-500">{{ site.root }}</div>
            </div>
            <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{{ typeLabels[site.type] }}</span>
            @if (site.nodeVersion) {
              <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400" title="Dev server port {{ site.port }}">Node {{ site.nodeVersion }}</span>
            }
            @if (site.phpVersion) {
              <select
                class="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                title="PHP version"
                [disabled]="busy() !== null"
                [value]="site.phpVersion"
                (change)="changePhp(site, $any($event.target).value)"
              >
                @for (v of phpVersions(); track v) {
                  <option [value]="v">PHP {{ v }}</option>
                }
              </select>
            }
            <button class="btn text-zinc-400 hover:text-red-300" [disabled]="busy() !== null" (click)="remove(site)">Remove</button>
          </div>

          <!-- Processes -->
          @if (processesFor(site.id).length || kindsFor(site).length) {
            <div class="border-t border-zinc-800/60 bg-zinc-950/40 px-4 py-2">
              @for (p of processesFor(site.id); track p.id) {
                <div class="flex items-center gap-3 py-1.5 text-sm">
                  <span class="size-2 shrink-0 rounded-full" [class]="stateDot(p.active)" [title]="p.active"></span>
                  <span class="w-28 shrink-0 truncate">{{ p.name }}</span>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500" [title]="p.command">{{ p.command }}</span>
                  <label class="flex items-center gap-1.5 text-xs text-zinc-400" title="Start when WSL boots">
                    <input type="checkbox" class="accent-emerald-500" [checked]="p.autostart" [disabled]="busy() !== null"
                      (change)="setAutostart(p, !p.autostart)" />
                    At boot
                  </label>
                  @if (p.active === 'active' || p.active === 'activating') {
                    <button class="btn" [disabled]="busy() !== null" (click)="processAction(p, 'stop')">Stop</button>
                  } @else {
                    <button class="btn" [disabled]="busy() !== null" (click)="processAction(p, 'start')">Start</button>
                  }
                  <button class="btn" [disabled]="busy() !== null" (click)="processAction(p, 'restart')">Restart</button>
                  <button class="btn" [class.bg-zinc-800]="logProcess() === p.id" (click)="toggleLogs(p)">Logs</button>
                  <button class="btn text-zinc-500 hover:text-red-300" title="Remove process" [disabled]="busy() !== null" (click)="removeProcess(p)">✕</button>
                </div>
                @if (logProcess() === p.id) {
                  <app-console-view class="mb-2 h-64 overflow-hidden rounded-md border border-zinc-800" [lines]="logLines()"
                    placeholder="Waiting for output…" />
                }
              }
              @if (kindsFor(site).length) {
                <div class="flex items-center gap-2 py-1.5">
                  <select #kind class="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs">
                    @for (k of kindsFor(site); track k) {
                      <option [value]="k">{{ kindLabels[k] }}</option>
                    }
                  </select>
                  <button class="btn" [disabled]="busy() !== null" (click)="addProcess(site, $any(kind.value))">Add process</button>
                </div>
              }
            </div>
          }
          </div>
        } @empty {
          <p class="px-4 py-6 text-center text-sm text-zinc-500">No sites yet.</p>
        }
      </div>
    </div>
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
    .btn-primary {
      border-radius: 0.375rem;
      background: var(--color-emerald-500);
      padding: 0.25rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-zinc-950);
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--color-emerald-400);
    }
    .btn:disabled,
    .btn-primary:disabled {
      opacity: 0.5;
    }
    .input {
      display: block;
      width: 100%;
      height: 2.25rem;
      border-radius: 0.375rem;
      border: 1px solid var(--color-zinc-700);
      background: var(--color-zinc-950);
      padding: 0 0.625rem;
      font-size: 0.875rem;
      color: var(--color-zinc-100);
    }
    .input:focus {
      outline: 2px solid var(--color-emerald-500);
      outline-offset: -1px;
    }
  `,
})
export class Sites implements OnInit {
  private readonly daemon = inject(Daemon);

  protected readonly tld = SITE_TLD;
  protected readonly sites = signal<Site[]>([]);
  protected readonly status = signal<WindowsStatus | null>(null);
  protected readonly statusError = signal<string | null>(null);
  protected readonly busy = signal<Busy>(null);
  protected readonly notice = signal<ActionResult | null>(null);
  protected readonly detected = signal<DetectResult | null>(null);
  protected readonly phpVersions = signal<string[]>([]);
  protected readonly processes = signal<SiteProcess[]>([]);
  protected readonly logProcess = signal<string | null>(null);
  protected readonly picking = signal(false);
  protected readonly logLines = signal<string[]>([]);
  protected readonly typeLabels: Record<SiteType, string> = {
    laravel: 'Laravel',
    php: 'PHP',
    static: 'Static',
    angular: 'Angular',
  };
  protected readonly kindLabels: Record<ProcessKind, string> = {
    'ng-serve': 'ng serve',
    queue: 'Queue worker',
    schedule: 'Scheduler',
    horizon: 'Horizon',
    custom: 'Custom command…',
  };
  protected root = '';
  protected domain = '';
  protected type: SiteType = 'static';
  protected phpVersion = '';
  protected nodeVersion = '';
  protected createDatabase = true;

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      if (event.type === 'processes') this.processes.set(event.processes);
      if (event.type === 'process-log' && event.processId === this.logProcess()) {
        this.logLines.update((lines) => [...lines, ...event.lines].slice(-MAX_LOG_LINES));
      }
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      if (this.logProcess()) this.daemon.send({ type: 'logs.unsubscribe' });
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    await this.run('load', async () => {
      await Promise.all([this.loadSites(), this.loadStatus(), this.loadPhpVersions(), this.loadProcesses()]);
    });
  }

  protected pickedRoot(path: string): void {
    this.picking.set(false);
    this.root = path;
    void this.detect();
  }

  protected canCreate(): boolean {
    if (this.type === 'php' || this.type === 'laravel') return !!this.phpVersion;
    if (this.type === 'angular') return !!this.nodeVersion;
    return true;
  }

  protected processesFor(siteId: string): SiteProcess[] {
    return this.processes().filter((p) => p.siteId === siteId);
  }

  /** Process kinds that can still be added (one of each built-in kind; custom any number of times). */
  protected kindsFor(site: Site): ProcessKind[] {
    const allowed: ProcessKind[] =
      site.type === 'laravel' ? ['queue', 'schedule', 'horizon', 'custom'] : site.type === 'angular' ? ['ng-serve', 'custom'] : ['custom'];
    const existing = new Set(this.processesFor(site.id).map((p) => p.kind));
    return allowed.filter((kind) => kind === 'custom' || !existing.has(kind));
  }

  protected stateDot(state: ActiveState): string {
    if (state === 'active') return 'bg-emerald-400';
    if (state === 'failed') return 'bg-red-500';
    if (state === 'activating' || state === 'deactivating' || state === 'reloading') return 'bg-amber-400';
    return 'bg-zinc-600';
  }

  protected async addProcess(site: Site, kind: ProcessKind): Promise<void> {
    const request: CreateProcessRequest = { kind };
    if (kind === 'custom') {
      const command = prompt(`Command to run in ${site.root} (e.g. php artisan reverb:start):`)?.trim();
      if (!command) return;
      const name = prompt('Short name for it:', command.split(' ').slice(0, 3).join(' '))?.trim();
      if (!name) return;
      Object.assign(request, { command, name });
    }
    await this.run('update', async () => {
      const result = await this.daemon.api<SiteProcess>({ method: 'POST', path: `/api/sites/${site.id}/processes`, body: request });
      this.notice.set(result.ok ? { ok: true, message: `${result.data.name} started for ${site.domain}.` } : { ok: false, message: result.error });
      await this.loadProcesses();
    });
  }

  protected async processAction(p: SiteProcess, action: ProcessAction): Promise<void> {
    await this.run('update', async () => {
      const result = await this.daemon.api<SiteProcess>({ method: 'POST', path: `/api/processes/${p.id}/${action}` });
      if (!result.ok) this.notice.set({ ok: false, message: `${p.name}: ${result.error}` });
      await this.loadProcesses();
    });
  }

  protected async setAutostart(p: SiteProcess, autostart: boolean): Promise<void> {
    await this.run('update', async () => {
      const result = await this.daemon.api<SiteProcess>({ method: 'PATCH', path: `/api/processes/${p.id}`, body: { autostart } });
      if (!result.ok) this.notice.set({ ok: false, message: `${p.name}: ${result.error}` });
      await this.loadProcesses();
    });
  }

  protected async removeProcess(p: SiteProcess): Promise<void> {
    if (!confirm(`Stop and remove "${p.name}"?`)) return;
    if (this.logProcess() === p.id) this.toggleLogs(p);
    await this.run('update', async () => {
      const result = await this.daemon.api({ method: 'DELETE', path: `/api/processes/${p.id}` });
      if (!result.ok) this.notice.set({ ok: false, message: result.error });
      await this.loadProcesses();
    });
  }

  protected toggleLogs(p: SiteProcess): void {
    this.logLines.set([]);
    if (this.logProcess() === p.id) {
      this.logProcess.set(null);
      this.daemon.send({ type: 'logs.unsubscribe' });
    } else {
      this.logProcess.set(p.id);
      this.daemon.send({ type: 'process-logs.subscribe', processId: p.id });
    }
  }

  protected async detect(): Promise<void> {
    await this.run('detect', async () => {
      this.detected.set(null);
      const result = await this.daemon.api<DetectResult>({ method: 'POST', path: '/api/sites/detect', body: { root: this.root.trim() } });
      if (!result.ok) {
        this.notice.set({ ok: false, message: result.error });
        return;
      }
      const d = result.data;
      this.root = d.root;
      this.domain = d.domain;
      this.type = d.type;
      this.phpVersion = d.phpVersion ?? d.installedPhpVersions.at(-1) ?? '';
      this.nodeVersion = d.nodeVersion ?? d.installedNodeVersions[0] ?? '';
      this.createDatabase = d.mysqlInstalled;
      this.detected.set(d);
    });
  }

  protected async changePhp(site: Site, phpVersion: string): Promise<void> {
    await this.run('update', async () => {
      const result = await this.daemon.api<Site>({ method: 'PATCH', path: `/api/sites/${site.id}`, body: { phpVersion } });
      this.notice.set(result.ok ? { ok: true, message: `${site.domain} now runs PHP ${phpVersion}.` } : { ok: false, message: result.error });
      await this.loadSites();
    });
  }

  protected owners(s: WindowsStatus): string {
    const byProcess = new Map<string, number[]>();
    for (const o of s.portOwners) byProcess.set(o.process, [...(byProcess.get(o.process) ?? []), o.port]);
    return [...byProcess].map(([name, ports]) => `${name}.exe holds port ${ports.join(' and ')}`).join('; ');
  }

  protected other(mode: ListenMode): ListenMode {
    return mode === 'wsl-ip' ? 'localhost' : 'wsl-ip';
  }

  protected async create(): Promise<void> {
    const domain = this.domain.trim().toLowerCase();
    const error = validateDomain(domain);
    if (error) {
      this.notice.set({ ok: false, message: error });
      return;
    }
    const request: CreateSiteRequest = {
      domain,
      root: this.root.trim(),
      type: this.type,
      phpVersion: this.type === 'php' || this.type === 'laravel' ? this.phpVersion : null,
      nodeVersion: this.type === 'angular' ? this.nodeVersion : null,
      createDatabase: this.type === 'laravel' && this.createDatabase,
    };
    await this.run('create', async () => {
      const result = await this.daemon.api<CreateSiteResponse>({ method: 'POST', path: '/api/sites', body: request });
      if (!result.ok) {
        this.notice.set({ ok: false, message: result.error });
        return;
      }
      this.detected.set(null);
      this.domain = '';
      this.root = '';
      await this.loadSites();
      const hosts = await this.daemon.windows.syncHosts();
      const notes = result.data.notes.length ? `\n${result.data.notes.join('\n')}` : '';
      this.notice.set(
        hosts.ok
          ? { ok: true, message: `https://${domain} is ready.${notes}` }
          : { ok: false, message: `${domain} was created, but ${hosts.message}${notes}` },
      );
      await this.loadStatus();
    });
  }

  protected async remove(site: Site): Promise<void> {
    if (!confirm(`Remove ${site.domain}? Its nginx config and certificate are deleted; the folder is not touched.`)) return;
    await this.run('delete', async () => {
      const result = await this.daemon.api({ method: 'DELETE', path: `/api/sites/${site.id}` });
      if (!result.ok) {
        this.notice.set({ ok: false, message: result.error });
        return;
      }
      await this.loadSites();
      const hosts = await this.daemon.windows.syncHosts();
      this.notice.set(hosts.ok ? { ok: true, message: `${site.domain} removed.` } : hosts);
      await this.loadStatus();
    });
  }

  protected trustCa(): Promise<void> {
    return this.windowsAction('trust', () => this.daemon.windows.trustCa());
  }

  protected syncHosts(): Promise<void> {
    return this.windowsAction('hosts', () => this.daemon.windows.syncHosts());
  }

  protected switchMode(mode: ListenMode): Promise<void> {
    return this.windowsAction('mode', () => this.daemon.windows.setListenMode(mode));
  }

  private async windowsAction(busy: Busy, action: () => Promise<ActionResult>): Promise<void> {
    await this.run(busy, async () => {
      this.notice.set(await action());
      await this.loadStatus();
    });
  }

  private async loadSites(): Promise<void> {
    const result = await this.daemon.api<SitesResponse>({ method: 'GET', path: '/api/sites' });
    if (result.ok) this.sites.set(result.data.sites);
    else this.notice.set({ ok: false, message: result.error });
  }

  private async loadProcesses(): Promise<void> {
    const result = await this.daemon.api<ProcessesResponse>({ method: 'GET', path: '/api/processes' });
    if (result.ok) this.processes.set(result.data.processes);
  }

  private async loadPhpVersions(): Promise<void> {
    const result = await this.daemon.api<ServicesResponse>({ method: 'GET', path: '/api/services' });
    if (!result.ok) return;
    this.phpVersions.set(
      result.data.services.filter((s) => s.category === 'php' && s.installed).map((s) => s.id.replace(/^php/, '')),
    );
  }

  private async loadStatus(): Promise<void> {
    if (!this.daemon.inDesktopApp) return;
    try {
      this.status.set(await this.daemon.windows.windowsStatus());
      this.statusError.set(null);
    } catch (e) {
      this.statusError.set(e instanceof Error ? e.message : String(e));
    }
  }

  private async run(busy: Busy, work: () => Promise<void>): Promise<void> {
    this.busy.set(busy);
    try {
      await work();
    } catch (e) {
      this.notice.set({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy.set(null);
    }
  }
}
