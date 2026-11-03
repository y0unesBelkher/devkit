import { Injectable, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  ApiRequest,
  ApiResult,
  ClientMessage,
  ConnectionState,
  DaemonEvent,
  DevkitBridge,
  SystemInfo,
} from '@devkit/shared';

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
  /** Live events relayed from the daemon WebSocket. */
  readonly events = new Subject<DaemonEvent>();
  readonly live = signal(false);

  constructor() {
    this.bridge?.onEvent((event) => {
      if (event.type === 'socket') {
        this.live.set(event.connected);
        // The daemon came back (restart, upgrade): re-read its state.
        if (event.connected && this.connection().status !== 'connected') void this.refresh();
      }
      this.events.next(event);
    });
    // The socket may have opened before this page loaded, in which case its event was missed.
    void this.bridge?.isLive().then((live) => this.live.set(live));
  }

  send(message: ClientMessage): void {
    this.bridge?.send(message);
  }

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

  /** Windows-side actions; only callable inside the desktop app (pages check `inDesktopApp`). */
  get windows(): DevkitBridge {
    if (!this.bridge) throw new Error('Not running inside the DevKit desktop app');
    return this.bridge;
  }

  api<T>(request: ApiRequest): Promise<ApiResult<T>> {
    if (!this.bridge) return Promise.resolve({ ok: false, status: 0, error: 'Not running inside the DevKit desktop app' });
    return this.bridge.api<T>(request);
  }
}
