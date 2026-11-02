import { Component, inject } from '@angular/core';
import { Daemon } from '../core/daemon';

@Component({
  selector: 'app-dashboard',
  template: `
    <div class="mx-auto max-w-4xl p-8">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold">Dashboard</h1>
        <button
          class="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          [disabled]="daemon.connection().status === 'connecting'"
          (click)="daemon.refresh()"
        >
          Refresh
        </button>
      </div>

      @if (!daemon.inDesktopApp) {
        <div class="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          This UI is running in a plain browser. Start it through the desktop app (<code>npm run dev</code>) to reach the daemon.
        </div>
      } @else {
        <section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 class="text-sm font-medium uppercase tracking-wide text-zinc-500">WSL daemon</h2>
          @switch (daemon.connection().status) {
            @case ('connecting') {
              <p class="mt-3 text-zinc-400">Connecting to WSL…</p>
            }
            @case ('connected') {
              <p class="mt-3 text-emerald-300">Connected · devkitd {{ version() }}</p>
            }
            @case ('not-installed') {
              <p class="mt-3 text-zinc-300">The daemon is not installed in the WSL distro yet.</p>
              <button class="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                [disabled]="daemon.installing()" (click)="daemon.install()">
                {{ daemon.installing() ? 'Installing…' : 'Install daemon' }}
              </button>
            }
            @case ('outdated') {
              <p class="mt-3 text-amber-300">{{ message() }}</p>
              <button class="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                [disabled]="daemon.installing()" (click)="daemon.install()">
                {{ daemon.installing() ? 'Updating…' : 'Update daemon' }}
              </button>
            }
            @case ('unreachable') {
              <p class="mt-3 text-red-300">{{ message() }}</p>
              <button class="mt-4 rounded-md border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50"
                [disabled]="daemon.installing()" (click)="daemon.install()">
                {{ daemon.installing() ? 'Repairing…' : 'Reinstall daemon' }}
              </button>
            }
          }
          @if (daemon.installLog(); as log) {
            <pre class="mt-4 max-h-60 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-400">{{ log }}</pre>
          }
        </section>

        @if (daemon.system(); as sys) {
          <section class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">Distro</div>
              <div class="mt-1 font-medium">{{ sys.distro.name }}</div>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">Kernel</div>
              <div class="mt-1 font-medium">{{ sys.kernel }}</div>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">Project user</div>
              <div class="mt-1 font-medium">{{ sys.user }}</div>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">systemd</div>
              <div class="mt-1 font-medium" [class.text-red-300]="!sys.systemd">{{ sys.systemd ? 'Running' : 'Not PID 1' }}</div>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">Daemon</div>
              <div class="mt-1 font-medium">{{ sys.daemon.runningAsRoot ? 'root' : 'not root' }} · up {{ sys.daemon.uptimeSec }}s</div>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">Windows PATH in WSL</div>
              <div class="mt-1 font-medium" [class.text-amber-300]="sys.windowsPathAppended">
                {{ sys.windowsPathAppended ? 'Appended (EnvKit php may leak)' : 'Disabled' }}
              </div>
            </div>
          </section>
        }
      }
    </div>
  `,
})
export class Dashboard {
  protected readonly daemon = inject(Daemon);

  protected version(): string {
    const state = this.daemon.connection();
    return state.status === 'connected' ? state.version : '';
  }

  protected message(): string {
    const state = this.daemon.connection();
    if (state.status === 'outdated') return `Installed devkitd ${state.installed} is older than the bundled ${state.bundled}.`;
    if (state.status === 'unreachable') return state.message;
    return '';
  }
}
