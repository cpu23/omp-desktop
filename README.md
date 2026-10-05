# omp-desktop

Desktop app for [omp](https://omp.sh) sessions: a daemon owns real `omp` TUI processes on PTYs and renders them in a
Tauri window or browser surface (sidebar, splits, drag-to-pane). The agent is never re-implemented — panes are the actual TUI.

Design and decisions: [`docs/desktop-architecture.md`](docs/desktop-architecture.md),
[`docs/desktop-app-options.md`](docs/desktop-app-options.md), [`docs/desktop-reqs.txt`](docs/desktop-reqs.txt).

## Status — P1

Daemon + PTY pool, several `omp` sessions at once, byte-transparent I/O, resize, replay buffer for late attach,
iTerm2 image protocol forced (`PI_FORCE_IMAGE_PROTOCOL=iterm2`) so images render in xterm.js (`addon-image`).
Collapsible, resizable sidebar (pinned + live + recent sessions, search, owner labels), up to four panes in a 2×2 layout with draggable dividers,
drag a session onto a pane, drag a pane
header to swap two panes, layout + bindings persisted in the client and mirrored to a daemon-side state file, resume from the
sidebar or from a dead pane's placeholder, and image paste (`POST /api/paste` -> daemon stores the file -> the pane
types the path, which omp attaches).

Right-click any pane for the layout-wide split action (`Ctrl+Shift+E` also works):
the first action changes 1×1 to 1×2 side by side; the next splits both columns
top/bottom at once, producing 2×2. At four panes the menu action is disabled.
Closing a pane enables it again to fill missing grid slots. There is no header
split button. Escape or clicking outside dismisses the menu. Older arbitrary layouts
are converted to this structure on load, preserving up to four pane bindings.
`Ctrl+Shift+X` closes a pane; the former
`Ctrl+Shift+O` direction-specific shortcut is removed.
To switch sessions, focus a pane and click a session in the sidebar, or drag a
session onto the target pane. Pane headers have no session dropdown.

Verified live (not from the spec): two live sessions swapped without losing pids, reload restoring a 2x2 layout with
all four pids and repainted screens, orphaned live runtime adopted into an empty pane, paste reaching omp's
attachment chip, panes filling their box (160x42 reported = 42 rows rendered, divider drag reflowing both terminals
to the new geometry), split/close keyboard controls driven through real key events,
and `bun run smoke` green.

Closing and reopening Desktop reattaches surviving processes without changing their PIDs. The daemon
records its complete live pool in `<state dir>/sessions.json`, independently of pane bindings and windows.
After restart it resumes every recorded transcript before serving runtime requests, including sidebar
sessions with no pane open. Concurrent resume requests for one transcript share one process. Explicit
sidebar stops remove their record immediately; ordinary process exits settle after three seconds so a
service-wide SIGTERM cannot erase the pool while the daemon itself is shutting down. An ordinary exit
immediately followed by daemon shutdown within that window may resume once. Running tasks, unsaved prompt
buffers, and empty sessions that never wrote a transcript cannot survive process loss.

Each saved pane records its live intent and daemon generation. Legacy layouts without this intent flag
resume transcript-backed panes once, including layouts where the old client already cleared the runtime ID;
the old format cannot distinguish a deliberately stopped pane from a lost process. Stops made after this
upgrade are preserved. The daemon deduplicates resumed transcripts across panes and clients.

The daemon's `state.json` mirror restores the workspace even when browser storage was cleared. The mirror
is written only after the client reads it (or proves it absent), so a failed read or a newer document version
cannot be overwritten by fallback state.

Sidebar session ages and recent-session order use the last user/assistant message timestamp, not file
modification time or terminal output. Opening/resuming a chat, resizing its terminal, or appending session-exit
metadata does not make it recent. Sessions with no messages use their recorded creation time, filename time,
or filesystem birth time. Activity scans are cached by file modification time and size; all transcripts are
considered before filtering and limiting results.

