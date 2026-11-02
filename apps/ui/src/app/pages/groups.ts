import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  Group,
  GroupActionResult,
  GroupsResponse,
  ProcessAction,
  ProcessesResponse,
  Site,
  SiteProcess,
  SitesResponse,
} from '@devkit/shared';
import { ConsoleView } from '../components/console-view';
import { Daemon } from '../core/daemon';

const MAX_LOG_LINES = 2000;

@Component({
  selector: 'app-groups',
  imports: [FormsModule, ConsoleView],
  template: `
    <div class="mx-auto max-w-5xl p-8">
      <h1 class="text-2xl font-semibold">Groups</h1>
      <p class="mt-1 text-sm text-zinc-400">
        Keep related sites together (an API and its front end) and start, stop or watch them as one.
      </p>

      @if (notice(); as n) {
        <p class="mt-4 rounded-lg border p-3 text-sm whitespace-pre-wrap"
          [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'">
          {{ n.message }}
        </p>
      }

      <form class="mt-6 flex gap-2" (ngSubmit)="create()">
        <input class="dk-input w-72" name="name" [(ngModel)]="newName" placeholder="New group, e.g. Zoon OMS" autocomplete="off" />
        <button class="dk-btn-primary" type="submit" [disabled]="busy() || !newName.trim()">Create group</button>
      </form>

      @for (group of groups(); track group.id) {
        <section class="dk-card mt-6 overflow-hidden">
          <header class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
            <h2 class="flex-1 font-medium">{{ group.name }}</h2>
            <span class="text-xs text-zinc-500">{{ running(group) }} of {{ processesOf(group).length }} processes running</span>
            <button class="dk-btn" [disabled]="busy()" (click)="act(group, 'start')">Start all</button>
            <button class="dk-btn" [disabled]="busy()" (click)="act(group, 'stop')">Stop all</button>
            <button class="dk-btn" [disabled]="busy()" (click)="act(group, 'restart')">Restart all</button>
            <button class="dk-btn" [disabled]="!group.siteIds.length" (click)="openAll(group)">Open sites</button>
            <button class="dk-btn" [class.bg-zinc-800]="logGroup() === group.id" (click)="toggleLogs(group)">Logs</button>
            <button class="dk-btn" title="Rename" (click)="rename(group)">✎</button>
            <button class="dk-btn dk-btn-danger" title="Delete group (sites stay)" (click)="remove(group)">✕</button>
          </header>
          <div class="divide-y divide-zinc-800/60">
            @for (site of sitesOf(group); track site.id) {
              <div class="flex items-center gap-3 px-4 py-2 text-sm">
                <a class="flex-1 text-emerald-300 hover:underline" [href]="'https://' + site.domain" target="_blank">{{ site.domain }}</a>
                <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{{ site.type }}</span>
                <span class="w-36 text-right text-xs text-zinc-500">{{ processSummary(site) }}</span>
                <button class="text-xs text-zinc-500 hover:text-red-300" title="Remove from group" (click)="assign(site, null)">✕</button>
              </div>
            } @empty {
              <p class="px-4 py-3 text-sm text-zinc-500">No sites in this group yet.</p>
            }
          </div>
          @if (ungrouped().length) {
            <div class="flex items-center gap-2 border-t border-zinc-800 px-4 py-2">
              <select #pick class="dk-input">
                @for (site of ungrouped(); track site.id) {
                  <option [value]="site.id">{{ site.domain }}</option>
                }
              </select>
              <button class="dk-btn" (click)="assignById(pick.value, group.id)">Add to group</button>
            </div>
          }
          @if (logGroup() === group.id) {
            <app-console-view class="h-72 border-t border-zinc-800" [lines]="logLines()" placeholder="Waiting for output…" />
          }
        </section>
      } @empty {
        <p class="mt-6 text-sm text-zinc-500">No groups yet.</p>
      }

      @if (groups().length && ungrouped().length) {
        <h2 class="mt-8 mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Ungrouped sites</h2>
        <p class="text-sm text-zinc-400">{{ ungroupedNames() }}</p>
      }
    </div>
  `,
})
export class Groups implements OnInit {
  private readonly daemon = inject(Daemon);

  protected readonly groups = signal<Group[]>([]);
  protected readonly sites = signal<Site[]>([]);
  protected readonly processes = signal<SiteProcess[]>([]);
  protected readonly busy = signal(false);
  protected readonly notice = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly logGroup = signal<string | null>(null);
  protected readonly logLines = signal<string[]>([]);
  protected newName = '';

  protected readonly ungrouped = computed(() => {
    const grouped = new Set(this.groups().flatMap((g) => g.siteIds));
    return this.sites().filter((s) => !grouped.has(s.id));
  });
  protected readonly ungroupedNames = computed(() => this.ungrouped().map((s) => s.domain).join(', '));

