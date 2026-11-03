import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Site, SiteEnv } from '@devkit/shared';
import { Daemon } from '../core/daemon';
import { ServicesStore } from '../core/services-store';
import { Dialogs } from './dialogs';
import { Icon } from './icon';

interface EnvLine {
  kind: 'pair' | 'other';
  text: string;
  key?: string;
  value?: string;
  quoted?: boolean;
  /** Trailing " # comment" on an unquoted value, kept as written. */
  comment?: string;
  /** Edited or added here; untouched lines are written back exactly as they were. */
  changed?: boolean;
}

const PAIR = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;
const SENSITIVE = /PASSWORD|SECRET|_KEY$|^APP_KEY$|TOKEN|PRIVATE|DSN/i;

/** Splits .env text into lines, keeping comments, blank lines and order. */
export function parseEnv(text: string): EnvLine[] {
  return text.split(/\r?\n/).map((line) => {
    const match = PAIR.exec(line);
    if (!match) return { kind: 'other', text: line };
    const raw = match[3] ?? '';
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw.lastIndexOf(quote) > 0) {
      const end = raw.lastIndexOf(quote);
      const inner = raw.slice(1, end);
      return { kind: 'pair', text: line, key: match[2], value: quote === '"' ? inner.replace(/\\"/g, '"') : inner, quoted: true, comment: raw.slice(end + 1) };
    }
    const hash = raw.search(/\s#/);
    return {
      kind: 'pair',
      text: line,
      key: match[2],
      value: (hash === -1 ? raw : raw.slice(0, hash)).trim(),
      quoted: false,
      comment: hash === -1 ? '' : raw.slice(hash),
    };
  });
}

export function serializeEnv(lines: EnvLine[]): string {
  return lines
    .map((line) => {
      if (line.kind !== 'pair' || !line.changed) return line.text;
      const value = line.value ?? '';
      const needsQuotes = line.quoted || /[\s#"'$\\]/.test(value);
      const encoded = needsQuotes ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
      return `${line.key}=${encoded}${line.comment ?? ''}`;
    })
    .join('\n');
}

/** View and edit a site's .env, as a table (secrets masked) or as raw text. */
@Component({
  selector: 'app-env-editor',
  imports: [FormsModule, Icon],
  template: `
    <div class="mx-auto max-w-5xl p-8">
      @if (env(); as e) {
        @if (!e.exists) {
          <div class="dk-card p-6 text-center">
            <p class="text-zinc-300">This project has no .env file yet.</p>
            <div class="mt-4 flex justify-center gap-2">
              @if (e.exampleExists) {
                <button class="dk-btn-primary" (click)="fromExample()">Create from .env.example</button>
              }
              <button class="dk-btn" (click)="createEmpty()">Create an empty .env</button>
            </div>
          </div>
        } @else {
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex overflow-hidden rounded-md border border-zinc-700 text-sm">
              <button class="px-3 py-1" [class]="mode() === 'table' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" (click)="switchMode('table')">Variables</button>
              <button class="px-3 py-1" [class]="mode() === 'raw' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" (click)="switchMode('raw')">Raw file</button>
            </div>
            @if (mode() === 'table') {
              <input class="dk-input w-56" [(ngModel)]="filter" placeholder="Filter variables" />
              <button class="dk-btn flex items-center gap-1" (click)="addVariable()"><app-icon name="plus" [size]="13" /> Variable</button>
            }
            <span class="flex-1"></span>
            <span class="font-mono text-xs text-zinc-500">{{ e.path }}</span>
            <button class="dk-btn" [disabled]="!dirty()" (click)="revert()">Revert</button>
            <button class="dk-btn-primary" [disabled]="!dirty() || saving()" (click)="save()">{{ saving() ? 'Saving…' : 'Save' }}</button>
          </div>
          @if (savedHint() && site().type === 'laravel') {
            <p class="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              Saved. If the app caches its config, clear it so the change is picked up:
              <button class="dk-btn" (click)="clearConfig()">php artisan config:clear</button>
            </p>
          }

          @if (mode() === 'table') {
            <div class="dk-card mt-4 overflow-hidden">
              @for (line of visibleLines(); track $index) {
                <div class="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-1.5 last:border-0">
                  <span class="w-72 shrink-0 truncate font-mono text-xs text-zinc-300" [title]="line.key ?? ''">{{ line.key }}</span>
                  @if (isSecret(line) && !revealed().has(line.key!)) {
                    <span class="flex-1 font-mono text-xs tracking-widest text-zinc-500">{{ line.value ? '••••••••' : '(empty)' }}</span>
                  } @else {
                    <input class="dk-input h-7 flex-1 font-mono text-xs" [ngModel]="line.value" (ngModelChange)="setValue(line, $event)" />
                  }
                  @if (isSecret(line)) {
                    <button class="text-zinc-500 hover:text-zinc-200" [title]="revealed().has(line.key!) ? 'Hide' : 'Show'" (click)="toggleReveal(line.key!)">
                      <app-icon [name]="revealed().has(line.key!) ? 'eyeOff' : 'eye'" [size]="14" />
                    </button>
                  } @else {
                    <span class="w-[14px]"></span>
                  }
                  <button class="text-zinc-600 hover:text-red-300" title="Remove" (click)="removeLine(line)"><app-icon name="trash" [size]="13" /></button>
                </div>
              } @empty {
                <p class="px-4 py-4 text-sm text-zinc-500">No variables{{ filter ? ' match' : '' }}.</p>
              }
            </div>
          } @else {
            <textarea class="mt-4 h-[60vh] w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-emerald-500"
              spellcheck="false" [ngModel]="raw()" (ngModelChange)="raw.set($event)"></textarea>
          }
        }
      } @else {
        <p class="text-sm text-zinc-500">{{ error() ?? 'Loading…' }}</p>
      }
    </div>
  `,
})
export class EnvEditor implements OnInit {
  readonly site = input.required<Site>();
  readonly saved = output<void>();

  private readonly daemon = inject(Daemon);
  private readonly services = inject(ServicesStore);
  private readonly dialogs = inject(Dialogs);

  protected readonly env = signal<SiteEnv | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly mode = signal<'table' | 'raw'>('table');
  protected readonly lines = signal<EnvLine[]>([]);
  protected readonly raw = signal('');
  protected readonly revealed = signal(new Set<string>());
  protected readonly saving = signal(false);
  protected readonly savedHint = signal(false);
  protected filter = '';

  /** The text as it would be saved now, from whichever view is active. */
  private readonly current = computed(() => (this.mode() === 'raw' ? this.raw() : serializeEnv(this.lines())));
  protected readonly dirty = computed(() => this.env()?.exists === true && this.current() !== this.env()!.content);

  ngOnInit(): void {
    void this.load();
  }

  protected visibleLines(): EnvLine[] {
    const q = this.filter.trim().toLowerCase();
    return this.lines().filter((l) => l.kind === 'pair' && (!q || l.key!.toLowerCase().includes(q) || (!this.isSecret(l) && (l.value ?? '').toLowerCase().includes(q))));
  }

  protected isSecret(line: EnvLine): boolean {
    return SENSITIVE.test(line.key ?? '');
  }

  protected toggleReveal(key: string): void {
    this.revealed.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected setValue(line: EnvLine, value: string): void {
    this.lines.update((lines) => lines.map((l) => (l === line ? { ...l, value, changed: true } : l)));
  }

  protected removeLine(line: EnvLine): void {
    this.lines.update((lines) => lines.filter((l) => l !== line));
  }

  protected async addVariable(): Promise<void> {
    const key = (await this.dialogs.prompt('New variable', { placeholder: 'MAIL_MAILER', confirmLabel: 'Add' }))?.toUpperCase();
    if (!key) return;
    if (!/^[A-Z_][A-Z0-9_.]*$/.test(key)) return void this.error.set('Variable names use letters, digits and _.');
    if (this.lines().some((l) => l.key === key)) return;
    this.lines.update((lines) => [...lines.filter((l, i) => !(i === lines.length - 1 && l.kind === 'other' && !l.text)), { kind: 'pair', text: '', key, value: '', changed: true }, { kind: 'other', text: '' }]);
  }

  protected switchMode(mode: 'table' | 'raw'): void {
    if (mode === this.mode()) return;
    if (mode === 'raw') this.raw.set(serializeEnv(this.lines()));
    else this.lines.set(parseEnv(this.raw()));
    this.mode.set(mode);
  }

  protected revert(): void {
    const content = this.env()?.content ?? '';
    this.lines.set(parseEnv(content));
    this.raw.set(content);
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    const result = await this.daemon.api<SiteEnv>({ method: 'PUT', path: `/api/sites/${this.site().id}/env`, body: { content: this.current() } });
    this.saving.set(false);
    if (!result.ok) return void this.error.set(result.error);
    this.apply(result.data);
    this.savedHint.set(true);
    this.saved.emit();
  }

  protected async clearConfig(): Promise<void> {
    await this.services.startJob(`/api/sites/${this.site().id}/artisan`, { command: 'config:clear' });
    this.savedHint.set(false);
  }

  protected async fromExample(): Promise<void> {
    const result = await this.daemon.api<SiteEnv>({ method: 'POST', path: `/api/sites/${this.site().id}/env/example` });
    if (result.ok) this.apply(result.data);
    else this.error.set(result.error);
  }

  protected async createEmpty(): Promise<void> {
    const result = await this.daemon.api<SiteEnv>({ method: 'PUT', path: `/api/sites/${this.site().id}/env`, body: { content: '' } });
    if (result.ok) this.apply(result.data);
    else this.error.set(result.error);
  }

  private async load(): Promise<void> {
    const result = await this.daemon.api<SiteEnv>({ method: 'GET', path: `/api/sites/${this.site().id}/env` });
    if (result.ok) this.apply(result.data);
    else this.error.set(result.error);
  }

  private apply(env: SiteEnv): void {
    this.env.set(env);
    this.lines.set(parseEnv(env.content));
    this.raw.set(env.content);
  }
}
