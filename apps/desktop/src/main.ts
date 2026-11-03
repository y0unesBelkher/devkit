import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { ApiRequest, ClientMessage, DesktopSettings, ListenMode, OpenTarget } from '@devkit/shared';
import { installDaemon } from './bootstrap';
import { api, connectionState } from './daemon-client';
import { DaemonSocket } from './daemon-socket';
import { detectEditors } from './editors';
import { dumpEnvKitDatabase } from './envkit';
import { getSettings, saveSettings } from './settings';
import { openPath, pickFile } from './shell-actions';
import { TrayController } from './tray';
import { setListenMode, syncHosts, trustCa, windowsStatus } from './windows';

const devServerUrl = process.env['DEVKIT_UI_URL'] ?? (app.isPackaged ? null : 'http://localhost:4200');

let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
/** Set when the user really quits (tray menu), so closing the window can otherwise hide it. */
let quitting = false;

function createWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'DevKit',
    show,
    icon: join(app.getAppPath(), 'assets', 'icon.png'),
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

  win.on('close', (event) => {
    if (!quitting && getSettings().closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else if (app.isPackaged) {
    void win.loadFile(join(process.resourcesPath, 'ui', 'index.html'));
  } else {
    void win.loadFile(resolve(app.getAppPath(), '..', 'ui', 'dist', 'ui', 'browser', 'index.html'));
  }
  return win;
}

function showWindow(): void {
  mainWindow ??= createWindow(true);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quit(): void {
  quitting = true;
  socket.stop();
  app.quit();
}

const socket = new DaemonSocket((event) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('devkit:event', event);
  if (event.type === 'services') tray?.setServices(event.services);
  if (event.type === 'socket') tray?.setLive(event.connected);
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
  ipcMain.handle('devkit:envkit-dump', (_event, database: string) => dumpEnvKitDatabase(database));
  ipcMain.handle('devkit:get-settings', () => getSettings());
  ipcMain.handle('devkit:save-settings', (_event, changes: Partial<DesktopSettings>) => saveSettings(changes));
  ipcMain.handle('devkit:list-editors', () => detectEditors());
}

/** Headless flags (`electron . --status`): run one step without a window, print JSON, exit non-zero on failure. */
const HEADLESS: Record<string, (value: string) => Promise<unknown>> = {
  '--status': connectionState,
  '--install-daemon': installDaemon,
  '--windows-status': windowsStatus,
  '--trust-ca': trustCa,
  '--sync-hosts': syncHosts,
  '--envkit-dump': (database) => dumpEnvKitDatabase(database),
};

/** `--flag` or `--flag=value`. */
async function runHeadless(arg: string): Promise<void> {
  const [flag = '', value = ''] = arg.split(/=(.*)/s);
  try {
    const result = await HEADLESS[flag]!(value);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    app.exit((result as { ok?: boolean }).ok === false ? 1 : 0);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    app.exit(1);
  }
}

const headlessFlag = process.argv.find((arg) => arg.split('=')[0]! in HEADLESS);

if (headlessFlag) {
  void app.whenReady().then(() => runHeadless(headlessFlag));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('dev.devkit.app');
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(() => {
    registerIpc();
    // Started at login: stay in the tray until opened.
    const hidden = process.argv.includes('--hidden');
    mainWindow = createWindow(!hidden);
    tray = new TrayController(showWindow, quit);
    socket.start();
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  // With the tray, closing the last window does not quit; the tray's "Quit DevKit" does.
  app.on('window-all-closed', () => {
    if (!getSettings().closeToTray) quit();
  });
}
