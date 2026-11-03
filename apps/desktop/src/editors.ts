import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionResult, DesktopSettings, EditorId, EditorInfo } from '@devkit/shared';
import { DISTRO, toWslUnc } from './wsl';

const LOCAL = process.env['LOCALAPPDATA'] ?? '';
const PROGRAMS = process.env['ProgramFiles'] ?? 'C:\\Program Files';

/** VS Code-family editors: each ships a .cmd launcher that understands `--remote wsl+<distro>`. */
const KNOWN: { id: Exclude<EditorId, 'custom'>; name: string; paths: string[]; command: string }[] = [
  {
    id: 'antigravity',
    name: 'Antigravity IDE',
    paths: [join(LOCAL, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'), join(LOCAL, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd')],
    command: 'antigravity-ide',
  },
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    paths: [join(LOCAL, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), join(PROGRAMS, 'Microsoft VS Code', 'bin', 'code.cmd')],
    command: 'code',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    paths: [join(LOCAL, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')],
    command: 'cursor',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    paths: [join(LOCAL, 'Programs', 'Windsurf', 'bin', 'windsurf.cmd')],
    command: 'windsurf',
  },
];

function onPath(command: string): string | null {
  try {
    return execFileSync('where.exe', [`${command}.cmd`], { windowsHide: true, encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function detectEditors(): EditorInfo[] {
  return [
    ...KNOWN.map((e) => ({ id: e.id, name: e.name, command: e.paths.find((p) => existsSync(p)) ?? onPath(e.command) })),
    { id: 'custom' as const, name: 'Custom command', command: null },
  ];
}

/**
 * cmd.exe is needed for .cmd launchers; `/s` plus one outer pair of quotes keeps paths with spaces
 * (…\Antigravity IDE\bin\…) intact.
 */
function runCmdLine(commandLine: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const q = (value: string) => `"${value.replace(/"/g, '')}"`;

export async function openInEditor(settings: DesktopSettings, linuxPath: string): Promise<ActionResult> {
  if (settings.editor === 'custom') {
    const template = settings.customEditorCommand.trim();
    if (!template) return { ok: false, message: 'Set a custom editor command in Settings first.' };
    const line = template.replace(/\{path\}/g, q(linuxPath)).replace(/\{unc\}/g, q(toWslUnc(linuxPath)));
    await runCmdLine(line);
    return { ok: true, message: `Opening ${linuxPath}.` };
  }
  const editor = detectEditors().find((e) => e.id === settings.editor);
  if (!editor?.command) return { ok: false, message: `${editor?.name ?? 'The editor'} was not found. Pick another one in Settings.` };
  // Remote - WSL: the editor's server runs inside the distro, so extensions and terminals run on Linux.
  await runCmdLine(`${q(editor.command)} --remote wsl+${DISTRO} ${q(linuxPath)}`);
  return { ok: true, message: `Opening ${linuxPath} in ${editor.name}.` };
}
