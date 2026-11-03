import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type {
  ActionResult,
  CreateProcessRequest,
  Group,
  GroupActionResult,
  GroupsResponse,
  InsightsResponse,
  OpenTarget,
  ProcessAction,
  ProcessesResponse,
  Site,
  SiteInsights,
  SiteProcess,
  SitesResponse,
} from '@devkit/shared';
import { Daemon } from './daemon';

/** Sites, their groups, processes and live usage, shared by the Sites, site details and Dashboard pages. */
@Injectable({ providedIn: 'root' })
export class SitesStore {
  private readonly daemon = inject(Daemon);

  readonly sites = signal<Site[]>([]);
  readonly groups = signal<Group[]>([]);
  readonly processes = signal<SiteProcess[]>([]);
  readonly insights = signal<SiteInsights[]>([]);
  readonly notice = signal<ActionResult | null>(null);

  readonly ungrouped = computed(() => {
    const grouped = new Set(this.groups().flatMap((g) => g.siteIds));
    return this.sites().filter((s) => !grouped.has(s.id));
  });

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      if (event.type === 'processes') this.processes.set(event.processes);
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  async load(): Promise<void> {
    const [sites, groups, processes] = await Promise.all([
      this.daemon.api<SitesResponse>({ method: 'GET', path: '/api/sites' }),
      this.daemon.api<GroupsResponse>({ method: 'GET', path: '/api/groups' }),
      this.daemon.api<ProcessesResponse>({ method: 'GET', path: '/api/processes' }),
      this.loadInsights(),
    ]);
    if (sites.ok) this.sites.set(sites.data.sites);
    if (groups.ok) this.groups.set(groups.data.groups);
    if (processes.ok) this.processes.set(processes.data.processes);
  }

  async loadInsights(): Promise<void> {
    const result = await this.daemon.api<InsightsResponse>({ method: 'GET', path: '/api/insights' });
    if (result.ok) this.insights.set(result.data.sites);
  }

  site(id: string): Site | undefined {
    return this.sites().find((s) => s.id === id);
  }

  sitesOf(group: Group): Site[] {
    return this.sites().filter((s) => group.siteIds.includes(s.id));
  }

  groupOf(siteId: string): Group | undefined {
    return this.groups().find((g) => g.siteIds.includes(siteId));
  }

  processesFor(siteId: string): SiteProcess[] {
    return this.processes().filter((p) => p.siteId === siteId);
  }

  insightsFor(siteId: string): SiteInsights | undefined {
    return this.insights().find((i) => i.siteId === siteId);
  }

  /** green: everything it runs is up; amber: something is starting or stopped; red: a process failed. */
  health(siteId: string): 'ok' | 'partial' | 'failed' | 'idle' {
    const own = this.processesFor(siteId);
    if (own.some((p) => p.active === 'failed')) return 'failed';
    if (own.length === 0) return 'idle';
    return own.every((p) => p.active === 'active') ? 'ok' : 'partial';
  }

  async processAction(process: SiteProcess, action: ProcessAction): Promise<void> {
    const result = await this.daemon.api({ method: 'POST', path: `/api/processes/${process.id}/${action}` });
    if (!result.ok) this.notice.set({ ok: false, message: `${process.name}: ${result.error}` });
    await this.refreshProcesses();
  }

  async setAutostart(process: SiteProcess, autostart: boolean): Promise<void> {
    const result = await this.daemon.api({ method: 'PATCH', path: `/api/processes/${process.id}`, body: { autostart } });
    if (!result.ok) this.notice.set({ ok: false, message: result.error });
    await this.refreshProcesses();
  }

  async addProcess(site: Site, request: CreateProcessRequest): Promise<boolean> {
    const result = await this.daemon.api<SiteProcess>({ method: 'POST', path: `/api/sites/${site.id}/processes`, body: request });
    this.notice.set(result.ok ? { ok: true, message: `${result.data.name} started for ${site.domain}.` } : { ok: false, message: result.error });
    await this.refreshProcesses();
    return result.ok;
  }

  async removeProcess(process: SiteProcess): Promise<void> {
    await this.daemon.api({ method: 'DELETE', path: `/api/processes/${process.id}` });
    await this.refreshProcesses();
  }

  async groupAction(group: Group, action: ProcessAction): Promise<void> {
    const result = await this.daemon.api<GroupActionResult>({ method: 'POST', path: `/api/groups/${group.id}/${action}` });
    if (!result.ok) return this.notice.set({ ok: false, message: result.error });
    const { processes, failed } = result.data;
    this.notice.set(
      failed.length
        ? { ok: false, message: `${processes - failed.length} of ${processes} processes: ${action} ok.\n${failed.join('\n')}` }
        : { ok: true, message: processes ? `${group.name}: ${action} sent to ${processes} processes.` : `${group.name} has no processes to ${action}.` },
    );
    await this.refreshProcesses();
  }

  async createGroup(name: string): Promise<Group | null> {
    const result = await this.daemon.api<Group>({ method: 'POST', path: '/api/groups', body: { name } });
    if (!result.ok) {
      this.notice.set({ ok: false, message: result.error });
      return null;
    }
    await this.load();
    return result.data;
  }

  async renameGroup(group: Group, name: string): Promise<void> {
    const result = await this.daemon.api({ method: 'PATCH', path: `/api/groups/${group.id}`, body: { name } });
    if (!result.ok) this.notice.set({ ok: false, message: result.error });
    await this.load();
  }

  async deleteGroup(group: Group): Promise<void> {
    await this.daemon.api({ method: 'DELETE', path: `/api/groups/${group.id}` });
    await this.load();
  }

  async assign(siteId: string, groupId: string | null): Promise<void> {
    const result = await this.daemon.api<GroupsResponse>({ method: 'PUT', path: `/api/sites/${siteId}/group`, body: { groupId } });
    if (result.ok) this.groups.set(result.data.groups);
    else this.notice.set({ ok: false, message: result.error });
  }

  async open(target: OpenTarget, path: string): Promise<void> {
    const result = await this.daemon.windows.openPath(target, path);
    if (!result.ok) this.notice.set(result);
  }

  openInBrowser(site: Site): void {
    window.open(`https://${site.domain}`, '_blank');
  }

  private async refreshProcesses(): Promise<void> {
    const result = await this.daemon.api<ProcessesResponse>({ method: 'GET', path: '/api/processes' });
    if (result.ok) this.processes.set(result.data.processes);
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
