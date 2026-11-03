import { join } from 'node:path';
import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import type { ServiceAction, ServiceStatus, ServicesResponse, Site, SitesResponse } from '@devkit/shared';
import { api } from './daemon-client';
import { getSettings, saveSettings } from './settings';

const STATE_MARK: Record<string, string> = { active: '●', failed: '✕', activating: '…', deactivating: '…' };

/**
 * The tray shows at a glance whether DevKit is up and what runs, and lets services be started, stopped
 * or restarted without opening the window. It is rebuilt whenever the daemon pushes new states.
 */
export class TrayController {
  private readonly tray: Tray;
  private services: ServiceStatus[] = [];
  private sites: Site[] = [];
  private live = false;

  constructor(
    private readonly showWindow: () => void,
    private readonly quit: () => void,
  ) {
    this.tray = new Tray(this.icon());
    this.tray.on('click', () => this.showWindow());
    this.render();
    void this.refresh();
    // Sites change rarely; services are pushed, but poll both slowly in case the socket is down.
    setInterval(() => void this.refresh(), 30_000).unref();
  }

  setLive(live: boolean): void {
    this.live = live;
    this.render();
    if (live) void this.refresh();
  }

  setServices(services: ServiceStatus[]): void {
    this.services = services;
    this.render();
  }

  private icon() {
    return nativeImage.createFromPath(join(app.getAppPath(), 'assets', this.live ? 'tray.png' : 'tray-offline.png'));
  }

  private async refresh(): Promise<void> {
    const [services, sites] = await Promise.all([
      api<ServicesResponse>({ method: 'GET', path: '/api/services' }),
      api<SitesResponse>({ method: 'GET', path: '/api/sites' }),
    ]);
    this.live = services.ok;
    if (services.ok) this.services = services.data.services;
    if (sites.ok) this.sites = sites.data.sites;
    this.render();
  }

  private async act(service: ServiceStatus, action: ServiceAction): Promise<void> {
    await api({ method: 'POST', path: `/api/services/${service.id}/${action}` });
    await this.refresh();
  }

  private async restartRunning(): Promise<void> {
    for (const service of this.services.filter((s) => s.active === 'active')) {
      await api({ method: 'POST', path: `/api/services/${service.id}/restart` });
    }
    await this.refresh();
  }

  private render(): void {
    const installed = this.services.filter((s) => s.installed);
    const running = installed.filter((s) => s.active === 'active');
    const status = this.live ? `${running.length} of ${installed.length} services running` : 'Daemon offline';
    this.tray.setImage(this.icon());
    this.tray.setToolTip(`DevKit — ${status}`);

    const serviceItems: MenuItemConstructorOptions[] = installed.map((service) => ({
      label: `${STATE_MARK[service.active] ?? '○'}  ${service.name}${service.version ? `  ${service.version}` : ''}`,
      submenu: [
        { label: 'Start', enabled: service.active !== 'active', click: () => void this.act(service, 'start') },
        { label: 'Stop', enabled: service.active === 'active', click: () => void this.act(service, 'stop') },
        { label: 'Restart', click: () => void this.act(service, 'restart') },
      ],
    }));
    const siteItems: MenuItemConstructorOptions[] = this.sites.map((site) => ({
      label: site.domain,
      click: () => void shell.openExternal(`https://${site.domain}`),
    }));

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `DevKit — ${status}`, enabled: false },
        { type: 'separator' },
        ...(serviceItems.length ? serviceItems : [{ label: this.live ? 'No services installed' : 'Waiting for WSL…', enabled: false }]),
        { label: 'Restart running services', enabled: running.length > 0, click: () => void this.restartRunning() },
        { type: 'separator' },
        { label: 'Open site', enabled: siteItems.length > 0, submenu: siteItems.length ? siteItems : [{ label: 'No sites', enabled: false }] },
        { label: 'Open DevKit', click: () => this.showWindow() },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: getSettings().startWithWindows,
          click: (item) => {
            saveSettings({ startWithWindows: item.checked });
            this.render();
          },
        },
        { label: 'Quit DevKit', click: () => this.quit() },
      ]),
    );
  }
}
