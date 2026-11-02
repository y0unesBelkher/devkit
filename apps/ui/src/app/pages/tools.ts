import { Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PhpExtension, PhpToolInfo, ToolUpdates, ToolsInfo } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';

@Component({
  selector: 'app-tools',
  imports: [FormsModule, ConsoleView],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-5xl p-8">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold">Tools</h1>
            <p class="mt-1 text-sm text-zinc-400">PHP extensions, Composer and Node.js for your projects.</p>
          </div>
          <div class="flex gap-2">
            <button class="btn" [disabled]="running()" (click)="startJob('/api/tools/updates/check')">Check for updates</button>
            <button class="btn" [disabled]="running()" (click)="startJob('/api/tools/health')">Run health check</button>
          </div>
        </div>

        @if (message(); as m) {
          <p class="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{{ m }}</p>
        }

        <!-- Updates -->
        @if (updates(); as u) {
          @if (u.apt.length || u.composer || npmUpdateCount(u)) {
            <section class="mt-6 rounded-xl border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
              <h2 class="font-medium text-sky-200">Updates available</h2>
              @if (u.apt.length) {
                <div class="mt-2 flex items-center justify-between gap-4">
                  <span class="text-sky-100/80">
                    {{ u.apt.length }} packages: {{ aptSummary(u) }}
                  </span>
                  <button class="btn-primary" [disabled]="running()" (click)="startJob('/api/tools/updates/apply', { target: 'apt' })">Upgrade</button>
                </div>
              }
              @if (u.composer; as c) {
                <div class="mt-2 flex items-center justify-between gap-4">
                  <span class="text-sky-100/80">Composer {{ c.current }} → {{ c.latest }}</span>
                  <button class="btn-primary" [disabled]="running()" (click)="startJob('/api/tools/updates/apply', { target: 'composer' })">Update</button>
                </div>
              }
              @for (entry of npmUpdates(u); track entry.version) {
                <div class="mt-2 flex items-center justify-between gap-4">
                  <span class="text-sky-100/80">
                    Node {{ entry.version }}: {{ entry.list }}
                  </span>
                  <button class="btn-primary" [disabled]="running()"
                    (click)="startJob('/api/tools/updates/apply', { target: 'npm', nodeVersion: entry.version })">Update</button>
                </div>
              }
            </section>
          } @else {
            <p class="mt-4 text-xs text-zinc-500">Everything DevKit manages is up to date (checked {{ checkedAt(u) }}).</p>
          }
        }

        <!-- PHP -->
        <h2 class="mt-8 mb-3 text-xs font-medium tracking-wide text-zinc-500 uppercase">PHP extensions</h2>
        @for (php of tools()?.php ?? []; track php.version) {
          <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div class="flex items-baseline gap-2">
              <h3 class="font-medium">PHP {{ php.version }}</h3>
              <span class="font-mono text-xs text-zinc-500">{{ php.release }}</span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
              @for (ext of php.extensions; track ext.name) {
                <div class="flex items-center gap-2 py-0.5 text-sm">
                  <span class="size-2 shrink-0 rounded-full" [class]="extDot(ext)"></span>
                  <span class="flex-1" [class.text-zinc-500]="!ext.installed">{{ ext.name }}</span>
                  @if (ext.builtin) {
                    <span class="text-xs text-zinc-600">built in</span>
                  } @else if (!ext.installed) {
                    <button class="link" [disabled]="running()" (click)="extension(php, ext, 'install')">install</button>
                  } @else {
                    @if (ext.toggleable) {
                      <button class="link" [disabled]="busy()" (click)="extension(php, ext, ext.enabled ? 'disable' : 'enable')">
                        {{ ext.enabled ? 'turn off' : 'turn on' }}
                      </button>
                    }
                    <button class="link remove" title="Uninstall" [disabled]="running()" (click)="extension(php, ext, 'uninstall')">✕</button>
                  }
                </div>
              }
            </div>
          </section>
        } @empty {
          <p class="text-sm text-zinc-500">No PHP version installed yet (Services page).</p>
        }

        <!-- Composer -->
        <h2 class="mt-8 mb-3 text-xs font-medium tracking-wide text-zinc-500 uppercase">Composer</h2>
        <section class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div>
            @if (tools()?.composer?.installed) {
              <div class="font-medium">Composer {{ tools()?.composer?.version }}</div>
              <div class="text-xs text-zinc-500">/usr/local/bin/composer · runs with the PHP version of the project you are in</div>
            } @else {
              <div class="font-medium text-zinc-300">Composer is not installed</div>
              <div class="text-xs text-zinc-500">Downloaded from getcomposer.org and checked against its published SHA-256.</div>
            }
          </div>
          <button class="btn-primary" [disabled]="running()" (click)="startJob('/api/tools/composer/install')">
            {{ tools()?.composer?.installed ? 'Reinstall latest' : 'Install Composer' }}
          </button>
        </section>

        <!-- Node -->
        <h2 class="mt-8 mb-3 text-xs font-medium tracking-wide text-zinc-500 uppercase">Node.js</h2>
        @for (node of tools()?.node ?? []; track node.version) {
          <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div class="flex items-center gap-2">
              <h3 class="font-medium">Node {{ node.version }}</h3>
              <span class="font-mono text-xs text-zinc-500">npm {{ node.npm }}</span>
              <span class="flex-1"></span>
              <button class="link remove" [disabled]="running()" (click)="uninstallNode(node.version)">Uninstall</button>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              @for (pkg of node.globals; track pkg.name) {
                <span class="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 font-mono text-xs">
                  {{ pkg.name }}&#64;{{ pkg.version }}
                  <button class="text-zinc-500 hover:text-red-300" title="Uninstall" [disabled]="running()"
                    (click)="global(node.version, pkg.name, 'uninstall')">✕</button>
                </span>
              }
              @if (!hasAngularCli(node.globals)) {
                <button class="btn" [disabled]="running()" (click)="global(node.version, '@angular/cli', 'install')">+ Angular CLI</button>
              }
              <form class="flex items-center gap-1" (ngSubmit)="global(node.version, packageInput[node.version] ?? '', 'install')">
                <input class="input w-44 font-mono" [name]="'pkg-' + node.version" [(ngModel)]="packageInput[node.version]"
                  placeholder="npm package" autocomplete="off" />
                <button class="btn" type="submit" [disabled]="running() || !(packageInput[node.version] ?? '').trim()">Install</button>
              </form>
            </div>
          </section>
        }
        <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="text-zinc-400">{{ tools()?.fnmInstalled ? 'Add a Node version:' : 'Node is managed with fnm, installed with the first version:' }}</span>
            <button class="btn-primary" [disabled]="running()" (click)="startJob('/api/node/install', { version: 'lts' })">Latest LTS</button>
            <form class="flex items-center gap-1" (ngSubmit)="startJob('/api/node/install', { version: nodeVersion.trim() })">
              <input class="input w-24 font-mono" name="nodeVersion" [(ngModel)]="nodeVersion" placeholder="22" autocomplete="off" />
              <button class="btn" type="submit" [disabled]="running() || !nodeVersion.trim()">Install</button>
            </form>
          </div>
        </section>
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
    .link {
      font-size: 0.75rem;
      color: var(--color-emerald-300);
    }
    .link:hover:not(:disabled) {
      text-decoration: underline;
    }
    .link.remove {
      color: var(--color-zinc-600);
    }
    .link.remove:hover:not(:disabled) {
      color: var(--color-red-300);
      text-decoration: none;
    }
    .btn:disabled,
    .btn-primary:disabled,
    .link:disabled {
      opacity: 0.4;
    }
    .input {
      height: 1.875rem;
      border-radius: 0.375rem;
      border: 1px solid var(--color-zinc-700);
      background: var(--color-zinc-950);
      padding: 0 0.5rem;
      font-size: 0.8125rem;
    }
  `,
})
export class Tools implements OnInit {
  private readonly daemon = inject(Daemon);
  private readonly store = inject(ServicesStore);

  protected readonly tools = signal<ToolsInfo | null>(null);
  protected readonly updates = signal<ToolUpdates | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.store.job(this.jobId() ?? undefined));
  protected readonly running = computed(() => {
    const status = this.job()?.status;
    return status === 'queued' || status === 'running';
  });
  protected nodeVersion = '';
  protected packageInput: Record<string, string> = {};

  constructor() {
    // Re-read state when a job started here finishes.
    effect(() => {
      const job = this.job();
      if (job?.status !== 'succeeded' && job?.status !== 'failed') return;
      untracked(() => {
        void this.load();
        if (/update|upgrade|install|composer/i.test(job.title)) void this.loadUpdates();
      });
    });
  }

  ngOnInit(): void {
    void this.load();
    void this.loadUpdates();
  }

  protected async startJob(path: string, body?: unknown): Promise<void> {
    this.message.set(null);
    const id = await this.store.startJob(path, body);
    if (id) this.jobId.set(id);
    else this.message.set(this.store.error());
  }

  protected async extension(php: PhpToolInfo, ext: PhpExtension, action: 'install' | 'uninstall' | 'enable' | 'disable'): Promise<void> {
    const path = `/api/tools/php/${php.version}/extensions/${ext.name}/${action}`;
    if (action === 'uninstall' && !confirm(`Uninstall ${ext.name} from PHP ${php.version}?`)) return;
    if (action === 'install' || action === 'uninstall') return this.startJob(path);
    this.busy.set(true);
    const result = await this.daemon.api<PhpToolInfo>({ method: 'POST', path });
    this.busy.set(false);
    if (!result.ok) return this.message.set(result.error);
    this.tools.update((t) => (t ? { ...t, php: t.php.map((p) => (p.version === php.version ? result.data : p)) } : t));
  }

  protected global(version: string, name: string, action: 'install' | 'uninstall'): Promise<void> {
    if (!name.trim()) return Promise.resolve();
    if (action === 'uninstall' && !confirm(`Uninstall ${name} from Node ${version}?`)) return Promise.resolve();
    this.packageInput[version] = '';
    return this.startJob(`/api/tools/node/${version}/globals`, { package: name.trim(), action });
  }

  protected async uninstallNode(version: string): Promise<void> {
    if (!confirm(`Uninstall Node ${version} and its global packages?`)) return;
    const result = await this.daemon.api<{ id: string }>({ method: 'DELETE', path: `/api/node/${version}` });
    if (result.ok) this.jobId.set(result.data.id);
    else this.message.set(result.error);
  }

  protected hasAngularCli(globals: { name: string }[]): boolean {
    return globals.some((g) => g.name === '@angular/cli');
  }

  protected extDot(ext: PhpExtension): string {
    if (!ext.installed) return 'bg-zinc-700';
    return ext.enabled ? 'bg-emerald-400' : 'bg-amber-400';
  }

  protected aptSummary(u: ToolUpdates): string {
    const names = u.apt.map((p) => p.name);
    return names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
  }

  protected npmUpdates(u: ToolUpdates): { version: string; list: string }[] {
    return Object.entries(u.npm)
      .filter(([, list]) => list.length)
      .map(([version, list]) => ({ version, list: list.map((p) => `${p.name} ${p.current} → ${p.latest}`).join(', ') }));
  }

  protected npmUpdateCount(u: ToolUpdates): number {
    return Object.values(u.npm).reduce((n, list) => n + list.length, 0);
  }

  protected checkedAt(u: ToolUpdates): string {
    return new Date(u.checkedAt).toLocaleTimeString();
  }

  private async load(): Promise<void> {
    const result = await this.daemon.api<ToolsInfo>({ method: 'GET', path: '/api/tools' });
    if (result.ok) this.tools.set(result.data);
    else this.message.set(result.error);
  }

  private async loadUpdates(): Promise<void> {
    const result = await this.daemon.api<ToolUpdates>({ method: 'GET', path: '/api/tools/updates' });
    if (result.ok) this.updates.set(result.data);
  }
}
