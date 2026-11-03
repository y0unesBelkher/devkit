import { spawn } from 'node:child_process';
import { BrowserWindow, dialog } from 'electron';
import type { ActionResult, OpenTarget } from '@devkit/shared';
import { openInEditor } from './editors';
import { getSettings } from './settings';
import { DISTRO, toWslUnc, wsl } from './wsl';

/** Starts a Windows program without waiting for it or tying its lifetime to DevKit. */
function launch(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function openPath(target: OpenTarget, linuxPath: string): Promise<ActionResult> {
  if (!/^\/[^\0]*$/.test(linuxPath)) return { ok: false, message: 'Expected an absolute Linux path.' };
  try {
    if (target === 'editor') return await openInEditor(getSettings(), linuxPath);
    if (target === 'explorer') {
      await launch('explorer.exe', [toWslUnc(linuxPath)]);
      return { ok: true, message: `Opening ${linuxPath} in Explorer.` };
    }
    try {
      await launch('wt.exe', ['-w', '0', 'nt', 'wsl.exe', '-d', DISTRO, '--cd', linuxPath]);
    } catch {
      // No Windows Terminal: a plain console window.
      await launch('cmd.exe', ['/d', '/c', 'start', '', 'wsl.exe', '-d', DISTRO, '--cd', linuxPath]);
    }
    return { ok: true, message: `Opening a terminal in ${linuxPath}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Windows open/save dialog for SQL dumps; converts the result to a path the daemon can use (/mnt/c/…). */
export async function pickFile(mode: 'open' | 'save', defaultName?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const filters = [
    { name: 'SQL dumps', extensions: ['sql', 'gz'] },
    { name: 'All files', extensions: ['*'] },
  ];
  let windowsPath: string | undefined;
  if (mode === 'open') {
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters });
    windowsPath = result.canceled ? undefined : result.filePaths[0];
  } else {
    const options = { defaultPath: defaultName, filters };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    windowsPath = result.canceled ? undefined : result.filePath;
  }
  if (!windowsPath) return null;
  // Files already inside the distro come back as \\wsl.localhost\… paths; wslpath handles both forms.
  const converted = await wsl(['wslpath', '-a', windowsPath]);
  return converted.code === 0 ? converted.stdout.trim() : null;
}
