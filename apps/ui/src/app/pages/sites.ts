import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Group, Site, SiteType } from '@devkit/shared';
import { AddSite } from '../components/add-site';
import { Dialogs } from '../components/dialogs';
import { Icon } from '../components/icon';
import { Daemon } from '../core/daemon';
import { SitesStore, formatBytes } from '../core/sites-store';

export const TYPE_LABELS: Record<SiteType, string> = { laravel: 'Laravel', angular: 'Angular', php: 'PHP', static: 'Static' };
export const HEALTH_DOT = { ok: 'bg-emerald-400', partial: 'bg-amber-400', failed: 'bg-red-500', idle: 'bg-zinc-500' } as const;

/** All sites, grouped, with live status and the actions you need most. Details open per site. */
@Component({
  selector: 'app-sites',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, AddSite, Icon],
  template: `
    <div class="mx-auto max-w-6xl p-8">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold">Sites</h1>
        <span class="text-sm text-zinc-500">{{ store.sites().length }}</span>
        <span class="flex-1"></span>
        <label class="relative">
          <app-icon class="absolute top-2 left-2.5 text-zinc-500" name="search" [size]="15" />
          <input class="dk-input w-56 pl-8" [(ngModel)]="query" placeholder="Filter sites" />
        </label>
        <button class="dk-btn flex items-center gap-1.5" (click)="newGroup()"><app-icon name="plus" [size]="14" /> Group</button>
        <button class="dk-btn-primary flex items-center gap-1.5" (click)="adding.set(true)"><app-icon name="plus" [size]="14" /> Add site</button>
      </div>

      @if (store.notice(); as n) {
        <div class="mt-4 flex items-start justify-between gap-4 rounded-lg border p-3 text-sm whitespace-pre-wrap"
          [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'">
          <span>{{ n.message }}</span>
          <button class="opacity-70 hover:opacity-100" (click)="store.notice.set(null)">Dismiss</button>
        </div>
      }

      @for (group of store.groups(); track group.id) {
        @if (visible(store.sitesOf(group)).length || !query) {
          <section class="dk-card mt-6 overflow-hidden">
            <header class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5">
              <button class="flex items-center gap-2 text-left" (click)="toggle(group.id)">
                <app-icon name="chevron" [size]="14" class="text-zinc-500 transition-transform" [class.rotate-90]="!collapsed().has(group.id)" />
                <span class="font-medium">{{ group.name }}</span>
              </button>
              <span class="text-xs text-zinc-500">{{ group.siteIds.length }} sites · {{ runningIn(group) }}</span>
              <span class="flex-1"></span>
              <button class="icon-btn" title="Start everything" (click)="store.groupAction(group, 'start')"><app-icon name="play" [size]="13" /></button>
              <button class="icon-btn" title="Stop everything" (click)="store.groupAction(group, 'stop')"><app-icon name="stop" [size]="13" /></button>
              <button class="icon-btn" title="Restart everything" (click)="store.groupAction(group, 'restart')"><app-icon name="restart" [size]="14" /></button>
              <button class="icon-btn" title="Open all sites" [disabled]="!group.siteIds.length" (click)="openAll(group)"><app-icon name="external" [size]="14" /></button>
              <button class="icon-btn" title="Rename" (click)="rename(group)"><app-icon name="pencil" [size]="14" /></button>
              <button class="icon-btn hover:text-red-300" title="Delete group (sites stay)" (click)="removeGroup(group)"><app-icon name="trash" [size]="14" /></button>
            </header>
            @if (!collapsed().has(group.id)) {
              <div class="divide-y divide-zinc-800/70">
                @for (site of visible(store.sitesOf(group)); track site.id) {
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: site }" />
                } @empty {
                  <p class="px-4 py-3 text-sm text-zinc-500">No sites in this group. Move one here from its Settings tab.</p>
                }
              </div>
            }
          </section>
        }
      }

      @if (visible(store.ungrouped()).length) {
        <section class="dk-card mt-6 overflow-hidden">
          @if (store.groups().length) {
            <header class="border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5 text-sm text-zinc-400">Ungrouped</header>
          }
          <div class="divide-y divide-zinc-800/70">
            @for (site of visible(store.ungrouped()); track site.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: site }" />
            }
          </div>
        </section>
      }

      @if (!store.sites().length) {
        <div class="mt-16 text-center">
          <p class="text-zinc-400">No sites yet.</p>
          <p class="mt-1 text-sm text-zinc-500">Add a project folder from WSL, or bring your EnvKit sites over.</p>
          <div class="mt-4 flex justify-center gap-2">
            <button class="dk-btn-primary" (click)="adding.set(true)">Add site</button>
            <a class="dk-btn" routerLink="/migrate">Migrate from EnvKit</a>
          </div>
        </div>
      }
    </div>

    <ng-template #row let-site>
      <div class="flex items-center gap-4 px-4 py-2.5 hover:bg-zinc-800/30">
        <span class="size-2 shrink-0 rounded-full" [class]="dot(site)" [title]="healthLabel(site)"></span>
        <a class="min-w-0 flex-1" [routerLink]="['/sites', site.id]">
          <div class="truncate font-medium hover:text-emerald-300">{{ site.domain }}</div>
          <div class="truncate font-mono text-xs text-zinc-500">{{ site.root }}</div>
        </a>
        <span class="w-16 shrink-0 text-center text-xs text-zinc-400">{{ typeLabel(site) }}</span>
        <span class="w-20 shrink-0 text-xs text-zinc-500">{{ version(site) }}</span>
        <span class="w-16 shrink-0 text-right text-xs text-zinc-500" title="Memory of its processes">{{ memory(site) }}</span>
        <span class="w-16 shrink-0 text-right text-xs text-zinc-500" title="Requests in the last hour">{{ requests(site) }}</span>
        <div class="flex shrink-0 gap-1">
          <button class="icon-btn" title="Open in the browser" (click)="store.openInBrowser(site)"><app-icon name="external" [size]="15" /></button>
          <button class="icon-btn" title="Open in your editor" (click)="store.open('editor', site.root)"><app-icon name="code" [size]="15" /></button>
          <button class="icon-btn" title="Terminal here" (click)="store.open('terminal', site.root)"><app-icon name="terminal" [size]="15" /></button>
          <a class="icon-btn" title="Details" [routerLink]="['/sites', site.id]"><app-icon name="chevron" [size]="15" /></a>
        </div>
      </div>
    </ng-template>

    @if (adding()) {
      <app-add-site (created)="created($event)" (closed)="adding.set(false)" />
    }
  `,
  styles: `
    .icon-btn {
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.375rem;
      color: var(--color-zinc-400);
    }
    .icon-btn:hover:not(:disabled) {
      background: var(--color-zinc-800);
      color: var(--color-zinc-100);
    }
    .icon-btn:disabled {
      opacity: 0.4;
    }
  `,
})
export class Sites implements OnInit {
  protected readonly store = inject(SitesStore);
  private readonly daemon = inject(Daemon);
  private readonly dialogs = inject(Dialogs);

