import { contextBridge, ipcRenderer } from 'electron';
import type { DevkitBridge } from '@devkit/shared';

// The renderer never sees the daemon token: every API call is proxied by the main process.
const bridge: DevkitBridge = {
  connection: () => ipcRenderer.invoke('devkit:connection'),
  installDaemon: () => ipcRenderer.invoke('devkit:install-daemon'),
  api: (request) => ipcRenderer.invoke('devkit:api', request),
};

contextBridge.exposeInMainWorld('devkit', bridge);