Live sidebar rows use the CLI's exact per-session accent (gray for an unnamed session), Mobile's braille
spinner and shimmering **Working…** label, and a green **Done** badge after a turn completes. The extension
uses OMP 18's `theme.sessionAccentInputs` and the host's OKLCH color algorithm, not a SHA1 hue approximation.
The algorithm is mirrored because compiled OMP cannot expose its internal color-module import to extensions;
host upgrades must recheck parity. Missing theme inputs produce neutral gray, not an invented color.
Working replaces Done on the next turn; Done survives window reload while that process remains alive.
This is completion state, not an unread counter. Stopped or unavailable sessions show neither indicator.

The sidebar footer's **Motion: System / On / Off** controls only working indicators. Native Desktop defaults
to On for CLI parity; browsers default to System. System honors `prefers-reduced-motion`, which WebKitGTK
derives from GTK's animation setting (disabled on the tested KDE host). On animates without changing system
settings; Off freezes the badge. The choice persists in that webview's local storage. Hidden indicators stop animating.

The daemon reads the injected Mobile extension's authenticated, owner-only `GET /status` socket endpoint
on the existing runtime polling cadence (2.5 seconds). This small projection supplies accent, agent activity,
and completion identity without serializing a transcript. Terminal repaints never imply agent activity.
Unavailable or older extensions omit indicators rather than guess. Deploy the extension and daemon changes
together; restart the daemon only after current tasks finish (see the warning below). No mobile gateway
or native-shell rebuild is needed.

Regression verification with four real OMP sessions: closing clients, killing a PTY child before the daemon
(service-teardown ordering), and restarting without a client restored all four original transcript paths
in new processes. Reopening restored all four pane bindings; explicitly stopping one left exactly three
after another restart. In the actual Tauri/private-WebKit window, the native On default produced all eight
spinner frames and 14 distinct shimmer frames across 24 captures. CLI true-color bytes and the sidebar
both used `#8378ff` for “Resume previous training session”. Desktop/mobile typechecks, 74 desktop tests,
22 accent tests, and daemon/PTY smoke passed. The running user daemon was not restarted.

Each pane owns exactly one terminal WebSocket. Selecting its current session keeps that connection;
switching sessions closes the old stream before attaching the new one. Late events from replaced
sockets are ignored, and a new connection resets the terminal before replay. This prevents repeated
sidebar selections or pane swaps from multiplying terminal output, mixing sessions, and increasing
typing/render latency. Browser verification reproduced six open streams in one pane before the fix;
afterward eight repeated selections kept one stream, and repeated cross-session switches left only
two open streams for two panes (all twelve replaced connections closed).

Isolated browser verification with real omp terminals: reload preserved both runtime PIDs; restarting the
test daemon automatically resumed the same transcript with a new PID; an already-broken legacy pane with
`runtimeId: null` resumed without a click; an explicit stop remained stopped after reopening. A September
message still displayed **1mo** after resume/stop in October. TypeScript checking, 38 regression tests and
the daemon/PTY smoke suite passed. Native backend and rendering verification is described below.

Session-code changes require a daemon restart to load the new backend and client bundle. Do this only when
current tasks have finished: `systemctl --user restart omp-desktopd` terminates its running processes.

**First upgrade from a daemon without the live-pool ledger:** after tasks finish, checkpoint the running
pool immediately before restarting, from this directory:

```sh
bun run scripts/checkpoint-sessions.ts && systemctl --user restart omp-desktopd
```

The checkpoint command does not stop processes; it refuses to write if a live session has no saved
transcript. It discovers the workspace location through the daemon. For custom installations, pass the
same `OMP_DESKTOP_PORT`, `OMP_DESKTOP_STATE_DIR` / `OMP_DESKTOP_LEDGER_FILE` overrides as the service.
This bridges the old daemon's missing pool record; later restarts maintain it automatically. A checkpoint
cannot identify sessions already lost before this upgrade—reopen those from the saved-session sidebar.

Not yet: daemon-owned multi-client layout (the mobile gateway drives these same live runtimes — list, new/resume/stop,
prompts and terminal — and the desktop's workspace now has a durable daemon-side mirror, but the pane grid is not yet
a layout service other clients read), idle unload, desktop notifications.

## Run

```sh
bun install
bun run start        # http://127.0.0.1:4180
bun run smoke        # end-to-end check (bash round-trip + real omp TUI + reap)
bun run check        # typecheck
```

