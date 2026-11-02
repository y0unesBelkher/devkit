import { Component, input } from '@angular/core';

@Component({
  selector: 'app-coming-soon',
  template: `
    <div class="p-8">
      <h1 class="text-2xl font-semibold">{{ label() }}</h1>
      <p class="mt-2 text-sm text-zinc-400">
        Not built yet{{ milestone() ? ' (milestone ' + milestone() + ')' : '' }}.
      </p>
    </div>
  `,
})
export class ComingSoon {
  readonly label = input('');
  readonly milestone = input<number | undefined>(undefined);
}
