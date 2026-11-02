import { Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { NodeInfo } from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';

@Component({
  selector: 'app-tools',
  imports: [FormsModule, ConsoleView],
  template: `
    <div class="mx-auto max-w-4xl p-8">
      <h1 class="text-2xl font-semibold">Tools</h1>
      <p class="mt-1 text-sm text-zinc-400">Runtimes used by your projects. Composer, PHP extensions and global npm packages arrive next.</p>

      <section class="mt-6 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
        <div class="p-5">
          <div class="flex items-start justify-between gap-6">
            <div>
              <h2 class="font-medium">Node.js</h2>
              <p class="mt-1 text-sm text-zinc-400">
                Managed with fnm for your WSL user. Each Angular site runs ng serve with the Node version you pick for it.
              </p>
            </div>
            <span class="text-xs" [class]="node()?.fnmInstalled ? 'text-emerald-300' : 'text-zinc-500'">
              {{ node()?.fnmInstalled ? 'fnm installed' : 'fnm not installed' }}
            </span>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            @for (v of node()?.versions ?? []; track v) {
              <span class="rounded-md bg-zinc-800 px-2 py-1 font-mono text-xs">v{{ v }}</span>
            } @empty {
              <span class="text-sm text-zinc-500">No Node versions installed.</span>
            }
          </div>

          <form class="mt-4 flex items-center gap-2" (ngSubmit)="install(version)">
            <button type="button" class="btn-primary" [disabled]="running()" (click)="install('lts')">Install latest LTS</button>
            <span class="text-xs text-zinc-500">or version</span>
            <input class="input w-28 font-mono" name="version" [(ngModel)]="version" placeholder="22" autocomplete="off" />
            <button class="btn" type="submit" [disabled]="running() || !version.trim()">Install</button>
          </form>
          @if (store.error(); as error) {
            <p class="mt-3 text-sm text-red-300">{{ error }}</p>
          }
        </div>
        @if (job(); as j) {
          <div class="flex items-center gap-2 border-t border-zinc-800 px-5 py-2 text-xs">
            <span>{{ j.title }}</span>
            <span [class]="j.status === 'failed' ? 'text-red-300' : j.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'">{{ j.status }}</span>
          </div>
          <app-console-view class="h-64" [lines]="j.output" />
        }
      </section>
    </div>
  `,
  styles: `
    .btn {
      border-radius: 0.375rem;
      border: 1px solid var(--color-zinc-700);
      padding: 0.25rem 0.625rem;
      font-size: 0.8125rem;
    }
    .btn-primary {
      border-radius: 0.375rem;
      background: var(--color-emerald-500);
      padding: 0.25rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-zinc-950);
    }
    .btn:disabled,
    .btn-primary:disabled {
      opacity: 0.5;
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
  protected readonly store = inject(ServicesStore);

  protected readonly node = signal<NodeInfo | null>(null);
  private readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.store.job(this.jobId() ?? undefined));
  protected readonly running = computed(() => {
    const status = this.job()?.status;
    return status === 'queued' || status === 'running';
  });
  protected version = '';

  constructor() {
    // Refresh the version list when an install finishes.
    effect(() => {
      const status = this.job()?.status;
      if (status === 'succeeded' || status === 'failed') void untracked(() => this.load());
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected async install(version: string): Promise<void> {
    this.jobId.set(await this.store.startJob('/api/node/install', { version: version.trim() }));
  }

  private async load(): Promise<void> {
    const result = await this.daemon.api<NodeInfo>({ method: 'GET', path: '/api/node' });
    if (result.ok) this.node.set(result.data);
  }
}
