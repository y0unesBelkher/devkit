import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import type { ListFilesResponse } from '@devkit/shared';
import { FilesApi, joinPath } from '../core/files-api';

/** Modal that browses Linux folders (as the project user) and returns the chosen one. */
@Component({
  selector: 'app-folder-picker',
  template: `
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/60" (click)="cancelled.emit()">
      <div class="dk-card flex h-[70vh] w-[36rem] flex-col bg-zinc-900" (click)="$event.stopPropagation()">
        <header class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <button class="dk-btn" [disabled]="!listing()?.parent" (click)="go(listing()?.parent ?? '/')">↑</button>
          <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ listing()?.path }}</span>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto py-1">
          @for (dir of folders(); track dir) {
            <button class="block w-full px-4 py-1.5 text-left text-sm text-sky-300 hover:bg-zinc-800" (click)="go(joinPath(listing()!.path, dir))">
              ▸ {{ dir }}
            </button>
          } @empty {
            <p class="px-4 py-3 text-sm text-zinc-500">{{ error() ?? 'No sub-folders.' }}</p>
          }
        </div>
        <footer class="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button class="dk-btn" (click)="cancelled.emit()">Cancel</button>
          <button class="dk-btn-primary" [disabled]="!listing()" (click)="chosen.emit(listing()!.path)">Use this folder</button>
        </footer>
      </div>
    </div>
  `,
})
export class FolderPicker implements OnInit {
  private readonly files = inject(FilesApi);

  readonly start = input<string | undefined>(undefined);
  readonly chosen = output<string>();
  readonly cancelled = output<void>();

  protected readonly listing = signal<ListFilesResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly folders = computed(() =>
    (this.listing()?.entries ?? []).filter((e) => e.type === 'dir' && !e.name.startsWith('.')).map((e) => e.name),
  );
  protected readonly joinPath = joinPath;

  ngOnInit(): void {
    void this.go(this.start() || undefined);
  }

  protected async go(path: string | undefined): Promise<void> {
    const result = await this.files.list(path);
    if (result.ok) {
      this.listing.set(result.data);
      this.error.set(null);
    } else if (path) {
      // Typed path does not exist (yet): fall back to home.
      void this.go(undefined);
    } else {
      this.error.set(result.error);
    }
  }
}
