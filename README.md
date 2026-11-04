# DevKit

A local development environment for **Laravel and Angular on WSL2**, managed from a Windows desktop app.

Projects and the whole stack (nginx, PHP-FPM, MySQL, Redis, Node) run inside WSL, where Laravel is fast.
The browser and your editor stay on Windows. Every site gets a `https://<name>.test` domain with a trusted certificate.

## Features

- **Dashboard and tray icon**: see which services are running and restart them, from the window or the tray.
- **Services**: install, start, stop, restart and enable nginx, PHP 8.1–8.4 FPM, MySQL, Redis and more, with live logs.
- **Sites**: pick a project folder and DevKit detects Laravel, Angular, PHP or static, then sets up nginx, SSL and the hosts entry.
  - Laravel: the PHP version is taken from `composer.json`, plus queue workers, the scheduler, Horizon and Artisan shortcuts.
  - Angular: `ng serve` is managed behind nginx, with live reload.
  - Each site has logs, `.env` editing and resource usage (memory, CPU, requests).
- **Groups**: keep a backend and its frontend together, and start, stop or open them in one click.
- **Tools**: PHP versions and extensions, Composer, Node (via fnm) and global npm packages such as the Angular CLI, with health checks and updates.
- **Databases**: create, drop, import and export, plus Adminer.
- **Files**: a browser for your Linux files. "Open in editor" works with Antigravity, VS Code, Cursor, Windsurf or a custom command.

## Install

### Requirements

- Windows 10 22H2 or Windows 11, with WSL2.
- An **Ubuntu** distro with a normal (non-root) default user. Ubuntu 24.04 is tested.

If you don't have WSL yet, run this in PowerShell, restart if asked, and create your Linux user:

```powershell
wsl --install -d Ubuntu
```

### Steps

1. Download `DevKit-Setup-<version>.exe` from the [latest release](../../releases/latest) and run it.
   The installer is not code-signed. If Windows SmartScreen warns you, click **More info → Run anyway**.
2. Open DevKit from the Desktop or the Start menu. On the Dashboard, click **Install**. This sets up the `devkitd` service in WSL and turns on systemd if it is off.
3. Click **Install recommended stack**, or pick services yourself on the Services and Tools pages.
4. On the Sites page, add a project folder from WSL (for example `~/projects/my-app`).
   A banner asks you once to trust DevKit's certificate authority, and to update the Windows hosts file (an admin prompt) whenever sites change.

Keep projects on the Linux filesystem (`/home/<you>/…`), not under `/mnt/c`. That is where the speed comes from.

DevKit keeps running in the tray when you close the window. Use the tray's **Quit DevKit** to stop it.

## Development

```
apps/desktop     Electron main process (Windows side: window, tray, daemon bootstrap, Windows-only actions)
apps/ui          Angular UI (renderer); talks to the daemon only through the Electron bridge
apps/daemon      devkitd: Bun/TypeScript, compiled to a single Linux binary, runs as a systemd service
packages/shared  API types and constants used by all three
```

Requires Node 24 and [Bun](https://bun.sh).

```bash
npm install
npm run dev          # builds devkitd, starts ng serve and the Electron window
npm test             # daemon unit tests (bun test)
npm run typecheck
npm run package      # builds the installer into apps/desktop/release/
```

Some pages, such as the EnvKit migration, only appear in development builds (`npm run dev`).

### Releases

Pushing a version tag builds the installer on GitHub Actions and attaches it to a release:

```bash
git tag v0.9.0
git push origin v0.9.0
```

Bump `version` in `apps/desktop/package.json` and `DAEMON_VERSION` in `packages/shared/src/index.ts` first.

### Headless helpers

Run these from `apps/desktop` after `npm run build:desktop`:

```bash
npx electron . --status           # print the daemon connection state as JSON
npx electron . --install-daemon   # install or upgrade devkitd in the Ubuntu distro
npx electron . --windows-status   # CA trust, hosts file and port-owner status
npx electron . --trust-ca         # trust the DevKit CA for the current Windows user (confirmation dialog)
npx electron . --sync-hosts       # rewrite the DevKit block of the hosts file (UAC prompt)
```

## How it fits together

- `devkitd` runs as root in WSL and listens on `127.0.0.1:7765`. Windows reaches it through WSL localhost forwarding.
  While the app is open, it keeps a `wsl.exe` attached so that WSL does not shut the VM, and every service with it, down.
- The API token is in `/etc/devkit/token` (root, `0600`). The Electron main process reads it with `wsl -u root` and proxies every API call, so the renderer never sees the token.
- The project user is the distro's default user, stored in `/etc/devkit/config.json`. Project commands, PHP-FPM pools, `ng serve` and queue workers run as that user, never as root.
- Set `DEVKIT_DISTRO` to target a distro other than `Ubuntu`.

### Sites and networking

- Each site gets `<name>.test`, a certificate signed by DevKit's local CA (`/etc/devkit/ca`), and
  `/etc/nginx/sites-available/devkit-<domain>.conf`.
- **WSL IP mode** (the default): nginx listens only on WSL's NAT IP, so another local stack can keep
  `127.0.0.1:80/443` on Windows. Hosts entries point at the WSL IP; when it changes after a WSL restart, a banner offers to update them.
- **127.0.0.1 mode**: nginx listens on all addresses and WSL forwards `127.0.0.1` into it. Switch modes in Settings
  once nothing else holds ports 80 and 443 on Windows.

## Uninstall

Uninstall DevKit from Windows Settings → Apps. To remove the daemon from WSL as well, run:

```bash
wsl -d Ubuntu -u root -e bash -c "systemctl disable --now devkitd; rm -f /etc/systemd/system/devkitd.service /usr/local/bin/devkitd; rm -rf /etc/devkit /var/lib/devkit; systemctl daemon-reload"
```
