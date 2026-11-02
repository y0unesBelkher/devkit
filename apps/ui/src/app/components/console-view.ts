import { Component, ElementRef, afterRenderEffect, computed, input, viewChild } from '@angular/core';

/** Monospace output that follows new lines unless the user has scrolled up. */
@Component({
  selector: 'app-console-view',
  host: { class: 'block min-h-0' },
  template: `
    <pre
      #scroller
      (scroll)="onScroll()"
      class="h-full overflow-auto bg-zinc-950 px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-zinc-300"
    >{{ text() || placeholder() }}</pre>
  `,
})
export class ConsoleView {
  readonly lines = input.required<string[]>();
  readonly placeholder = input('No output yet.');

  protected readonly text = computed(() => this.lines().join('\n'));
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private stickToBottom = true;

  constructor() {
    afterRenderEffect(() => {
      this.text();
      const el = this.scroller().nativeElement;
      if (this.stickToBottom) el.scrollTop = el.scrollHeight;
    });
  }

  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }
}
