import { existsSync, readFileSync } from 'node:fs';
import { PHP_VERSIONS, type SystemResources } from '@devkit/shared';
import { run } from './exec.ts';
import type { JobContext } from './jobs.ts';
import { installNode, listNodeVersions, nodeBinDir } from './node/fnm.ts';
import { findService } from './services/catalog.ts';
import { installService, listServices } from './services/services.ts';
import { COMPOSER_BIN, installComposer } from './tools/composer.ts';
import { changeGlobal } from './tools/npm-globals.ts';

/** What a Laravel + Angular machine needs; the newest PHP comes with Laravel's usual extensions. */
export const RECOMMENDED_SERVICES = ['nginx', `php${PHP_VERSIONS.at(-1)}`, 'mysql', 'redis'];

/** Installs whatever of the recommended stack is missing, in one job; installed parts are skipped. */
export async function installRecommendedStack(ctx: JobContext, user: string): Promise<void> {
  const installed = new Set((await listServices()).filter((s) => s.installed).map((s) => s.id));
  for (const id of RECOMMENDED_SERVICES) {
    const def = findService(id)!;
    if (installed.has(id)) {
      ctx.log(`✓ ${def.name} is already installed`);
      continue;
    }
    ctx.log(`== ${def.name}`);
    await installService(def, ctx);
  }
  if (existsSync(COMPOSER_BIN)) ctx.log('✓ Composer is already installed');
  else {
    ctx.log('== Composer');
    await installComposer(ctx, user);
  }
  if (listNodeVersions(user).length) ctx.log('✓ Node.js is already installed');
  else {
    ctx.log('== Node.js (LTS)');
    await installNode(ctx, user, 'lts');
  }
  const node = listNodeVersions(user)[0];
  if (node && existsSync(`${nodeBinDir(user, node)}/ng`)) {
    ctx.log(`✓ Angular CLI is already installed (Node ${node})`);
  } else if (node) {
    ctx.log('== Angular CLI');
    await changeGlobal(ctx, user, node, '@angular/cli', 'install');
  }
  ctx.log('The recommended stack is ready.');
}

/** Parses /proc/meminfo (kB values). */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } {
  const value = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) * 1024;
  return { totalBytes: value('MemTotal'), availableBytes: value('MemAvailable') };
}

export async function systemResources(): Promise<SystemResources> {
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const load = read('/proc/loadavg').split(' ').slice(0, 3).map(Number) as [number, number, number];
  const df = (await run(['df', '-B1', '--output=size,avail', '/'])).stdout.trim().split('\n')[1]?.trim().split(/\s+/) ?? [];
  const cpus = (read('/proc/cpuinfo').match(/^processor\s*:/gm) ?? []).length || 1;
  return {
    memory: parseMeminfo(read('/proc/meminfo')),
    cpus,
    load: [load[0] || 0, load[1] || 0, load[2] || 0],
    disk: { totalBytes: Number(df[0]) || 0, freeBytes: Number(df[1]) || 0 },
    uptimeSec: Math.round(Number(read('/proc/uptime').split(' ')[0]) || 0),
  };
}
