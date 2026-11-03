import { Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DatabaseInfo, DatabasesResponse } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Dialogs } from '../components/dialogs';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';

@Component({
  selector: 'app-databases',
  imports: [FormsModule, ConsoleView],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl p-8">
        <h1 class="text-2xl font-semibold">Databases</h1>
        <p class="mt-1 text-sm text-zinc-400">MySQL in WSL. Dumps can be imported from and exported to any Windows folder.</p>

        @if (notice(); as n) {
          <p class="mt-4 rounded-lg border p-3 text-sm whitespace-pre-wrap"
            [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'">
            {{ n.message }}
          </p>
        }

        @if (state(); as s) {
          @if (!s.mysqlInstalled) {
            <p class="mt-6 text-sm text-zinc-400">MySQL is not installed. Install it on the Services page.</p>
          } @else if (!s.mysqlRunning) {
            <p class="mt-6 text-sm text-amber-300">MySQL is installed but not running. Start it on the Services page.</p>
          } @else {
            <form class="mt-6 flex gap-2" (ngSubmit)="create()">
              <input class="dk-input w-64 font-mono" name="name" [(ngModel)]="newName" placeholder="new_database" autocomplete="off" />
              <button class="dk-btn-primary" type="submit" [disabled]="!newName.trim()">Create database</button>
            </form>

            <div class="dk-card mt-4 divide-y divide-zinc-800 overflow-hidden">
              @for (db of s.databases; track db.name) {
                <div class="flex items-center gap-4 px-4 py-2.5 text-sm">
                  <span class="flex-1 font-mono">{{ db.name }}</span>
                  <span class="w-20 text-right text-xs text-zinc-500">{{ db.tables }} tables</span>
                  <span class="w-20 text-right text-xs text-zinc-500">{{ size(db.sizeBytes) }}</span>
                  <button class="dk-btn" [disabled]="running()" (click)="exportDb(db)">Export…</button>
                  <button class="dk-btn" [disabled]="running()" (click)="importDb(db)">Import…</button>
                  <button class="dk-btn dk-btn-danger" [disabled]="running()" (click)="drop(db)">Drop</button>
                </div>
              } @empty {
                <p class="px-4 py-4 text-sm text-zinc-500">No databases yet.</p>
              }
            </div>
          }

          @if (s.adminer; as a) {
            <section class="dk-card mt-8 flex items-center gap-4 p-4">
              <div class="flex-1">
                <h2 class="font-medium">Adminer</h2>
                @if (a.enabled) {
                  <p class="mt-1 text-sm text-zinc-400">
                    <a class="text-emerald-300 hover:underline" [href]="'https://' + a.domain" target="_blank">https://{{ a.domain }}</a>
                    signs in automatically as <span class="font-mono">{{ a.username }}</span>.
                  </p>
                } @else {
                  <p class="mt-1 text-sm text-zinc-400">A database UI at https://{{ a.domain }}, signed in to this MySQL automatically.</p>
                }
              </div>
              @if (a.enabled) {
                <button class="dk-btn dk-btn-danger" [disabled]="running()" (click)="disableAdminer()">Remove</button>
              } @else {
                <button class="dk-btn-primary" [disabled]="running() || !s.mysqlRunning" (click)="enableAdminer()">Set up Adminer</button>
              }
            </section>
          }
        }
      </div>
    </div>

    @if (job(); as j) {
      <section class="flex h-64 shrink-0 flex-col border-t border-zinc-800 bg-zinc-900">
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
export class Databases implements OnInit {
  private readonly daemon = inject(Daemon);
  private readonly store = inject(ServicesStore);
  private readonly dialogs = inject(Dialogs);

  protected readonly state = signal<DatabasesResponse | null>(null);
  protected readonly notice = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.store.job(this.jobId() ?? undefined));
  protected readonly running = computed(() => {
    const status = this.job()?.status;
    return status === 'queued' || status === 'running';
  });
  protected newName = '';

  constructor() {
    effect(() => {
      const job = this.job();
      if (job?.status !== 'succeeded' && job?.status !== 'failed') return;
      untracked(async () => {
        await this.load();
        // A new Adminer site needs its hosts entry (one UAC prompt).
        if (job.status === 'succeeded' && job.title === 'Set up Adminer') {
          const hosts = await this.daemon.windows.syncHosts();
          if (!hosts.ok) this.notice.set(hosts);
        }
      });
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected size(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  protected async create(): Promise<void> {
    const result = await this.daemon.api({ method: 'POST', path: '/api/databases', body: { name: this.newName.trim() } });
    this.notice.set(result.ok ? { ok: true, message: `Created ${this.newName.trim()}.` } : { ok: false, message: result.error });
    if (result.ok) this.newName = '';
    await this.load();
  }

  protected async drop(db: DatabaseInfo): Promise<void> {
    const typed = await this.dialogs.prompt(`Drop ${db.name}?`, {
      message: `This permanently deletes ${db.name} and its ${db.tables} tables. Type the database name to confirm.`,
      placeholder: db.name,
      confirmLabel: 'Drop database',
    });
    if (typed !== db.name) return;
    const result = await this.daemon.api({ method: 'DELETE', path: `/api/databases/${encodeURIComponent(db.name)}` });
    this.notice.set(result.ok ? { ok: true, message: `Dropped ${db.name}.` } : { ok: false, message: result.error });
    await this.load();
  }

  protected async exportDb(db: DatabaseInfo): Promise<void> {
    const file = await this.daemon.windows.pickFile('save', `${db.name}.sql`);
    if (file) await this.startJob(`/api/databases/${encodeURIComponent(db.name)}/export`, { file });
  }

  protected async importDb(db: DatabaseInfo): Promise<void> {
    const file = await this.daemon.windows.pickFile('open');
    if (!file || !confirm(`Import ${file} into ${db.name}? Tables in the dump replace existing ones.`)) return;
    await this.startJob(`/api/databases/${encodeURIComponent(db.name)}/import`, { file });
  }

  protected enableAdminer(): Promise<void> {
    return this.startJob('/api/adminer');
  }

  protected async disableAdminer(): Promise<void> {
    if (!confirm('Remove the Adminer site? Its MySQL account stays.')) return;
    const result = await this.daemon.api({ method: 'DELETE', path: '/api/adminer' });
    if (!result.ok) this.notice.set({ ok: false, message: result.error });
    await this.daemon.windows.syncHosts();
    await this.load();
  }

  private async startJob(path: string, body?: unknown): Promise<void> {
    this.notice.set(null);
    const id = await this.store.startJob(path, body);
    if (id) this.jobId.set(id);
    else this.notice.set({ ok: false, message: this.store.error() ?? 'Could not start the job' });
  }

  private async load(): Promise<void> {
    const result = await this.daemon.api<DatabasesResponse>({ method: 'GET', path: '/api/databases' });
    if (result.ok) this.state.set(result.data);
    else this.notice.set({ ok: false, message: result.error });
  }
}