### Native Linux app (Tauri 2, no Chromium)

The shell uses **WebKitGTK** and the existing daemon; it does not bundle Chromium or another session backend.
System WebKitGTK is the default; an optional app-private high-refresh runtime is described below.
Install Rust/Cargo and the native build dependencies first. On Ubuntu/Debian:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev libdbus-1-dev
```

From `omp-desktop/`:

```sh
bun install
bun run app          # development native window
bun run app:install  # release build + per-user application-menu launcher
```

After installation, open **OMP Desktop** from the application menu or run `~/.local/bin/omp-desktop`.
`bun run app:build` builds only the native executable, without installing it. The installer copies it to
`~/.local/bin/omp-desktop` and writes `omp-desktop.desktop` under `$XDG_DATA_HOME/applications`
(default `~/.local/share/applications`). Re-run `app:install` to update the shell.

The native icon uses the same π artwork as `omp-mobile/public/icon.svg`: the SVG is kept in
`src-tauri/icons/icon.svg`, with an RGBA PNG for Tauri's embedded icon. The installer adds the SVG as
`$XDG_DATA_HOME/icons/hicolor/scalable/apps/sh.omp.desktop.svg`. The desktop-entry filename matches GTK's
Wayland app ID (`omp-desktop`), so KDE can associate the window with the correct icon.
When a session bus and `gdbus` are available, installation also emits KDE's icon-cache invalidation signal.
This refreshes a running Plasma taskbar that cached a missing icon before installation; updating the desktop
database alone is insufficient. Verified by observing the π taskbar icon without restarting Plasma or the app.

The app connects to `http://127.0.0.1:4180`. If the default daemon is unavailable, it attempts to start the existing
`omp-desktopd.service` user unit—not restart it. It does not install that service. Without a user unit, start the
daemon separately using `bun run start`. Set `OMP_DESKTOP_PORT` when launching the app to connect to a different
local port; custom ports require an already-running daemon. Connection failures appear in the window with a retry
action.

