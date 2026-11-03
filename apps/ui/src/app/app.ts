import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DialogHost } from './components/dialogs';
import { NetworkBanner } from './components/network-banner';
import { Daemon } from './core/daemon';
import { NAV } from './app.routes';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NetworkBanner, DialogHost],
  host: { class: 'flex h-screen bg-zinc-950 text-zinc-100' },
  template: `
    <aside class="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
      <div class="flex items-center gap-2 px-5 py-5">
        <div class="grid size-8 place-items-center rounded-lg bg-emerald-500 font-bold text-zinc-950">D</div>
        <div>
          <div class="font-semibold leading-tight">DevKit</div>
          <div class="text-xs text-zinc-500">WSL dev environment</div>
        </div>
      </div>
      <nav class="flex flex-1 flex-col gap-0.5 px-3">
        @for (item of nav; track item.path) {
          <a
            [routerLink]="item.path"
            routerLinkActive="bg-zinc-800 text-white"
            class="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
          >
            {{ item.label }}
          </a>
        }
      </nav>
      <div class="flex items-center gap-2 border-t border-zinc-800 px-5 py-3 text-xs text-zinc-400">
        <span class="size-2 rounded-full" [class]="daemon.connected() ? 'bg-emerald-400' : 'bg-amber-400'"></span>
        {{ daemon.connected() ? 'Daemon connected' : 'Daemon offline' }}
      </div>
    </aside>
    <main class="flex min-w-0 flex-1 flex-col">
      <app-network-banner />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <router-outlet />
      </div>
    </main>
    <app-dialogs />
  `,
})
export class App implements OnInit {
  protected readonly daemon = inject(Daemon);
  protected readonly nav = NAV;

  ngOnInit(): void {
    void this.daemon.refresh();
  }
}
