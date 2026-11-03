import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { FileEntry, FilePreview, ListFilesResponse, OpenTarget } from '@devkit/shared';
import { Dialogs } from '../components/dialogs';
import { Daemon } from '../core/daemon';
import { FilesApi, formatSize, joinPath } from '../core/files-api';

@Component({
  selector: 'app-files',
  imports: [FormsModule],
  host: { class: 'flex h-full flex-col' },
  template: `
    <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-6 py-3">
      <button class="dk-btn" title="Up" [disabled]="!listing()?.parent" (click)="go(listing()?.parent ?? '/')">↑</button>
      <button class="dk-btn" title="Home" (click)="go(listing()?.home)">~</button>
      <form class="min-w-64 flex-1" (ngSubmit)="go(pathInput)">
        <input class="dk-input w-full font-mono" name="path" [(ngModel)]="pathInput" autocomplete="off" />
      </form>
      <label class="flex items-center gap-1.5 text-xs text-zinc-400">
        <input type="checkbox" class="accent-emerald-500" [(ngModel)]="showHidden" name="hidden" /> Hidden
      </label>
      <button class="dk-btn" (click)="create('mkdir')">New folder</button>
      <button class="dk-btn" (click)="create('touch')">New file</button>
      <span class="mx-1 h-5 w-px bg-zinc-800"></span>
      <button class="dk-btn" [disabled]="!selectedEntry()" (click)="rename(selectedEntry()!)">Rename</button>
      <button class="dk-btn" [disabled]="!selectedEntry()" (click)="chmod(selectedEntry()!)">Chmod</button>
      <button class="dk-btn dk-btn-danger" [disabled]="!selectedEntry()" (click)="remove(selectedEntry()!)">Delete</button>
      <span class="mx-1 h-5 w-px bg-zinc-800"></span>
      <button class="dk-btn" (click)="open('editor', selectedPath())">Open in editor</button>
      <button class="dk-btn" (click)="open('explorer', listing()?.path)">Explorer</button>
      <button class="dk-btn" (click)="open('terminal', listing()?.path)">Terminal</button>
    </div>

    @if (notice(); as n) {
      <div class="flex items-start justify-between gap-4 border-b px-6 py-2 text-sm"
        [class]="n.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'">
        <span>{{ n.message }}</span>
        <button class="opacity-70 hover:opacity-100" (click)="notice.set(null)">Dismiss</button>
      </div>
    }

    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1 overflow-y-auto">
        <!-- Fixed layout: the side columns keep their widths and the name column gets the rest. -->
        <table class="w-full table-fixed text-sm">
          <thead class="sticky top-0 bg-zinc-950 text-left text-xs text-zinc-500">
            <tr>
              <th class="px-6 py-2 font-normal">Name</th>
              <th class="w-20 px-2 py-2 text-right font-normal">Size</th>
              <th class="w-36 px-2 py-2 font-normal">Modified</th>
              <th class="w-14 px-2 py-2 font-normal">Mode</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of visible(); track entry.name) {
              <tr class="cursor-default border-t border-zinc-900 hover:bg-zinc-900"
                [class.bg-zinc-800]="selected() === entry.name" (click)="select(entry)" (dblclick)="activate(entry)">
                <td class="px-6 py-1.5">
                  <div class="flex items-center gap-2">
                    <span class="w-4 shrink-0 text-center text-zinc-500">{{ icon(entry) }}</span>
                    <span class="truncate" [title]="entry.name" [class.text-sky-300]="entry.type === 'dir'" [class.italic]="entry.type === 'link'">
                      {{ entry.name }}
                    </span>
                  </div>
                </td>
                <td class="px-2 py-1.5 text-right text-xs text-zinc-500">{{ entry.type === 'dir' ? '' : size(entry.size) }}</td>
                <td class="px-2 py-1.5 text-xs text-zinc-500">{{ date(entry.modified) }}</td>
                <td class="px-2 py-1.5 font-mono text-xs text-zinc-500" [title]="entry.owner">{{ entry.mode }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="px-6 py-6 text-sm text-zinc-500">{{ loading() ? 'Loading…' : 'Empty folder' }}</td></tr>
            }
          </tbody>
        </table>
      </div>

      @if (preview(); as p) {
        <aside class="flex w-[38%] min-w-72 flex-col border-l border-zinc-800">
          <header class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
            <span class="min-w-0 flex-1 truncate font-mono text-xs" [title]="p.path">{{ p.path }}</span>
            <span class="text-xs text-zinc-500">{{ size(p.size) }}</span>
            <button class="text-xs text-zinc-400 hover:text-white" (click)="open('editor', p.path)">Edit</button>
            <button class="text-xs text-zinc-400 hover:text-white" (click)="preview.set(null)">✕</button>
          </header>
          <div class="min-h-0 flex-1 overflow-auto">
            @switch (p.kind) {
              @case ('text') {
                <pre class="px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-300">{{ p.text }}</pre>
              }
              @case ('image') {
                <img class="m-4 max-w-[calc(100%-2rem)] rounded border border-zinc-800 bg-zinc-900" [src]="p.dataUrl" [alt]="p.path" />
              }
              @case ('binary') {
                <p class="p-4 text-sm text-zinc-500">Binary file, no preview.</p>
              }
              @case ('too-large') {
                <p class="p-4 text-sm text-zinc-500">Too large to preview here. Open it in VS Code.</p>
              }
            }
          </div>
        </aside>
      }
    </div>
  `,
})
export class Files implements OnInit {
  private readonly daemon = inject(Daemon);
  private readonly files = inject(FilesApi);
  private readonly dialogs = inject(Dialogs);

