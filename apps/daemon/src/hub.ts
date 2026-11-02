import type { ServerWebSocket } from 'bun';
import type { ClientMessage, DaemonEvent } from '@devkit/shared';
import { streamLines, type LineStream } from './exec.ts';
import { findService } from './services/catalog.ts';
import { logCommand } from './services/logs.ts';
import { listServices } from './services/services.ts';
import { listProcesses, unitName } from './sites/processes.ts';
import type { Store } from './store.ts';

export interface SocketData {
  logStream: LineStream | null;
}

export type Socket = ServerWebSocket<SocketData>;

const POLL_MS = 5000;
const INITIAL_LOG_LINES = 200;

/** Live connections: broadcasts service, process and job events, and runs one log tail per socket. */
export class Hub {
  private readonly sockets = new Set<Socket>();
  private last = { services: '', processes: '' };
  private refreshing: Promise<void> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly store: Store) {}

  add(ws: Socket): void {
    this.sockets.add(ws);
    // A fresh socket always gets the current state, even if nothing changed.
    this.last = { services: '', processes: '' };
    void this.refresh();
    this.poll ??= setInterval(() => void this.refresh(), POLL_MS);
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

  /** Re-reads service and process states and broadcasts whatever changed (e.g. a crash noticed by systemd). */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const [services, processes] = await Promise.all([listServices(), listProcesses(this.store)]);
        const servicesJson = JSON.stringify(services);
        if (servicesJson !== this.last.services) {
          this.last.services = servicesJson;
          this.broadcast({ type: 'services', services });
        }
        const processesJson = JSON.stringify(processes);
        if (processesJson !== this.last.processes) {
          this.last.processes = processesJson;
          this.broadcast({ type: 'processes', processes });
        }
      } catch (e) {
        console.error('state refresh failed:', e);
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
    if (message.type === 'logs.unsubscribe') this.stopLogs(ws);
    else if (message.type === 'logs.subscribe') this.startServiceLogs(ws, message.serviceId, message.sourceId);
    else if (message.type === 'process-logs.subscribe') this.startProcessLogs(ws, message.processId);
  }

  private startServiceLogs(ws: Socket, serviceId: string, sourceId: string): void {
    const send = (lines: string[]) => ws.send(JSON.stringify({ type: 'log', serviceId, sourceId, lines } satisfies DaemonEvent));
    const def = findService(serviceId);
    this.stream(ws, send, () => {
      if (!def) throw new Error(`Unknown service "${serviceId}"`);
      return logCommand(def, sourceId, INITIAL_LOG_LINES, true);
    });
  }

  private startProcessLogs(ws: Socket, processId: string): void {
    const send = (lines: string[]) => ws.send(JSON.stringify({ type: 'process-log', processId, lines } satisfies DaemonEvent));
    this.stream(ws, send, () => {
      if (!this.store.getProcess(processId)) throw new Error('Unknown process');
      // Bare messages: dev servers and workers print their own timestamps.
      return ['journalctl', '-u', unitName(processId), '-n', String(INITIAL_LOG_LINES), '--no-pager', '-o', 'cat', '-f'];
    });
  }

  private stream(ws: Socket, send: (lines: string[]) => void, command: () => string[]): void {
    this.stopLogs(ws);
    try {
      ws.data.logStream = streamLines(command(), send);
    } catch (e) {
      send([`[devkit] ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  private stopLogs(ws: Socket): void {
    ws.data.logStream?.stop();
    ws.data.logStream = null;
  }
}
