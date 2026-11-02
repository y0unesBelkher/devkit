import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DaemonEvent, DevkitBridge } from '@devkit/shared';

// The renderer never sees the daemon token: every API call and socket frame is proxied by the main process.
const bridge: DevkitBridge = {
  connection: () => ipcRenderer.invoke('devkit:connection'),
  installDaemon: () => ipcRenderer.invoke('devkit:install-daemon'),
  api: (request) => ipcRenderer.invoke('devkit:api', request),
  isLive: () => ipcRenderer.invoke('devkit:is-live'),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, daemonEvent: DaemonEvent) => listener(daemonEvent);
    ipcRenderer.on('devkit:event', handler);
    return () => ipcRenderer.off('devkit:event', handler);
  },
  send: (message) => ipcRenderer.send('devkit:ws-send', message),
};

contextBridge.exposeInMainWorld('devkit', bridge);
