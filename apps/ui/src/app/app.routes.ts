import { Routes } from '@angular/router';
import { MIGRATE_ENABLED } from './core/features';
import { Dashboard } from './pages/dashboard';
import { Databases } from './pages/databases';
import { Files } from './pages/files';
import { Migrate } from './pages/migrate';
import { Services } from './pages/services';
import { Settings } from './pages/settings';
import { SiteDetail } from './pages/site-detail';
import { Sites } from './pages/sites';
import { Tools } from './pages/tools';

export interface NavItem {
  path: string;
  label: string;
}

export const NAV: NavItem[] = [
  { path: 'dashboard', label: 'Dashboard' },
  { path: 'sites', label: 'Sites' },
  { path: 'services', label: 'Services' },
  { path: 'tools', label: 'Tools' },
  { path: 'databases', label: 'Databases' },
  { path: 'files', label: 'Files' },
  ...(MIGRATE_ENABLED ? [{ path: 'migrate', label: 'Migrate' }] : []),
  { path: 'settings', label: 'Settings' },
];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: Dashboard, title: 'Dashboard · DevKit' },
  { path: 'sites', component: Sites, title: 'Sites · DevKit' },
  { path: 'sites/:id', component: SiteDetail, title: 'Site · DevKit' },
  // Groups live on the Sites page now.
  { path: 'groups', redirectTo: 'sites' },
  { path: 'services', component: Services, title: 'Services · DevKit' },
  { path: 'tools', component: Tools, title: 'Tools · DevKit' },
  { path: 'databases', component: Databases, title: 'Databases · DevKit' },
  { path: 'files', component: Files, title: 'Files · DevKit' },
  ...(MIGRATE_ENABLED ? [{ path: 'migrate', component: Migrate, title: 'Migrate · DevKit' }] : []),
  { path: 'settings', component: Settings, title: 'Settings · DevKit' },
  { path: '**', redirectTo: 'dashboard' },
];
