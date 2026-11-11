# OMP Desktop v0.1.5

## Changes

- Workspace-first sidebar with a native directory chooser, persistent empty workspaces, unified live/saved session rows, inline titles, and session action menus.
- New-session buttons and split panes start live OMP terminals immediately. Saved conversations stay lazy until submission.
- Alt+1–9 switches spaces from saved-session composers without losing drafts. Ctrl+C cancels work instead of exiting OMP when no text is selected.
- Readiness-gated input, preserved failed-start drafts, and configurable graceful idle unloading (60 minutes by default).
- Linux now uses GTK4/WebKitGTK 6; macOS and Windows retain Tauri.
- Refreshed workspace and settings screenshots: illustrative saved conversation, 2880 × 1800 PNGs, captured from the shared browser client at 1440 × 900 / 2×. No private sessions or inference output is included.

## Downloads and requirements

GitHub provides source archives. `omp-desktop-v0.1.5-linux-x86_64.tar.gz` contains the native Linux shell, icon, license, and these notes. `SHA256SUMS` covers the archive and screenshot assets.

The shell is not a standalone installer. Use the v0.1.5 daemon source checkout with Bun 1.3+, OMP 18.13.1+, GTK 4.14+, and WebKitGTK 6.0 2.44+ runtime libraries. The Linux shell is built on Ubuntu 24.04 in CI. Older distributions are not verified. GTK3/WebKitGTK 4.1 is no longer sufficient.

```sh
bun install --frozen-lockfile
bun run start
```

Extract the native archive separately and run `./omp-desktop` while the daemon remains running. Use `bun run app:install` from source for application-menu integration. Do not restart a daemon with active work just to upgrade.

See the [desktop guide](https://github.com/cpu23/omp-desktop/blob/v0.1.5/docs/guide.md#native-linux-app) for build dependencies and setup.
