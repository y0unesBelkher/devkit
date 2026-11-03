import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ActionResult, DesktopSettings, EditorInfo, ListenMode, WindowsStatus } from '@devkit/shared';
import { Daemon } from '../core/daemon';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  template: `
    <div class="mx-auto max-w-3xl space-y-6 p-8">
      <h1 class="text-2xl font-semibold">Settings</h1>

      @if (notice(); as n) {
        <p class="rounded-lg border p-3 text-sm whitespace-pre-wrap"
          [class]="n.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200'">{{ n.message }}</p>
      }

      <!-- Editor -->
      @if (settings(); as s) {
        <section class="dk-card p-5">
          <h2 class="font-medium">Editor</h2>
          <p class="mt-1 text-sm text-zinc-400">"Editor" buttons open projects here, connected to WSL (Remote - WSL), so extensions and terminals run on Linux.</p>
          <div class="mt-4 space-y-2">
            @for (e of editors(); track e.id) {
              <label class="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 text-sm"
                [class.opacity-50]="e.id !== 'custom' && !e.command" [class.border-emerald-500]="s.editor === e.id">
                <input type="radio" name="editor" class="accent-emerald-500" [value]="e.id" [checked]="s.editor === e.id"
                  [disabled]="e.id !== 'custom' && !e.command" (change)="save({ editor: e.id })" />
                <span class="w-40 font-medium">{{ e.name }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{{ e.id === 'custom' ? 'any Windows command' : (e.command ?? 'not installed') }}</span>
              </label>
            }
          </div>
          @if (s.editor === 'custom') {
            <label class="mt-3 block text-xs text-zinc-400">
              Command — {{ '{' }}path{{ '}' }} is the Linux path, {{ '{' }}unc{{ '}' }} the \\\\wsl.localhost path
              <input class="dk-input mt-1 w-full font-mono" [ngModel]="s.customEditorCommand" (change)="save({ customEditorCommand: $any($event.target).value })"
                placeholder="C:\\Tools\\editor.exe {unc}" />
            </label>
          }
        </section>

        <!-- App -->
        <section class="dk-card p-5">
          <h2 class="font-medium">App</h2>
          <label class="mt-3 flex items-center gap-3 text-sm">
            <input type="checkbox" class="accent-emerald-500" [checked]="s.startWithWindows" (change)="save({ startWithWindows: !s.startWithWindows })" />
            Start DevKit with Windows (in the tray, without opening the window)
          </label>
          <label class="mt-2 flex items-center gap-3 text-sm">
            <input type="checkbox" class="accent-emerald-500" [checked]="s.closeToTray" (change)="save({ closeToTray: !s.closeToTray })" />
            Closing the window keeps DevKit running in the tray
          </label>
        </section>
      }

      <!-- Windows integration -->
      <section class="dk-card p-5">
        <h2 class="font-medium">Windows integration</h2>
        @if (status(); as w) {
          <div class="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <div class="text-xs text-zinc-500">Certificate authority</div>
              @if (w.ca?.trusted) { <div class="mt-1 text-sm text-emerald-300">Trusted by Windows</div> }
              @else {
                <div class="mt-1 text-sm text-amber-300">Not trusted</div>
                <button class="dk-btn-primary mt-2" [disabled]="busy()" (click)="act(daemon.windows.trustCa())">Trust</button>
              }
            </div>
            <div>
              <div class="text-xs text-zinc-500">Hosts file</div>
              @if (w.hosts.inSync) { <div class="mt-1 text-sm text-emerald-300">Up to date</div> }
              @else {
                <div class="mt-1 text-sm text-amber-300">Needs update</div>
                <button class="dk-btn-primary mt-2" [disabled]="busy()" (click)="act(daemon.windows.syncHosts())">Update</button>
              }
              @if (w.hosts.conflicts.length) {
                <p class="mt-1 text-xs text-zinc-500">Switched off in EnvKit/Herd: {{ w.hosts.conflicts.join(', ') }}</p>
              }
            </div>
            <div>
              <div class="text-xs text-zinc-500">Sites are served on</div>
              <div class="mt-1 font-mono text-sm">{{ w.network.hostsTarget }}</div>
              <p class="mt-1 text-xs text-zinc-500">
                {{ w.network.mode === 'wsl-ip' ? "WSL's own IP" : '127.0.0.1 (forwarded)' }}{{ w.portOwners.length ? ' · ' + owners(w) : '' }}
              </p>
              <button class="dk-btn mt-2" [disabled]="busy()" (click)="act(daemon.windows.setListenMode(other(w.network.mode)))">
                Use {{ other(w.network.mode) === 'localhost' ? '127.0.0.1' : 'the WSL IP' }}
              </button>
            </div>
          </div>
        } @else {
          <p class="mt-2 text-sm text-zinc-500">Checking…</p>
        }
      </section>

      <!-- About -->
      @if (daemon.system(); as sys) {
        <section class="dk-card grid grid-cols-2 gap-x-6 gap-y-2 p-5 text-sm">
          <h2 class="col-span-2 mb-1 font-medium">About</h2>
          <div class="text-zinc-500">DevKit service</div><div>devkitd {{ sys.daemon.version }} ({{ sys.daemon.runningAsRoot ? 'root' : 'not root' }})</div>
          <div class="text-zinc-500">Distro</div><div>{{ sys.distro.name }}</div>
          <div class="text-zinc-500">Kernel</div><div class="font-mono text-xs">{{ sys.kernel }}</div>
          <div class="text-zinc-500">Project user</div><div>{{ sys.user }}</div>
          <div class="text-zinc-500">systemd</div><div>{{ sys.systemd ? 'running' : 'not PID 1' }}</div>
          <div class="text-zinc-500">php in terminals</div><div>{{ sys.phpShim ? "DevKit's shim (follows each site)" : 'system default' }}</div>
        </section>
      }
    </div>
  `,
})
export class Settings implements OnInit {
  protected readonly daemon = inject(Daemon);
  protected readonly settings = signal<DesktopSettings | null>(null);
  protected readonly editors = signal<EditorInfo[]>([]);
  protected readonly status = signal<WindowsStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<ActionResult | null>(null);

  async ngOnInit(): Promise<void> {
    if (!this.daemon.inDesktopApp) return;
    const [settings, editors] = await Promise.all([this.daemon.windows.getSettings(), this.daemon.windows.listEditors()]);
    this.settings.set(settings);
    this.editors.set(editors);
    void this.loadStatus();
  }

  protected async save(changes: Partial<DesktopSettings>): Promise<void> {
    this.settings.set(await this.daemon.windows.saveSettings(changes));
  }

  protected other(mode: ListenMode): ListenMode {
    return mode === 'wsl-ip' ? 'localhost' : 'wsl-ip';
  }

  protected owners(w: WindowsStatus): string {
    return [...new Set(w.portOwners.map((o) => `${o.process}.exe`))].join(', ') + ' holds 80/443';
  }

  protected async act(action: Promise<ActionResult>): Promise<void> {
    this.busy.set(true);
    try {
      this.notice.set(await action);
    } finally {
      this.busy.set(false);
    }
    await this.loadStatus();
  }

  private async loadStatus(): Promise<void> {
    try {
      this.status.set(await this.daemon.windows.windowsStatus());
    } catch (e) {
      this.notice.set({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
}