  protected readonly listing = signal<ListFilesResponse | null>(null);
  protected readonly selected = signal<string | null>(null);
  protected readonly preview = signal<FilePreview | null>(null);
  protected readonly loading = signal(false);
  protected readonly notice = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly hidden = signal(false);
  protected pathInput = '';

  protected get showHidden(): boolean {
    return this.hidden();
  }
  protected set showHidden(value: boolean) {
    this.hidden.set(value);
  }

  protected readonly visible = computed(() => {
    const entries = this.listing()?.entries ?? [];
    return this.hidden() ? entries : entries.filter((e) => !e.name.startsWith('.'));
  });

  protected readonly selectedEntry = computed(() => this.listing()?.entries.find((e) => e.name === this.selected()) ?? null);

  protected readonly size = formatSize;

  ngOnInit(): void {
    void this.go(undefined);
  }

  protected selectedPath(): string | undefined {
    const listing = this.listing();
    if (!listing) return undefined;
    const name = this.selected();
    return name ? joinPath(listing.path, name) : listing.path;
  }

  protected icon(entry: FileEntry): string {
    return entry.type === 'dir' ? '▸' : entry.type === 'link' ? '↪' : '·';
  }

  protected date(ms: number): string {
    return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
  }

  protected async go(path: string | undefined): Promise<void> {
    this.loading.set(true);
    const result = await this.files.list(path?.trim() || undefined);
    this.loading.set(false);
    if (!result.ok) {
      this.notice.set({ ok: false, message: result.error });
      this.pathInput = this.listing()?.path ?? '';
      return;
    }
    this.listing.set(result.data);
    this.pathInput = result.data.path;
    this.selected.set(null);
    this.preview.set(null);
  }

  protected async select(entry: FileEntry): Promise<void> {
    this.selected.set(entry.name);
    if (entry.type !== 'file') return this.preview.set(null);
    const result = await this.files.preview(joinPath(this.listing()!.path, entry.name));
    if (result.ok) this.preview.set(result.data);
    else this.notice.set({ ok: false, message: result.error });
  }

  protected activate(entry: FileEntry): void {
    const path = joinPath(this.listing()!.path, entry.name);
    if (entry.type === 'dir' || entry.type === 'link') void this.go(path);
    else void this.open('editor', path);
  }

  protected async create(op: 'mkdir' | 'touch'): Promise<void> {
    const name = await this.dialogs.prompt(op === 'mkdir' ? 'New folder' : 'New file', { placeholder: 'name', confirmLabel: 'Create' });
    if (!name || !this.listing()) return;
    await this.mutate(op, { path: joinPath(this.listing()!.path, name) }, `Created ${name}.`);
  }

  protected async rename(entry: FileEntry): Promise<void> {
    const name = await this.dialogs.prompt(`Rename ${entry.name}`, { value: entry.name, confirmLabel: 'Rename' });
    if (!name || name === entry.name) return;
    const dir = this.listing()!.path;
    await this.mutate('rename', { path: joinPath(dir, entry.name), to: joinPath(dir, name) }, `Renamed to ${name}.`);
  }

  protected async chmod(entry: FileEntry): Promise<void> {
    const mode = await this.dialogs.prompt(`Permissions for ${entry.name}`, {
      value: entry.mode,
      message: 'Octal mode, e.g. 644 for files or 755 for folders and scripts.',
      confirmLabel: 'Apply',
    });
    if (!mode || mode === entry.mode) return;
    await this.mutate('chmod', { path: joinPath(this.listing()!.path, entry.name), mode }, `${entry.name} is now ${mode}.`);
  }

  protected async remove(entry: FileEntry): Promise<void> {
    const what = entry.type === 'dir' ? `the folder ${entry.name} and everything in it` : entry.name;
    if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
    await this.mutate('delete', { path: joinPath(this.listing()!.path, entry.name) }, `Deleted ${entry.name}.`);
  }

  protected async open(target: OpenTarget, path: string | undefined): Promise<void> {
    if (!path) return;
    const result = await this.daemon.windows.openPath(target, path);
    if (!result.ok) this.notice.set(result);
  }

  private async mutate(op: 'mkdir' | 'touch' | 'rename' | 'delete' | 'chmod', body: { path: string; to?: string; mode?: string }, done: string): Promise<void> {
    const result = await this.files.op(op, body);
    this.notice.set(result.ok ? { ok: true, message: done } : { ok: false, message: result.error });
    const keep = this.listing()?.path;
    await this.go(keep);
  }
}
