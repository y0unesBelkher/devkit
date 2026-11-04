import { isDevMode } from '@angular/core';

/** EnvKit migration is only for local development builds for now; release builds leave it out. */
export const MIGRATE_ENABLED = isDevMode();
