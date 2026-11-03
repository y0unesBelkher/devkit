import { Component, DestroyRef, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import type { WindowsStatus } from '@devkit/shared';
import { Daemon } from '../core/daemon';

const CHECK_EVERY_MS = 60_000;

/**
 * App-wide warning when the browser would not reach the sites: the hosts file is stale (WSL got a new IP
 * after a restart, or sites changed) or nginx does not answer where the hosts file points.
 */
@Component({
  selector: 'app-network-banner',
  template: `
    @if (problem(); as p) {
      <div class="flex items-center gap-4 border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-sm text-amber-100">
        <span class="flex-1">{{ p.message }}</span>
        @if (p.fix === 'hosts') {
          <button class="dk-btn-primary" [disabled]="busy()" (click)="syncHosts()">{{ busy() ? 'Waiting for approval…' : 'Update hosts file' }}</button>
        } @else if (p.fix === 'wsl-ip') {
          <button class="dk-btn-primary" [disabled]="busy()" (click)="useWslIp()">Use the WSL IP instead</button>
        }
        <button class="text-xs opacity-70 hover:opacity-100" (click)="check()">Re-check</button>
      </div>
    }
  `,
})
export class NetworkBanner implements OnInit {
  private readonly daemon = inject(Daemon);
  private readonly status = signal<WindowsStatus | null>(null);
  protected readonly busy = signal(false);

  protected readonly problem = computed<{ message: string; fix: 'hosts' | 'wsl-ip' | null } | null>(() => {
    const s = this.status();
    if (!s) return null;
    if (!s.hosts.inSync) {
      return { message: `The Windows hosts file no longer matches your sites (WSL is now at ${s.network.hostsTarget}).`, fix: 'hosts' };
    }
    if (s.reachable === false) {
      return s.network.mode === 'localhost'
        ? { message: "Windows can't reach nginx through 127.0.0.1 (WSL's localhost forwarding stopped).", fix: 'wsl-ip' }
        : { message: `Windows can't reach nginx at ${s.network.hostsTarget}:443. Is nginx running (Services page)?`, fix: null };
    }
    return null;
  });

  constructor() {
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Re-check when the daemon comes back (WSL restarted: new IP).
    effect(() => {
      if (this.daemon.live()) untracked(() => void this.check());
    });
  }

  ngOnInit(): void {
    void this.check();
  }

  protected async check(): Promise<void> {
    if (!this.daemon.inDesktopApp || !this.daemon.connected()) return;
    try {
      this.status.set(await this.daemon.windows.windowsStatus());
    } catch {
      this.status.set(null);
    }
  }

  protected async syncHosts(): Promise<void> {
    this.busy.set(true);
    try {
      await this.daemon.windows.syncHosts();
    } finally {
      this.busy.set(false);
    }
    await this.check();
  }

  protected async useWslIp(): Promise<void> {
    this.busy.set(true);
    try {
      await this.daemon.windows.setListenMode('wsl-ip');
    } finally {
      this.busy.set(false);
    }
    await this.check();
  }
}
