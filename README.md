# DevKit

A local development environment manager for **WSL2** (Ubuntu): an Electron + Angular desktop app on Windows, plus a root daemon (`devkitd`) running inside WSL.

```
apps/desktop   Electron main process (Windows side: window, daemon bootstrap, Windows-only actions)
apps/ui        Angular UI (renderer); talks to the daemon only through the Electron bridge
apps/daemon    devkitd: Bun/TypeScript, compiled to a single Linux binary, runs as a systemd service
packages/shared  API types and constants used by all three
```

## Development

```bash
npm install
npm run dev          # builds devkitd, starts ng serve and the Electron window
npm test             # daemon unit tests (bun test)
npm run typecheck
```

Headless helpers (run from `apps/desktop` after `npm run build:desktop`):

```bash
npx electron . --status           # print the daemon connection state as JSON
npx electron . --install-daemon   # install or upgrade devkitd in the Ubuntu distro
```

## How it fits together

- `devkitd` listens on `127.0.0.1:7765` inside WSL; Windows reaches it through WSL localhost forwarding.
- The API token lives in `/etc/devkit/token` (root, `0600`). The Electron main process reads it with `wsl -u root` and proxies every API call, so the renderer never sees it.
- The project user (the distro's default user) is stored in `/etc/devkit/config.json`; project commands will run as that user, never as root.
- Set `DEVKIT_DISTRO` to target a distro other than `Ubuntu`.

## Removing the daemon

```bash
wsl -d Ubuntu -u root -e bash -c "systemctl disable --now devkitd; rm -f /etc/systemd/system/devkitd.service /usr/local/bin/devkitd; rm -rf /etc/devkit /var/lib/devkit; systemctl daemon-reload"
```

## Roadmap

See the milestone list in the plan: services (2), SSL + hosts (3), Laravel sites (4), Angular sites and queues/Horizon (5), tools (6), groups/databases/files (7), EnvKit import and migration (8).
