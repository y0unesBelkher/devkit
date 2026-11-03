import { Component, computed, input } from '@angular/core';

/** 24×24 stroke icons (Lucide-style outlines, drawn here so no icon font or package is needed). */
const PATHS = {
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 4l-3 16',
  terminal: 'M4 6l6 6-6 6 M12 18h8',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  play: 'M7 5v14l11-7z',
  stop: 'M7 7h10v10H7z',
  restart: 'M4 12a8 8 0 1 0 2.3-5.6 M4 4v4h4',
  pencil: 'M4 20h4l10-10-4-4L4 16z M13 7l4 4',
  trash: 'M5 7h14 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.7 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1',
  logs: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'app-icon',
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path [attr.d]="d()" [attr.fill]="filled() ? 'currentColor' : 'none'" />
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  protected readonly d = computed(() => PATHS[this.name()]);
  protected readonly filled = computed(() => this.name() === 'play' || this.name() === 'stop');
}
