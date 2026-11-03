import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { DesktopSettings, EditorId } from '@devkit/shared';
import { detectEditors } from './editors';

const file = () => join(app.getPath('userData'), 'settings.json');
const EDITORS: EditorId[] = ['antigravity', 'vscode', 'cursor', 'windsurf', 'custom'];

let cached: DesktopSettings | null = null;

/** Defaults pick the first installed editor, preferring Antigravity. */
function defaults(): DesktopSettings {
  const installed = detectEditors().find((e) => e.command);
  return { editor: installed?.id ?? 'vscode', customEditorCommand: '', startWithWindows: false, closeToTray: true };
}

export function getSettings(): DesktopSettings {
  if (cached) return cached;
  let stored: Partial<DesktopSettings> = {};
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), 'utf8')) as Partial<DesktopSettings>;
  } catch {
    // Corrupt file: fall back to defaults.
  }
  cached = { ...defaults(), ...stored, startWithWindows: app.getLoginItemSettings().openAtLogin };
  return cached;
}

export function saveSettings(changes: Partial<DesktopSettings>): DesktopSettings {
  const next: DesktopSettings = { ...getSettings() };
  if (changes.editor && EDITORS.includes(changes.editor)) next.editor = changes.editor;
  if (typeof changes.customEditorCommand === 'string') next.customEditorCommand = changes.customEditorCommand.slice(0, 500);
  if (typeof changes.closeToTray === 'boolean') next.closeToTray = changes.closeToTray;
  if (typeof changes.startWithWindows === 'boolean') {
    // Started hidden at login: DevKit then lives in the tray until opened.
    app.setLoginItemSettings({ openAtLogin: changes.startWithWindows, args: ['--hidden'] });
    next.startWithWindows = changes.startWithWindows;
  }
  writeFileSync(file(), JSON.stringify(next, null, 2));
  cached = next;
  return next;
}
