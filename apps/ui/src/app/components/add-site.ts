import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { validateDomain, type CreateSiteRequest, type CreateSiteResponse, type DetectResult, type SiteType } from '@devkit/shared';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';
import { ConsoleView } from './console-view';
import { FolderPicker } from './folder-picker';

const TYPE_LABELS: Record<SiteType, string> = { laravel: 'Laravel', angular: 'Angular', php: 'PHP', static: 'Static' };

/** Add a site from a folder: detect, fill in, and install anything the project needs that is missing. */
@Component({
  selector: 'app-add-site',
  imports: [FormsModule, FolderPicker, ConsoleView],
  template: `
    <div class="fixed inset-0 z-40 grid place-items-center bg-black/60 p-6" (click)="closed.emit()">
      <div class="dk-card flex max-h-[90vh] w-[44rem] flex-col overflow-hidden bg-zinc-900" (click)="$event.stopPropagation()">
        <header class="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 class="font-medium">Add a site</h2>
          <button class="text-zinc-400 hover:text-white" (click)="closed.emit()">✕</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-5">
          <form class="flex gap-2" (ngSubmit)="detect()">
            <input class="dk-input flex-1 font-mono" name="root" [(ngModel)]="root" placeholder="/home/you/projects/app" autocomplete="off" />
            <button class="dk-btn" type="button" (click)="picking.set(true)">Browse…</button>
            <button class="dk-btn" type="submit" [disabled]="busy() || !root.trim()">{{ busy() ? 'Working…' : 'Detect' }}</button>
          </form>
          @if (picking()) {
            <app-folder-picker [start]="root.trim() || undefined" (chosen)="picked($event)" (cancelled)="picking.set(false)" />
          }
          @if (error(); as e) {
            <p class="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-red-200">{{ e }}</p>
          }

          @if (detected(); as d) {
            <p class="mt-5 text-sm">
              Looks like a <span class="font-medium text-emerald-300">{{ labels[d.type] }}</span> project
              <span class="font-mono text-xs text-zinc-500">{{ d.root }}</span>
            </p>

            @if (missing(); as m) {
              <div class="mt-3 flex items-center gap-3 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
                <span class="flex-1">{{ m.label }}</span>
                <button class="dk-btn-primary" [disabled]="installing()" (click)="installMissing(m.path, m.body)">
                  {{ installing() ? 'Installing…' : 'Install it' }}
                </button>
              </div>
            }
            @for (warning of otherWarnings(); track warning) {
              <p class="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{{ warning }}</p>
            }

            <div class="mt-4 grid gap-3 sm:grid-cols-3">
              <label class="text-xs text-zinc-400">Domain
                <input class="dk-input mt-1 w-full" name="domain" [(ngModel)]="domain" autocomplete="off" />
              </label>
              <label class="text-xs text-zinc-400">Type
                <select class="dk-input mt-1 w-full" name="type" [(ngModel)]="type">
                  @for (t of types; track t) {
                    <option [value]="t">{{ labels[t] }}</option>
                  }
                </select>
              </label>
              @if (type === 'laravel' || type === 'php') {
                <label class="text-xs text-zinc-400">PHP{{ d.phpConstraint ? ' (needs ' + d.phpConstraint + ')' : '' }}
                  <select class="dk-input mt-1 w-full" name="php" [(ngModel)]="phpVersion">
                    @for (v of d.installedPhpVersions; track v) {
                      <option [value]="v">PHP {{ v }}</option>
                    } @empty {
                      <option value="" disabled>None installed</option>
                    }
                  </select>
                </label>
              } @else if (type === 'angular') {
                <label class="text-xs text-zinc-400">Node{{ d.nodeRequirement ? ' (needs ' + d.nodeRequirement + ')' : '' }}
                  <select class="dk-input mt-1 w-full" name="node" [(ngModel)]="nodeVersion">
                    @for (v of d.installedNodeVersions; track v) {
                      <option [value]="v">Node {{ v }}</option>
                    } @empty {
                      <option value="" disabled>None installed</option>
                    }
                  </select>
                </label>
              }
            </div>
            @if (type === 'laravel' && d.database; as db) {
              <label class="mt-3 flex items-center gap-2 text-sm" [class.opacity-50]="!d.mysqlInstalled">
                <input type="checkbox" class="accent-emerald-500" name="db" [(ngModel)]="createDatabase" [disabled]="!d.mysqlInstalled" />
                Create MySQL database <span class="font-mono">{{ db.name }}</span> for <span class="font-mono">{{ db.username }}</span>
              </label>
            }
          }

          @if (job(); as j) {
            <app-console-view class="mt-4 h-48 overflow-hidden rounded-md border border-zinc-800" [lines]="j.output" />
          }
        </div>
        @if (detected()) {
          <footer class="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
            <button class="dk-btn" (click)="closed.emit()">Cancel</button>
            <button class="dk-btn-primary" [disabled]="busy() || installing() || !canCreate()" (click)="create()">Create {{ domain }}</button>
          </footer>
        }
      </div>
    </div>
  `,
})
export class AddSite {
  private readonly daemon = inject(Daemon);
  private readonly store = inject(ServicesStore);

