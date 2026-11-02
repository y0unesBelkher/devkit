import { Injectable, computed, signal } from '@angular/core';
import type { ApiRequest, ApiResult, ConnectionState, DevkitBridge, SystemInfo } from '@devkit/shared';

declare global {
  interface Window {
    devkit?: DevkitBridge;
  }
}

/** Talks to the WSL daemon through the Electron bridge; the UI never calls the daemon directly. */
@Injectable({ providedIn: 'root' })
export class Daemon {
  private readonly bridge = window.devkit;

  readonly inDesktopApp = !!this.bridge;
  readonly connection = signal<ConnectionState>({ status: 'connecting' });
  readonly system = signal<SystemInfo | null>(null);
  readonly installing = signal(false);
  readonly installLog = signal<string | null>(null);
  readonly connected = computed(() => this.connection().status === 'connected');

  async refresh(): Promise<void> {
    if (!this.bridge) return;
    this.connection.set({ status: 'connecting' });
    const state = await this.bridge.connection();
    this.connection.set(state);
    if (state.status === 'connected') {
      const result = await this.api<SystemInfo>({ method: 'GET', path: '/api/system' });
      this.system.set(result.ok ? result.data : null);
    } else {
      this.system.set(null);
    }
  }

  async install(): Promise<void> {
    if (!this.bridge || this.installing()) return;
    this.installing.set(true);
    try {
      const result = await this.bridge.installDaemon();
      this.installLog.set(result.log);
    } finally {
      this.installing.set(false);
    }
    await this.refresh();
  }

  api<T>(request: ApiRequest): Promise<ApiResult<T>> {
    if (!this.bridge) return Promise.resolve({ ok: false, status: 0, error: 'Not running inside the DevKit desktop app' });
    return this.bridge.api<T>(request);
  }
}
