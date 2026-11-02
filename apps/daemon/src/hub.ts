import type { ServerWebSocket } from 'bun';
import type { ClientMessage, DaemonEvent } from '@devkit/shared';
import { streamLines, type LineStream } from './exec.ts';
import { findService } from './services/catalog.ts';
import { logCommand } from './services/logs.ts';
import { listServices } from './services/services.ts';

export interface SocketData {
  logStream: LineStream | null;
}

export type Socket = ServerWebSocket<SocketData>;

const POLL_MS = 5000;
const INITIAL_LOG_LINES = 200;

/** Live connections: broadcasts service/job events and runs one log tail per socket. */
export class Hub {
  private readonly sockets = new Set<Socket>();
  private lastServices = '';
  private refreshing: Promise<void> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  add(ws: Socket): void {
    this.sockets.add(ws);
    // A fresh socket always gets the current list, even if nothing changed.
    this.lastServices = '';
    void this.refreshServices();
    this.poll ??= setInterval(() => void this.refreshServices(), POLL_MS);
  }

  remove(ws: Socket): void {
    this.stopLogs(ws);
    this.sockets.delete(ws);
    if (this.sockets.size === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  broadcast(event: DaemonEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.sockets) ws.send(payload);
  }

  /** Re-reads service states and broadcasts them if anything changed (e.g. a crash noticed by systemd). */
  refreshServices(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const services = await listServices();
        const json = JSON.stringify(services);
        if (json !== this.lastServices) {
          this.lastServices = json;
          this.broadcast({ type: 'services', services });
        }
      } catch (e) {
        console.error('refreshServices failed:', e);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  handleMessage(ws: Socket, raw: string | Buffer): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (message.type === 'logs.unsubscribe') {
      this.stopLogs(ws);
    } else if (message.type === 'logs.subscribe') {
      this.startLogs(ws, message.serviceId, message.sourceId);
    }
  }

  private startLogs(ws: Socket, serviceId: string, sourceId: string): void {
    this.stopLogs(ws);
    const send = (lines: string[]) => ws.send(JSON.stringify({ type: 'log', serviceId, sourceId, lines } satisfies DaemonEvent));
    const def = findService(serviceId);
    try {
      if (!def) throw new Error(`Unknown service "${serviceId}"`);
      ws.data.logStream = streamLines(logCommand(def, sourceId, INITIAL_LOG_LINES, true), send);
    } catch (e) {
      send([`[devkit] ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  private stopLogs(ws: Socket): void {
    ws.data.logStream?.stop();
    ws.data.logStream = null;
  }
}