  readonly created = output<{ domain: string; notes: string[] }>();
  readonly closed = output<void>();

  protected readonly labels = TYPE_LABELS;
  protected readonly types: SiteType[] = ['laravel', 'angular', 'php', 'static'];
  protected readonly picking = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly detected = signal<DetectResult | null>(null);
  private readonly jobId = signal<string | null>(null);
  protected readonly job = computed(() => this.store.job(this.jobId() ?? undefined));
  protected readonly installing = computed(() => ['queued', 'running'].includes(this.job()?.status ?? ''));
  protected root = '';
  protected domain = '';
  protected type: SiteType = 'static';
  protected phpVersion = '';
  protected nodeVersion = '';
  protected createDatabase = true;

  /** The one thing to install before the site can be created, if any. */
  protected readonly missing = computed<{ label: string; path: string; body?: unknown } | null>(() => {
    const d = this.detected();
    if (!d) return null;
    if ((d.type === 'laravel' || d.type === 'php') && !d.phpVersion && d.phpSuggested) {
      return { label: `This project needs PHP ${d.phpSuggested}, which is not installed yet.`, path: `/api/services/php${d.phpSuggested}/install` };
    }
    if (d.type === 'angular' && !d.nodeVersion) {
      return { label: 'This project needs Node.js, which is not installed yet.', path: '/api/node/install', body: { version: 'lts' } };
    }
    return null;
  });
  protected readonly otherWarnings = computed(() =>
    (this.detected()?.warnings ?? []).filter((w) => !/is not installed|no installed version|Install (it|PHP|one) on/.test(w)),
  );

  constructor() {
    // After an install finishes, detect again so the new version shows up and gets selected.
    effect(() => {
      const status = this.job()?.status;
      if (status === 'succeeded') untracked(() => void this.detect());
    });
  }

  protected picked(path: string): void {
    this.picking.set(false);
    this.root = path;
    void this.detect();
  }

  protected canCreate(): boolean {
    if (validateDomain(this.domain.trim())) return false;
    if (this.type === 'laravel' || this.type === 'php') return !!this.phpVersion;
    if (this.type === 'angular') return !!this.nodeVersion;
    return true;
  }

  protected async detect(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const result = await this.daemon.api<DetectResult>({ method: 'POST', path: '/api/sites/detect', body: { root: this.root.trim() } });
    this.busy.set(false);
    if (!result.ok) return this.error.set(result.error);
    const d = result.data;
    const first = !this.detected() || this.detected()!.root !== d.root;
    this.detected.set(d);
    this.root = d.root;
    if (first) {
      this.domain = d.domain;
      this.type = d.type;
      this.createDatabase = d.mysqlInstalled;
    }
    this.phpVersion = d.phpVersion ?? d.installedPhpVersions.at(-1) ?? '';
    this.nodeVersion = d.nodeVersion ?? d.installedNodeVersions[0] ?? '';
  }

  protected async installMissing(path: string, body?: unknown): Promise<void> {
    this.error.set(null);
    const id = await this.store.startJob(path, body);
    if (id) this.jobId.set(id);
    else this.error.set(this.store.error());
  }

  protected async create(): Promise<void> {
    const request: CreateSiteRequest = {
      domain: this.domain.trim().toLowerCase(),
      root: this.root.trim(),
      type: this.type,
      phpVersion: this.type === 'laravel' || this.type === 'php' ? this.phpVersion : null,
      nodeVersion: this.type === 'angular' ? this.nodeVersion : null,
      createDatabase: this.type === 'laravel' && this.createDatabase,
    };
    this.busy.set(true);
    const result = await this.daemon.api<CreateSiteResponse>({ method: 'POST', path: '/api/sites', body: request });
    this.busy.set(false);
    if (!result.ok) return this.error.set(result.error);
    this.created.emit({ domain: request.domain, notes: result.data.notes });
  }
}