  constructor() {
    const subscription = this.daemon.events.subscribe((event) => {
      if (event.type === 'processes') this.processes.set(event.processes);
      if (event.type === 'group-log' && event.groupId === this.logGroup()) {
        this.logLines.update((lines) => [...lines, ...event.lines].slice(-MAX_LOG_LINES));
      }
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      if (this.logGroup()) this.daemon.send({ type: 'logs.unsubscribe' });
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected sitesOf(group: Group): Site[] {
    return this.sites().filter((s) => group.siteIds.includes(s.id));
  }

  protected processesOf(group: Group): SiteProcess[] {
    return this.processes().filter((p) => group.siteIds.includes(p.siteId));
  }

  protected running(group: Group): number {
    return this.processesOf(group).filter((p) => p.active === 'active').length;
  }

  protected processSummary(site: Site): string {
    const own = this.processes().filter((p) => p.siteId === site.id);
    if (!own.length) return 'no processes';
    return `${own.filter((p) => p.active === 'active').length}/${own.length} running`;
  }

  protected async create(): Promise<void> {
    await this.call(async () => {
      const result = await this.daemon.api<Group>({ method: 'POST', path: '/api/groups', body: { name: this.newName } });
      if (!result.ok) return this.notice.set({ ok: false, message: result.error });
      this.newName = '';
      await this.load();
    });
  }

  protected async rename(group: Group): Promise<void> {
    const name = prompt('Group name', group.name)?.trim();
    if (!name || name === group.name) return;
    await this.call(async () => {
      const result = await this.daemon.api<Group>({ method: 'PATCH', path: `/api/groups/${group.id}`, body: { name } });
      if (!result.ok) this.notice.set({ ok: false, message: result.error });
      await this.load();
    });
  }

  protected async remove(group: Group): Promise<void> {
    if (!confirm(`Delete the group "${group.name}"? Its sites stay as they are.`)) return;
    if (this.logGroup() === group.id) this.toggleLogs(group);
    await this.call(async () => {
      await this.daemon.api({ method: 'DELETE', path: `/api/groups/${group.id}` });
      await this.load();
    });
  }

  protected assignById(siteId: string, groupId: string): Promise<void> {
    const site = this.sites().find((s) => s.id === siteId);
    return site ? this.assign(site, groupId) : Promise.resolve();
  }

  protected async assign(site: Site, groupId: string | null): Promise<void> {
    await this.call(async () => {
      const result = await this.daemon.api<GroupsResponse>({ method: 'PUT', path: `/api/sites/${site.id}/group`, body: { groupId } });
      if (result.ok) this.groups.set(result.data.groups);
      else this.notice.set({ ok: false, message: result.error });
    });
  }

  protected async act(group: Group, action: ProcessAction): Promise<void> {
    await this.call(async () => {
      const result = await this.daemon.api<GroupActionResult>({ method: 'POST', path: `/api/groups/${group.id}/${action}` });
      if (!result.ok) return this.notice.set({ ok: false, message: result.error });
      const { processes, failed } = result.data;
      this.notice.set(
        failed.length
          ? { ok: false, message: `${processes - failed.length} of ${processes} processes: ${action} ok.\n${failed.join('\n')}` }
          : { ok: true, message: processes ? `${group.name}: ${action} sent to ${processes} processes.` : `${group.name} has no processes to ${action}.` },
      );
      await this.loadProcesses();
    });
  }

  protected openAll(group: Group): void {
    for (const site of this.sitesOf(group)) window.open(`https://${site.domain}`, '_blank');
  }

  protected toggleLogs(group: Group): void {
    this.logLines.set([]);
    if (this.logGroup() === group.id) {
      this.logGroup.set(null);
      this.daemon.send({ type: 'logs.unsubscribe' });
    } else {
      this.logGroup.set(group.id);
      this.daemon.send({ type: 'group-logs.subscribe', groupId: group.id });
    }
  }

  private async call(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      await work();
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    const [groups, sites] = await Promise.all([
      this.daemon.api<GroupsResponse>({ method: 'GET', path: '/api/groups' }),
      this.daemon.api<SitesResponse>({ method: 'GET', path: '/api/sites' }),
      this.loadProcesses(),
    ]);
    if (groups.ok) this.groups.set(groups.data.groups);
    if (sites.ok) this.sites.set(sites.data.sites);
  }

  private async loadProcesses(): Promise<void> {
    const result = await this.daemon.api<ProcessesResponse>({ method: 'GET', path: '/api/processes' });
    if (result.ok) this.processes.set(result.data.processes);
  }
}