  protected readonly labels = TYPE_LABELS;
  protected readonly adding = signal(false);
  protected readonly collapsed = signal(new Set<string>());
  protected query = '';

  constructor() {
    const timer = setInterval(() => void this.store.loadInsights(), 10_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  ngOnInit(): void {
    this.store.notice.set(null);
    void this.store.load();
  }

  protected visible(sites: Site[]): Site[] {
    const q = this.query.trim().toLowerCase();
    return q ? sites.filter((s) => s.domain.includes(q) || s.root.toLowerCase().includes(q)) : sites;
  }

  protected toggle(id: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected dot(site: Site): string {
    return HEALTH_DOT[this.store.health(site.id)];
  }

  protected healthLabel(site: Site): string {
    const own = this.store.processesFor(site.id);
    if (!own.length) return 'Served by nginx';
    return own.map((p) => `${p.name}: ${p.active}`).join('\n');
  }

  protected typeLabel(site: Site): string {
    return TYPE_LABELS[site.type];
  }

  protected version(site: Site): string {
    return site.phpVersion ? `PHP ${site.phpVersion}` : site.nodeVersion ? `Node ${site.nodeVersion.split('.')[0]}` : '';
  }

  protected memory(site: Site): string {
    const i = this.store.insightsFor(site.id);
    return i && i.memoryBytes ? formatBytes(i.memoryBytes) : '';
  }

  protected requests(site: Site): string {
    const i = this.store.insightsFor(site.id);
    return i ? `${i.requests.lastHour} req/h` : '';
  }

  protected runningIn(group: Group): string {
    const processes = this.store.processes().filter((p) => group.siteIds.includes(p.siteId));
    return processes.length ? `${processes.filter((p) => p.active === 'active').length}/${processes.length} running` : 'no processes';
  }

  protected openAll(group: Group): void {
    for (const site of this.store.sitesOf(group)) this.store.openInBrowser(site);
  }

  protected async newGroup(): Promise<void> {
    const name = await this.dialogs.prompt('New group', { placeholder: 'e.g. Zoon', confirmLabel: 'Create' });
    if (name) await this.store.createGroup(name);
  }

  protected async rename(group: Group): Promise<void> {
    const name = await this.dialogs.prompt('Rename group', { value: group.name, confirmLabel: 'Rename' });
    if (name && name !== group.name) await this.store.renameGroup(group, name);
  }

  protected async removeGroup(group: Group): Promise<void> {
    if (confirm(`Delete the group "${group.name}"? Its sites stay as they are.`)) await this.store.deleteGroup(group);
  }

  protected async created(event: { domain: string; notes: string[] }): Promise<void> {
    this.adding.set(false);
    await this.store.load();
    const hosts = await this.daemon.windows.syncHosts();
    const notes = event.notes.length ? `\n${event.notes.join('\n')}` : '';
    this.store.notice.set(
      hosts.ok ? { ok: true, message: `https://${event.domain} is ready.${notes}` } : { ok: false, message: `${event.domain} was created, but ${hosts.message}` },
    );
  }
}
