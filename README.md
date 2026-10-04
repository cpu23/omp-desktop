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

Restarting the daemon kills running panes: sessions persist on disk and come back through the sidebar's recent list
or a dead pane's resume button, but the processes themselves do not survive (`systemctl --user restart omp-desktopd`
is a hard reset, not a reload). After a machine reboot the panes come back labelled with the transcript each held and
offer **resume this session** in one click; the client never replaces a restored pane with a fresh session just
because no runtime is live, and the daemon's `state.json` mirror restores the workspace even when the browser profile
was cleared. The mirror is only written after the client has read it (or proven it absent), so a failed read or a newer document version cannot be overwritten by this browser's fallback state. Running tasks and unsaved prompt buffers are not pretended to survive.

Each pane owns exactly one terminal WebSocket. Selecting its current session keeps that connection;
switching sessions closes the old stream before attaching the new one. Late events from replaced
sockets are ignored, and a new connection resets the terminal before replay. This prevents repeated
sidebar selections or pane swaps from multiplying terminal output, mixing sessions, and increasing
typing/render latency. Browser verification reproduced six open streams in one pane before the fix;
afterward eight repeated selections kept one stream, and repeated cross-session switches left only
two open streams for two panes (all twelve replaced connections closed).

Restart verification: two saved panes, their transcript paths, focus, a pin and font size survived a
fresh daemon and clearing browser storage; the resume action reopened the original transcript.
Sidebar collapse/expand changes also reach the durable mirror without another workspace action.
These persistence checks used Chromium and real omp terminals; native backend and rendering verification
is described below.

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

The shell uses the system **WebKitGTK** webview and the existing daemon; it does not bundle a browser or another
session backend. Install Rust/Cargo and the native build dependencies first. On Ubuntu/Debian:

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
Clipboard/image paste and pane dragging have not yet been exercised in the native window; compositor-driven focus
activation is not guaranteed.

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
- `src/sessions.ts` — sidebar session index over omp's session store (`history.db` titles, 8 KiB header scan, memoized per-transcript cost cache).
- `src/sniff.ts` — OSC 1337 `omp_session_file` sniff: learns a freshly started session's file from the PTY stream.
- `src/state.ts` — durable workspace store: atomic, fsynced `state.json` writes behind `GET`/`PUT /api/state`.
- `src/protocol.ts` — wire types plus the boundary validators shared by daemon and client.
- `src/guards.ts` — `isRecord`, the shape guard every validator starts from.
- `src/client.ts` — xterm.js pane (binary output in, JSON input/resize out) plus the pane menu/split layout, pin list, and workspace mirroring.
- `src/sidebar.ts` — persisted sidebar collapse/resize controls.
- `src/selection.ts` — text-bounded selection painting for WebGL and DOM renderers.
- `scripts/smoke.ts` — end-to-end acceptance test; one `withDaemon` lifetime helper per scenario set.
- `scripts/install-app.ts` — installs the built native release binary and per-user application-menu entry.
- `src-tauri/` — native shell: `main.rs` entry, `daemon.rs` daemon identity probe and systemd start, `shell.rs` window policy, `bootstrap/` connection page.

Cleanup note (behavior-preserving): dead helpers/exports removed (`headerButton`, `renderFocus`, `liveTitle`, `bindings`, `isString`/`isFiniteNumber`/`isBoolean`, `Runtime.exit`, the `Runtime` replay-limit constructor parameter); sidebar rows use one `sessionByPath` lookup map plus one `paneForRuntime` map instead of repeated `find`/`some` scans, and layout rendering walks the tree once per call; static responses share the `TEXT_ASSETS` dispatch and `no-store` headers; smoke starts one daemon per scenario set through `withDaemon`.
