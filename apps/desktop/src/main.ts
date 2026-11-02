import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { ApiRequest, ClientMessage, ListenMode, OpenTarget } from '@devkit/shared';
import { installDaemon } from './bootstrap';
import { api, connectionState } from './daemon-client';
import { DaemonSocket } from './daemon-socket';
import { openPath, pickFile } from './shell-actions';
import { setListenMode, syncHosts, trustCa, windowsStatus } from './windows';

const devServerUrl = process.env['DEVKIT_UI_URL'] ?? (app.isPackaged ? null : 'http://localhost:4200');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'DevKit',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // External links open in the Windows browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(resolve(app.getAppPath(), '..', 'ui', 'dist', 'ui', 'browser', 'index.html'));
  }
  return win;
}

const socket = new DaemonSocket((event) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('devkit:event', event);
});

function registerIpc(): void {
  ipcMain.handle('devkit:connection', () => connectionState());
  ipcMain.handle('devkit:install-daemon', async () => {
    const result = await installDaemon();
    if (result.ok) socket.reconnect();
    return result;
  });
  ipcMain.handle('devkit:api', (_event, request: ApiRequest) => api(request));
  ipcMain.handle('devkit:is-live', () => socket.connected);
  ipcMain.on('devkit:ws-send', (_event, message: ClientMessage) => socket.send(message));
  ipcMain.handle('devkit:windows-status', () => windowsStatus());
  ipcMain.handle('devkit:trust-ca', () => trustCa());
  ipcMain.handle('devkit:sync-hosts', () => syncHosts());
  ipcMain.handle('devkit:set-listen-mode', (_event, mode: ListenMode) => setListenMode(mode));
  ipcMain.handle('devkit:open-path', (_event, target: OpenTarget, path: string) => openPath(target, path));
  ipcMain.handle('devkit:pick-file', (_event, mode: 'open' | 'save', defaultName?: string) => pickFile(mode, defaultName));
}

/** Headless flags (`electron . --status`): run one step without a window, print JSON, exit non-zero on failure. */
const HEADLESS: Record<string, () => Promise<unknown>> = {
  '--status': connectionState,
  '--install-daemon': installDaemon,
  '--windows-status': windowsStatus,
  '--trust-ca': trustCa,
  '--sync-hosts': syncHosts,
};

async function runHeadless(flag: string): Promise<void> {
  try {
    const result = await HEADLESS[flag]!();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    app.exit((result as { ok?: boolean }).ok === false ? 1 : 0);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    app.exit(1);
  }
}

const headlessFlag = process.argv.find((arg) => arg in HEADLESS);

if (headlessFlag) {
  void app.whenReady().then(() => runHeadless(headlessFlag));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    createWindow();
    socket.start();
  });

  app.on('window-all-closed', () => app.quit());
}
