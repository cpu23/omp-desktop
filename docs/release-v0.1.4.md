# OMP Desktop v0.1.4

## Workspace and sidebar

- Compact, borderless two-line session rows, grouped exclusively into Loaded, Pinned, and Recent.
- Click section labels to collapse or expand them. Recent is sorted by last activity; Loaded shows its count.
- Hover/focus-only pin and close controls, stable sidebar scrolling, and a new-session plus beside search.
- Single-pixel shared split/sidebar separators with wider invisible resize targets.
- Compact pane headers with hover-only close/pin actions and no bottom outline.
- Settings organized into Appearance, Notifications, Sessions, and grouped Keyboard shortcuts.
- Toggle the selected pane full-workspace with Ctrl+Shift+F (Meta+Shift+F); repeat to restore its split.
- Drag workspace tabs to reorder them. Native completion notifications use the installed OMP logo.

## Runtime and review fixes

- Smaller fingerprinted, compressed frontend assets and WOFF2 fonts.
- Bounded replay/image/snapshot/paste retention, ordered output backpressure, and exited-runtime cleanup.
- Incremental session indexing, coalesced reads/writes, hidden-client polling suspension, and restart-safe workspace updates.
- Fixed sidebar search discarding server matches for prompt text, session IDs, and transcript paths.
- Fixed pending-image budget bypass for parameterized Sixel headers, including split headers.

## Downloads

GitHub provides the source archives. `omp-desktop-v0.1.4-linux-x86_64.tar.gz` contains the native shell,
application icon, license, and these notes. `SHA256SUMS` verifies the native archive and screenshot assets.

The shell is **not a standalone distribution of the daemon or OMP**. It requires a running daemon from the
v0.1.4 source checkout, Bun 1.3+, OMP 18.x, and Linux GTK 3 / WebKitGTK 4.1 / libsoup 3 runtime libraries.
The binary was built and launch-tested on Ubuntu 26.04.1 LTS x86_64 (glibc 2.43, WebKitGTK 2.52.6).
Compatibility with older distributions is not verified; use the source build instructions in the
[desktop guide](https://github.com/cpu23/omp-desktop/blob/v0.1.4/docs/guide.md#native-linux-app) there.

Start the daemon from the source checkout:

```sh
bun install --frozen-lockfile
bun run start
```

Extract the native archive in a separate terminal and launch its shell:

```sh
tar -xzf omp-desktop-v0.1.4-linux-x86_64.tar.gz
cd omp-desktop-v0.1.4-linux-x86_64
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
cp sh.omp.desktop.svg "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps/"
./omp-desktop
```

For application-menu integration, build/install from source with `bun run app:install` instead.
Do not restart an active daemon until its running sessions can safely be interrupted.

## Verification

- TypeScript check and 173 tests pass, including two parameterized-Sixel budget regressions.
- Isolated daemon API smoke and full OMP PTY/session/restart smoke pass.
- Image smoke passes Chromium DOM/WebGL and WebKit DOM at 1×, 1.25×, 1.5×, and 2×.
- Native optimized Tauri build and all three Rust unit tests pass; the native window was launched against
  an isolated daemon and visually inspected under Xvfb.
- Browser smoke confirms prompt-only sidebar search and section collapse/expand.
- New workspace and settings screenshots are 3840 × 2160 and use illustrative sample conversations,
  not private sessions. They capture the shared browser workspace; native rendering was checked separately.
