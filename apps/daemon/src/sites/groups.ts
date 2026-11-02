import { randomUUID } from 'node:crypto';
import type { Group, GroupActionResult, ProcessAction } from '@devkit/shared';
import { HttpError } from '../http-error.ts';
import type { Store } from '../store.ts';
import { processAction, unitName } from './processes.ts';

function validName(name: unknown): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.length > 60) throw new HttpError(422, 'Give the group a name (up to 60 characters)');
  return trimmed;
}

export function requireGroup(store: Store, id: string): Group {
  const group = store.getGroup(id);
  if (!group) throw new HttpError(404, 'Unknown group');
  return group;
}

export function createGroup(store: Store, name: unknown): Group {
  const groupName = validName(name);
  if (store.findGroupByName(groupName)) throw new HttpError(409, `A group named "${groupName}" already exists`);
  const id = randomUUID();
  store.insertGroup(id, groupName);
  return store.getGroup(id)!;
}

export function renameGroup(store: Store, id: string, name: unknown): Group {
  requireGroup(store, id);
  const groupName = validName(name);
  const clash = store.findGroupByName(groupName);
  if (clash && clash.id !== id) throw new HttpError(409, `A group named "${groupName}" already exists`);
  store.renameGroup(id, groupName);
  return store.getGroup(id)!;
}

export function assignSite(store: Store, siteId: string, groupId: string | null): void {
  if (!store.getSite(siteId)) throw new HttpError(404, 'Unknown site');
  if (groupId !== null) requireGroup(store, groupId);
  store.setSiteGroup(siteId, groupId);
}

/** Runs the action on every process of every site in the group; one failure does not stop the rest. */
export async function groupAction(store: Store, id: string, action: ProcessAction): Promise<GroupActionResult> {
  const group = requireGroup(store, id);
  const processes = store.listProcesses().filter((p) => group.siteIds.includes(p.siteId));
  const failed: string[] = [];
  for (const process of processes) {
    try {
      await processAction(process.id, action);
    } catch (e) {
      failed.push(`${store.getSite(process.siteId)?.domain ?? '?'} ${process.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { processes: processes.length, failed };
}

/** Units of the group's processes, each with the label its log lines get ("lv-oms.test · Horizon"). */
export function groupUnits(store: Store, id: string): Map<string, string> {
  const group = requireGroup(store, id);
  const units = new Map<string, string>();
  for (const process of store.listProcesses()) {
    if (!group.siteIds.includes(process.siteId)) continue;
    units.set(unitName(process.id), `${store.getSite(process.siteId)?.domain ?? '?'} · ${process.name}`);
  }
  return units;
}

/** Turns `journalctl -o json` lines into "[label] message" lines. */
export function formatJournalJson(line: string, labels: Map<string, string>): string | null {
  try {
    const entry = JSON.parse(line) as { _SYSTEMD_UNIT?: string; UNIT?: string; MESSAGE?: unknown };
    if (typeof entry.MESSAGE !== 'string') return null;
    // systemd's own messages about a unit (Started/Stopped) come from init.scope and name the unit in UNIT.
    const unit = entry.UNIT ?? entry._SYSTEMD_UNIT ?? '';
    return `[${labels.get(unit) ?? unit}] ${entry.MESSAGE}`;
  } catch {
    return null;
  }
}
