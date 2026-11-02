import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { ApiRequest } from '@devkit/shared';
import { installDaemon } from './bootstrap';
import { api, connectionState } from './daemon-client';

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

function registerIpc(): void {
  ipcMain.handle('devkit:connection', () => connectionState());
  ipcMain.handle('devkit:install-daemon', () => installDaemon());
  ipcMain.handle('devkit:api', (_event, request: ApiRequest) => api(request));
}

/** `electron . --install-daemon` / `--status`: run one bootstrap step without a window, print JSON, exit. */
async function runHeadless(flag: string): Promise<void> {
  try {
    const result = flag === '--install-daemon' ? await installDaemon() : await connectionState();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    app.exit(flag === '--install-daemon' && !(result as { ok: boolean }).ok ? 1 : 0);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    app.exit(1);
  }
}

const headlessFlag = process.argv.find((arg) => arg === '--install-daemon' || arg === '--status');

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
  });

  app.on('window-all-closed', () => app.quit());
}
