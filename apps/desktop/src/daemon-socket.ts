import type { ClientMessage, DaemonEvent } from '@devkit/shared';
import { daemonWsUrl, forgetToken, getToken, ping } from './daemon-client';

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

/**
 * Keeps one WebSocket open to the daemon and relays its events. Reconnects with backoff
 * and replays the active log subscription, so the UI survives daemon restarts and upgrades.
 */
export class DaemonSocket {
  private ws: WebSocket | null = null;
  private retryMs = MIN_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private logSubscription: ClientMessage | null = null;
  private stopped = false;

  constructor(private readonly emit: (event: DaemonEvent) => void) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Drops the current connection and reconnects now (e.g. after the daemon was reinstalled). */
  reconnect(): void {
    this.retryMs = MIN_RETRY_MS;
    if (this.ws) this.ws.close();
    else this.schedule(0);
  }

  send(message: ClientMessage): void {
    if (message.type === 'logs.subscribe') this.logSubscription = message;
    if (message.type === 'logs.unsubscribe') this.logSubscription = null;
    if (this.connected) this.ws?.send(JSON.stringify(message));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.ws) return;
    // Ping first: it is cheap, while reading the token spawns wsl.exe.
    if (!(await ping())) return this.retryLater();

    let token: string;
    try {
      token = await getToken();
    } catch {
      return this.retryLater();
    }

    const ws = new WebSocket(`${daemonWsUrl}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      this.retryMs = MIN_RETRY_MS;
      this.emit({ type: 'socket', connected: true });
      if (this.logSubscription) ws.send(JSON.stringify(this.logSubscription));
    });
    ws.addEventListener('message', (event) => {
      try {
        this.emit(JSON.parse(String(event.data)) as DaemonEvent);
      } catch {
        // Ignore malformed frames.
      }
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      // Never opened: most likely a stale token after a reinstall.
      if (!opened) forgetToken();
      else this.emit({ type: 'socket', connected: false });
      this.retryLater();
    });
  }

  private retryLater(): void {
    this.schedule(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}
