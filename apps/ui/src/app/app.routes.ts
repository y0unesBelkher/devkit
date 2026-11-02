import { Routes } from '@angular/router';
import { Dashboard } from './pages/dashboard';
import { ComingSoon } from './pages/coming-soon';
import { Services } from './pages/services';
import { Sites } from './pages/sites';
import { Tools } from './pages/tools';

export interface NavItem {
  path: string;
  label: string;
  milestone?: number;
}

export const NAV: NavItem[] = [
  { path: 'dashboard', label: 'Dashboard' },
  { path: 'services', label: 'Services' },
  { path: 'sites', label: 'Sites' },
  { path: 'groups', label: 'Groups', milestone: 7 },
  { path: 'tools', label: 'Tools' },
  { path: 'databases', label: 'Databases', milestone: 7 },
  { path: 'files', label: 'Files', milestone: 7 },
  { path: 'settings', label: 'Settings' },
];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: Dashboard, title: 'Dashboard · DevKit' },
  { path: 'services', component: Services, title: 'Services · DevKit' },
  { path: 'sites', component: Sites, title: 'Sites · DevKit' },
  { path: 'tools', component: Tools, title: 'Tools · DevKit' },
  ...NAV.filter((item) => item.milestone !== undefined || item.path === 'settings').map((item) => ({
    path: item.path,
    component: ComingSoon,
    title: `${item.label} · DevKit`,
    data: item,
  })),
  { path: '**', redirectTo: 'dashboard' },
];
