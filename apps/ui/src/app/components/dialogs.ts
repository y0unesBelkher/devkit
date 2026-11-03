import { Component, ElementRef, Injectable, afterRenderEffect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface PromptRequest {
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  resolve: (value: string | null) => void;
}

/** In-app replacement for window.prompt(), which Electron does not support. */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  readonly current = signal<PromptRequest | null>(null);

  prompt(title: string, options: { value?: string; message?: string; placeholder?: string; confirmLabel?: string } = {}): Promise<string | null> {
    this.current()?.resolve(null);
    return new Promise((resolve) => {
      this.current.set({
        title,
        message: options.message,
        value: options.value ?? '',
        placeholder: options.placeholder,
        confirmLabel: options.confirmLabel ?? 'OK',
        resolve,
      });
    });
  }

  close(value: string | null): void {
    const request = this.current();
    this.current.set(null);
    request?.resolve(value === null ? null : value.trim() || null);
  }
}

@Component({
  selector: 'app-dialogs',
  imports: [FormsModule],
  template: `
    @if (dialogs.current(); as d) {
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/60" (click)="dialogs.close(null)">
        <form class="dk-card w-[26rem] bg-zinc-900 p-5" (click)="$event.stopPropagation()" (ngSubmit)="dialogs.close(value)">
          <h2 class="font-medium">{{ d.title }}</h2>
          @if (d.message) {
            <p class="mt-1 text-sm whitespace-pre-wrap text-zinc-400">{{ d.message }}</p>
          }
          <input #field class="dk-input mt-3 w-full" name="value" [(ngModel)]="value" [placeholder]="d.placeholder ?? ''" autocomplete="off"
            (keydown.escape)="dialogs.close(null)" />
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="dk-btn" (click)="dialogs.close(null)">Cancel</button>
            <button type="submit" class="dk-btn-primary">{{ d.confirmLabel }}</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class DialogHost {
  protected readonly dialogs = inject(Dialogs);
  protected value = '';
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private shownFor: unknown = null;

  constructor() {
    afterRenderEffect(() => {
      const current = this.dialogs.current();
      const input = this.field()?.nativeElement;
      if (current && input && this.shownFor !== current) {
        this.shownFor = current;
        this.value = current.value;
        input.value = current.value;
        input.focus();
        input.select();
      }
      if (!current) this.shownFor = null;
    });
  }
}
