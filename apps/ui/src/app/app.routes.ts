import { Routes } from '@angular/router';
import { Dashboard } from './pages/dashboard';
import { ComingSoon } from './pages/coming-soon';

export interface NavItem {
  path: string;
  label: string;
  milestone?: number;
}

export const NAV: NavItem[] = [
  { path: 'dashboard', label: 'Dashboard' },
  { path: 'services', label: 'Services', milestone: 2 },
  { path: 'sites', label: 'Sites', milestone: 4 },
  { path: 'groups', label: 'Groups', milestone: 7 },
  { path: 'tools', label: 'Tools', milestone: 6 },
  { path: 'databases', label: 'Databases', milestone: 7 },
  { path: 'files', label: 'Files', milestone: 7 },
  { path: 'settings', label: 'Settings' },
];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: Dashboard, title: 'Dashboard · DevKit' },
  ...NAV.filter((item) => item.path !== 'dashboard').map((item) => ({
    path: item.path,
    component: ComingSoon,
    title: `${item.label} · DevKit`,
    data: item,
  })),
  { path: '**', redirectTo: 'dashboard' },
];