Closing the window leaves the daemon and its sessions running. Launching the app again reuses the existing
window and requests focus (subject to the compositor's focus policy). Browser and native-window storage are separate:
saved pane layouts, pinned chats, sidebar width and font size are not imported from your browser, but the daemon's
live/recent sessions are shared, and every client mirrors its workspace to the daemon's durable state file — a
native window whose webview storage was lost rebuilds its panes, pins and settings from that file on boot. Native
settings persist across app launches. External HTTP(S) links open in your default browser; the daemon page receives
no native IPC permissions.

This is a local client installation, not a self-contained daemon/Bun/omp distribution. WebKitGTK runtime libraries
must remain installed. To uninstall the shell, remove `~/.local/bin/omp-desktop`, its application-menu entry and
the installed `sh.omp.desktop.svg` icon; this does not remove sessions or stop the daemon.

Verified on KDE/Wayland: release build and installation, actual WebKit terminal rendering, split/close controls,
layout restoration after reopening, one native process after repeated launches, the custom-port error screen and
Retry action, and the π title-bar icon. The live session kept the same PID across window close/reopen.
TypeScript checking, native daemon handshake, navigation URL boundaries and desktop-entry validation also passed.
Native clipboard-image paste and pane dragging were attempted under Xvfb, but neither probe completed
with either the system or private engine. Those interactions remain unverified on the actual desktop;
compositor-driven focus activation is not guaranteed.

Backend selection on Wayland with NVIDIA: before GTK initializes, the shell prefers the X11 (XWayland) backend
when the session is Wayland, the NVIDIA kernel driver is loaded (`/proc/driver/nvidia/version` exists) and
`DISPLAY` names a local socket in `/tmp/.X11-unix`; it sets `GDK_BACKEND=x11,wayland` (X11 first, Wayland as a
fallback if XWayland cannot be opened). Any explicit `GDK_BACKEND` is preserved, so `GDK_BACKEND=wayland` opts
out; WebGL, hardware acceleration and DMABUF settings are untouched. Measured with an actual four-WebGL-pane
terminal window (2100x1100, real xterm streaming) on the KDE Wayland / RTX 5070 Ti workstation at fractional
scale 1.15: Wayland chose device pixel ratio 2 and rendered 18.5 fps (p95 frame 61 ms, max 66 ms), while
XWayland rendered at DPR 1.15 and 61.3 fps (p95 19 ms, max 27 ms). A single-pane window (1600x950) with row
updates and simulated drag events measured 39.4 vs 62.5 fps with UI-process CPU time 3.05 s vs 0.635 s over the same
10.9 s wall, and a synthetic animated WebGL canvas measured ~27 vs ~70 fps. XWayland glyph edges can be
marginally softer because 1.15 is not an integer pixel ratio. These are representative measurements, not a
frame-rate guarantee for other workloads.
The installed shell was also launched against an isolated four-pane daemon without a `GDK_BACKEND`
override: its visible X11 window and native terminal rendering were confirmed. Close and reopen the app
after installing the shell to use the new backend; this does not require restarting the daemon or its sessions.

### App-private high-refresh WebKitGTK

This local Linux x86_64 build pins Ubuntu WebKitGTK **2.52.6** and GTK **3.24.52**, applies their
distribution patch sets, then makes these app-local changes:

- WebKit's timer-backed display monitor uses the GDK monitor refresh rate instead of a hardcoded 60 Hz,
  with nanosecond rather than truncated-millisecond sleeps. Unknown refresh retains the 60 Hz fallback.
  The GTK build also defaults `PreferPageRenderingUpdatesNear60FPS` to false.
- GTK's X11 paint clock uses the monitor rate when compositor presentation feedback is absent. Actual
  presentation feedback stays authoritative; Wayland's GTK clock is unchanged.
- NVIDIA keeps DMA-buffer imports disabled, but uses WebKit's shared-memory compositor transport
  instead of disabling accelerated compositing altogether. Rendering remains GPU-accelerated; the final
  surface crosses to GTK through shared memory. No force-DMABuf or driver environment overrides are needed.

On the 119.953 Hz workstation, the patched GTK clock painted at **119.99 Hz** with an **8336 μs**
interval. On an isolated Xvfb display reporting unknown refresh, it retained **60.00 Hz / 16667 μs**.
An empty WebKit page on that unknown-refresh display ran at **59.78 Hz**.

A controlled four-terminal WebGL workload at 1571×766 / DPR 1.15 measured **119.15 animation frames/s**,
**115.11–115.54 redraws/s per terminal**, and **118.60 GTK paint callbacks/s**; p50/p95 frame intervals
were **8/9 ms**. System WebKitGTK with the near-60 preference explicitly disabled measured **35.42 frames/s**
and **34.94 redraws/s per terminal** on the same workload. These are application counters, not physical
scanout measurements or guarantees for every workload. `webkit://gpu` confirmed the RTX 5070 Ti,
threaded GPU rendering, shared-memory-only transport and a 120 Hz display timer.

The private runtime was installed and exercised in an isolated Tauri window. Process mappings confirmed
all four private rendering libraries; terminal input, resizing and reattachment to the same live PID
worked. Scratch installation and rollback both selected the expected library set. The user installation
was then updated atomically without replacing any of its three live terminal processes. Close/reopen
loads the engine; the separate session-code changes require a daemon restart when work is idle.

`scripts/build-webkit.ts` verifies pinned source-archive checksums, applies the distribution and local
patches, builds into the user cache, and installs only into the selected private prefix. The system
libraries, loader configuration, GTK themes and input-method modules are not replaced. WebKit's process
sandbox stays enabled. The installer gives the copied app executable a private ELF RUNPATH, checks all
four rendering libraries, and atomically replaces the installed executable; it does not export
`LD_LIBRARY_PATH` into browsers or other programs launched by the app.

The current workstation's build tools and development packages were extracted without root into
`~/.cache/omp-desktop/webkit-2.52.6/sysroot`. Keep that cache for reproducible local rebuilds. A fresh
machine needs the matching distribution's WebKitGTK/GTK development dependencies plus Clang/LLD,
CMake, Ninja, Meson, Ruby, Bison, Flex, gperf, unifdef, gettext, sassc and patchelf; the script does
not install system packages. Without `OMP_DESKTOP_WEBKIT_SYSROOT`, it uses build tools and dependencies
already installed on the host.

From `omp-desktop/`, using the existing private dependency cache:

```sh
export OMP_DESKTOP_WEBKIT_SYSROOT="$HOME/.cache/omp-desktop/webkit-2.52.6/sysroot"
export OMP_DESKTOP_WEBKIT_PREFIX="$HOME/.local/share/omp-desktop/webkitgtk-2.52.6-refresh1"
bun run app:webkit:build
PATH="$OMP_DESKTOP_WEBKIT_SYSROOT/usr/bin:$PATH" bun run app:install
```

`OMP_DESKTOP_WEBKIT_JOBS` defaults to 4 compilation jobs; linking is limited to one job.
`OMP_DESKTOP_WEBKIT_CACHE` changes the build-cache root. Completed prefixes contain `runtime.json`;
the installer refuses incomplete runtimes. Changing patches requires a **new prefix** rather than
overwriting shared libraries that a running app could still be using.

Close and reopen the native app after installation. Engine activation does not require a daemon restart.
To return to system WebKitGTK, reinstall without the prefix override and reopen:

```sh
env -u OMP_DESKTOP_WEBKIT_PREFIX bun run app:install
```

Private engines do **not** receive system package security updates. Re-pin source versions/checksums,
rebase the two patch files, build a new prefix and reinstall when WebKitGTK/GTK updates are needed.
Do not remove an old runtime prefix while an app or its helper processes still use it.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `OMP_DESKTOP_HOST` | `127.0.0.1` | listen address (loopback only by design in P0) |
| `OMP_DESKTOP_PORT` | `4180` | listen port |
| `OMP_DESKTOP_CWD` | `$HOME` | working directory for new sessions; a resume runs in the transcript's recorded cwd, with this value only the fallback when that directory is gone |
| `OMP_DESKTOP_OMP` | `omp` | omp binary (overridable for tests) |
| `OMP_DESKTOP_OMP_ARGS` | empty | extra args for the omp binary |
| `OMP_DESKTOP_OVERLAY` | empty (no overlay) | optional `--config` overlay for experiments; omp otherwise runs with the user's own config |
| `OMP_DESKTOP_SESSIONS_DIR` | `$HOME/.omp/agent/sessions` | session store used by the sidebar index and by `POST /api/runtimes` resume validation |
| `OMP_DESKTOP_STATE_DIR` | `$XDG_STATE_HOME/omp-desktop` (or `~/.local/state/omp-desktop`) | directory for the durable `state.json` workspace mirror; point it elsewhere to keep tests and secondary daemons off the user's state |
| `OMP_DESKTOP_STATE_FILE` | `<state dir>/state.json` | explicit state-file path; overrides the directory |
| `OMP_DESKTOP_LEDGER_FILE` | `<state dir>/sessions.json` | durable live-session pool, separate from the client workspace; explicit stops remove entries |
| `OMP_DESKTOP_EXTENSION` | `../omp-mobile/extension.ts` | omp extension injected into every spawn (`-e`, can repeat); empty or missing disables the mobile structured state |
| `GDK_BACKEND` | auto: `x11,wayland` on Wayland with NVIDIA and XWayland, otherwise unset | explicit GTK backend list; any non-empty value disables the preference (e.g. `wayland`) |
| `OMP_MOBILE_IPC_DIR` | `$HOME/.local/state/omp-mobile` | directory for the per-runtime extension sockets (`<rt-id>.sock`); the mobile gateway reads the same default |
| `OMP_MOBILE_IPC_TOKEN` / `OMP_MOBILE_TOKEN_FILE` | `$HOME/.config/zellij/ompbox-mobile.token` | shared token for those sockets; spawned extensions also read the file directly, so a runtime started before the daemon saw a token still authenticates gateway calls |

Every spawned runtime gets `OMP_MOBILE_SLOT=<rt-id>` (its socket identity), so the phone reaches exactly the process
shown in the sidebar — same runtime ids, same session files, no second session pool.

## Terminal look

Terminal panes and app chrome use bundled **Hack**, with real regular and bold faces
(`public/fonts/`, MIT/Bitstream Vera). The terminal starts at 10pt (`13.33px`)
with fixed xterm.js `lineHeight: 1`; it does not depend on a host-installed text font.
Both panes keep identical text geometry when resized; only whole-row/column counts change.
The WebGL renderer uses xterm's custom box/block glyphs to join frame strokes and logo blocks
to cell edges, rather than relying on font glyphs. A **DOM** warning in the pane header means
GPU rendering is unavailable or its context was lost; that fallback can still show seams.
The fit measures the actual scrollbar reserve and accepts unused space smaller than a cell
instead of stretching the font or line spacing. Constants live at the top of `src/client.ts`;
`Ctrl/Cmd +`/`-`/`0` adjust the font size across panes (persisted in `localStorage` and the daemon's workspace state).

The app consumes OSC 8 `file://` link markers to avoid xterm's permanent dashed
path underline (its default handler cannot open file links). HTTP links and
explicit SGR underlining remain intact. Sidebar live sessions have a thin OMP-blue
left edge instead of indicator dots. Session PID labels and sidebar costs are hidden;
the omp TUI's own cost display is unchanged. Sidebar and terminal scrollbars share
a 6px track (40% thinner than the original 10px) and rounded grey thumb with the same hover colour.

While dragging, terminal selections use neutral grey (`#444444`) and retain the
original text colours. Highlighting stops at each line's last non-whitespace cell:
trailing padding and blank lines are not painted, while spaces within text remain
part of the highlight. Wide and combining characters keep their terminal-cell widths.
Releasing a left-button selection copies its text to the system clipboard and
clears the highlight after a successful copy. Empty/whitespace-only selections
clear without replacing the clipboard. If clipboard access is blocked, the
selection stays available for manual copy and the sidebar reports the failure.
Clipboard access requires browser permission and a secure context (localhost works).

`src/selection.ts` adapts xterm 6's private WebGL/DOM selection paint hooks because
the public API cannot express per-line highlight extents. Recheck both renderers
when upgrading xterm/addon-webgl, including normal/alternate buffers and wide text.

The daemon passes **no** config overlay: panes run with the user's own `~/.omp/agent/config.yml`, so glyphs, theme,
model roles and cost reporting are exactly what the same session shows in Konsole. (An earlier build forced
`symbolPreset: nerd` through a vendored overlay; that silently rewrote the status line with PUA icons the user never
chose, which read as random floating glyphs. `OMP_DESKTOP_OVERLAY` still exists for experiments, but is off by
default.)

The app vendors `JetBrainsMonoNerdFontMono-Regular.ttf` (`public/fonts/`, SIL OFL) and serves it from `/fonts/`,
gated by `unicode-range` to the private-use planes: it is the **Mono** patch of a real base
font, so its icons advance exactly one Hack cell (8.02px) and its ~8px ink sits inside that cell. Nerd Fonts'
*Symbols-only* builds render icons at ~1em ink with a 1em advance, which overflowed and clipped in a 0.6em cell.
`document.fonts` gates the first `fit()`, and a missing icon font is reported in the status chip instead of silently
rendering non-mono fallbacks.

The daemon serves its bundle with `cache-control: no-store` and publishes the content hash of the client bundle
**and** stylesheet at `/api/build`; the client polls that hash and reloads itself when it changes.
The global brand/build header is hidden; connection status sits at the bottom of the sidebar.
Asset changes require a daemon restart, which stops live processes.

## Chrome styling

The app chrome is [omp-mobile](../omp-mobile)'s design language, so the two clients read as one product: the palette
and font tokens in `public/styles.css` are copied **verbatim** from `omp-mobile/public/styles.css` (OLED black
`#000` page with `#0a0b0d`/`#121316`/`#1c1e22` surfaces, `#00b4ff` accent, `#d4c090` cost, `#00ff88`/`#ffb347`/
`#ff4757` status, `#e8ecf4` text on `#262a30` lines), and so are the treatments: raised-border buttons, black
bordered inputs that focus to accent and `2px` accent focus rings. Both terminal and UI text use
bundled Hack; DejaVu remains a bundled fallback. xterm's theme matches the palette
(`#000` background, `#e8ecf4` foreground, `#00b4ff` cursor, neutral grey selection).

The sidebar is one list: pinned chats first, then unpinned live and recent chats.
Use each row's pushpin icon (outlined when unpinned, filled and accented when pinned);
its tooltip and accessible label say **Pin chat** or **Unpin chat**. Pins persist by transcript path (browser cache plus
the daemon's workspace state file), survive stop/resume, and keep older chats reachable beyond the recent-session limit.
Rows label a chat with its transcript's recorded working directory, not the daemon's launch directory: resuming without
an explicit cwd spawns omp in the cwd stored in the transcript's `session` header (the launch cwd is only the fallback
when that directory no longer exists), and a live row prefers the transcript summary when the process was started elsewhere.
A new live chat becomes pinnable when omp reports its session file. Search still filters pins.
Running sessions have a thin `#00b4ff` left edge only, not a full accent outline.
Pane ownership remains in the meta line ("pane 2"); a running chat is not duplicated as a saved row.

Collapse with the sidebar's top-right button; the remaining narrow edge button reopens it.
Drag the divider to resize (190–560px, constrained by window width), double-click to reset.
The focused divider accepts Left/Right, Shift for larger steps, and Home/End.
Width and collapsed state persist locally; pane terminals refit as the sidebar changes.

Deviations, all density rather than looks: control heights are mouse-sized (22px
pane-header buttons vs 40px icon buttons), row cards do not lift `translateY(-1px)` on hover (it shimmers in a 60-row
list), and the pane area has no outer padding, square corners and no pane-body padding, so a terminal starts exactly
at the pane border with no gap around it. Update the tokens in both files together — the mobile stylesheet is the
source of truth.

## Layout

- `src/daemon.ts` — HTTP + websocket server; one `TEXT_ASSETS` dispatch for index/client/styles/xterm CSS, `/api/build`, `/api/state`, `/api/paste`, resume validation; owns the runtime pool and wires the optional mobile extension.
- `src/manager.ts` — `RuntimeManager`: the pool of live omp processes (spawn, list, kill, capacity cap).
- `src/runtime.ts` — one PTY-backed omp process: spawn, byte fan-out, bounded replay tail, byte-rate status, process-group kill.
- `src/sessions.ts` — full-store sidebar index: message-derived recency, stable creation fallback, `history.db` titles, 8 KiB headers, cached activity and cost scans.
- `src/sniff.ts` — OSC 1337 `omp_session_file` sniff: learns a freshly started session's file from the PTY stream.
- `src/state.ts` — durable workspace store: atomic, fsynced `state.json` writes behind `GET`/`PUT /api/state`.
- `src/protocol.ts` — wire types plus the boundary validators shared by daemon and client.
- `src/guards.ts` — `isRecord`, the shape guard every validator starts from.
- `src/client.ts` — xterm.js pane (binary output in, JSON input/resize out) plus the pane menu/split layout, pin list, and workspace mirroring.
- `src/lifecycle.ts` — saved live intent, legacy binding migration, daemon-generation reconciliation and deduplicated pane resume decisions.
- `src/sidebar.ts` — persisted sidebar collapse/resize controls.
- `src/selection.ts` — text-bounded selection painting for WebGL and DOM renderers.
- `scripts/smoke.ts` — end-to-end acceptance test; one `withDaemon` lifetime helper per scenario set.
- `scripts/install-app.ts` — installs the built native release binary and per-user application-menu entry.
- `src-tauri/` — native shell: `main.rs` entry, `daemon.rs` daemon identity probe and systemd start, `shell.rs` window policy, `bootstrap/` connection page.

Cleanup note (behavior-preserving): dead helpers/exports removed (`headerButton`, `renderFocus`, `liveTitle`, `bindings`, `isString`/`isFiniteNumber`/`isBoolean`, `Runtime.exit`, the `Runtime` replay-limit constructor parameter); sidebar rows use one `sessionByPath` lookup map plus one `paneForRuntime` map instead of repeated `find`/`some` scans, and layout rendering walks the tree once per call; static responses share the `TEXT_ASSETS` dispatch and `no-store` headers; smoke starts one daemon per scenario set through `withDaemon`.
