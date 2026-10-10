# Desktop guide

For the short setup steps, see the [README](../README.md).

Desktop client for [omp](https://omp.sh) coding sessions. A small Bun daemon owns real `omp` TUI processes on
PTYs; a native window (Tauri 2 / WebKitGTK) or any browser tab renders them in up to four panes with a session
sidebar. The agent is never re-implemented — every pane is the actual TUI, so the app keeps working across omp
updates.

- **Daemon + PTY pool** — several `omp` sessions at once, byte-transparent I/O, resize, a bounded replay tail
  (512 KiB) for late attach.
- **Session sidebar** — pinned, live and recent chats from omp's own store, search, and per-session accent /
  **Working…** / **Done** indicators supplied by the injected `omp-mobile` extension.
- **Panes** — 1×1 → 1×2 → 2×2, drag a session onto a pane, drag a pane header to swap two panes, draggable
  dividers, and one terminal WebSocket per pane.
- **Sessions survive** window close and daemon restarts: the daemon keeps a durable live-session ledger and
  resumes recorded transcripts (running tasks and unsaved input cannot be restored).
- **Image paste** — `POST /api/paste` stores the image, the pane types its path, and omp attaches it; images
  render inline through the forced iTerm2 protocol.

Historical design material (proposals and dated measurements from development, not a specification):
[`docs/desktop-architecture.md`](desktop-architecture.md),
[`docs/desktop-app-options.md`](desktop-app-options.md),
[`docs/desktop-reqs.txt`](desktop-reqs.txt).

## Repository layout

omp-desktop is one half of a pair; the mobile client lives in a sibling checkout:

```
<parent>/
├─ omp-desktop/      # this repository — daemon, browser client, native shell
└─ omp-mobile/       # mobile gateway + PWA + the omp extension this daemon injects
```

The daemon injects `../omp-mobile/extension.ts` into every spawned `omp` by default. With the sibling missing the
app still works — panes stream and the sidebar falls back to file-based discovery; only the structured
accent/Working/Done state and the mobile client's structured actions are unavailable. Set `OMP_DESKTOP_EXTENSION`
to another path, or to an empty string to disable it. `bun run release:check` requires both sibling checkouts;
the desktop-only `bun run smoke` also works without the companion.

## Requirements

- Linux. The browser client runs anywhere Bun runs; the native shell is Linux-only.
- **Bun ≥ 1.3.0** (`package.json` `engines`); install from <https://bun.sh>.
- The **OMP CLI** on `PATH`, or `OMP_DESKTOP_OMP` pointing at it. This project targets OMP 18 (tested with
  18.8.4). The daemon only relies on stable surfaces — terminal bytes, `--resume <path>`, environment variables —
  so terminal streaming is not tied to a specific release; the injected extension consumes OMP 18's
  `theme.sessionAccentInputs` token and silently drops accents / structured status when the host does not expose
  it. Re-check the mirrored accent algorithm when upgrading OMP.
- First-time OMP users: run `omp` in a terminal and complete its provider setup before using Mobile for prompts.
  A fresh home with no credentials opens OMP's provider-login screen; Desktop displays that screen unchanged,
  while Mobile's raw terminal is read-only. Provider credentials stay in OMP's own store and are not supplied
  by either app.
- For the native shell: Rust/Cargo and the WebKitGTK 4.1 build dependencies (below).

## Quick start (browser)

```sh
bun install
bun run start     # serves http://127.0.0.1:4180
```

Open `http://127.0.0.1:4180` and click **+ New session**, or resume a recent chat from the sidebar. Panes run
with your own `~/.omp/agent/config.yml`; the daemon never modifies your omp configuration. No service, systemd
unit or pre-existing state is required.

The daemon reads and writes only these locations (all overridable; see [Configuration](#configuration)):

| Path | Purpose |
| --- | --- |
| `$XDG_STATE_HOME/omp-desktop/state.json` | workspace mirror (layout, pins, settings) |
| `$XDG_STATE_HOME/omp-desktop/sessions.json` | durable live-session ledger used for restore |
| `$TMPDIR/omp-desktop-pastes/` | pasted images |
| `~/.omp/agent/sessions` | read-only: session index and resume validation |
| `~/.local/state/omp-mobile/` | per-runtime extension sockets (created when the extension runs) |

History refreshes scan all transcript metadata before sorting by conversation activity, searching, and limiting the
visible rows. Parsed headers, activity, and costs are cached by path, modification time, and size in bounded
1,024-entry caches; external history titles are refreshed independently. Directory reads, file stats, summary
tasks, and cost reads each use at most eight workers per listing rather than launching work for the whole store
at once.

Development commands:

```sh
bun run check   # typecheck
bun test        # unit/regression tests
bun run smoke   # end-to-end daemon + PTY pool check (needs a real omp on PATH; runs in a disposable temp HOME)
```

The smoke command selects an unused local port (or checks `OMP_DESKTOP_SMOKE_PORT` if supplied) and does not
inherit configuration-path overrides or provider credentials. It launches test processes only; it does not
control your running daemon or user services.

### Fresh-install release check

With both sibling Git checkouts present, Bun, Git, and the OMP CLI installed, run:

```sh
bun run release:check
```

This snapshots the current public working-tree files (including uncommitted edits), installs both projects
with frozen lockfiles in a temporary workspace, runs their typechecks/tests and Desktop's PTY smoke, builds
Mobile, and verifies token creation/reuse plus authenticated Mobile → Desktop runtime start/state/stop.
Tracked files covered by the ignore rules cause a refusal rather than being copied into the test workspace.
The command uses a fresh HOME/XDG tree, private token/socket/state/paste paths, and unused loopback ports.
It stops only the processes it starts and deletes its temporary workspace, including test credentials.

Native release build/install/launch, provider authentication, and real-device push delivery are separate
checks. The native build needs the Linux dependencies below; provider and push credentials are deliberately
not inherited by `release:check`.

## Native Linux app

The native shell is a thin window over the same loopback daemon: it reuses the daemon and its sessions, does not
bundle Chromium, and does not install a service. System WebKitGTK is the default engine; the optional app-private
high-refresh runtime is described [below](#advanced-app-private-high-refresh-webkitgtk).

Install Rust/Cargo and the native build dependencies first. On Ubuntu/Debian:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev libdbus-1-dev
```

From `omp-desktop/`:

```sh
bun install
bun run app          # development native window (tauri dev)
bun run app:build    # release build only
bun run app:install  # release build + per-user application-menu launcher
```

`app:install` copies the binary to `~/.local/bin/omp-desktop`, writes `omp-desktop.desktop` under
`$XDG_DATA_HOME/applications` (default `~/.local/share/applications`), and installs the π icon as
`$XDG_DATA_HOME/icons/hicolor/scalable/apps/sh.omp.desktop.svg`. The desktop-entry filename matches GTK's Wayland
app ID (`omp-desktop`), so KDE associates the window with the correct icon. After installation, open **OMP
Desktop** from the application menu or run `~/.local/bin/omp-desktop`; re-run `app:install` to update the shell.
This installs a client only — the WebKitGTK runtime libraries must remain installed.

To uninstall the shell, remove `~/.local/bin/omp-desktop`, the `omp-desktop.desktop` entry and the installed
`sh.omp.desktop.svg` icon. Sessions, daemon state and the daemon itself are untouched.

### How the shell finds the daemon

The app connects to `http://127.0.0.1:4180` (set `OMP_DESKTOP_PORT` when launching the app to use another
port). If nothing answers and an `omp-desktopd` systemd user unit exists, the shell starts that unit; it never
installs, restarts or stops it. No unit is required — running `bun run start` in a terminal is enough, and custom
ports require an already-running daemon. Connection failures appear in the window with a retry action.

Closing the window leaves the daemon and its sessions running. Launching the app again reuses the existing
window and requests focus (subject to the compositor's focus policy). Browser and native-window storage are
separate: pane layouts, pins, sidebar width and font size are not imported between them, but both clients share
the daemon's live/recent sessions and mirror their workspace to the daemon's durable state file, so a native
window whose webview storage was lost rebuilds its panes, pins and settings from that file on boot.

Click plain-text HTTP(S) URLs or labelled terminal hyperlinks to open them in your default browser; both pass
their destination directly to the native navigation policy, without xterm's confirmation/blank-popup flow. File
links remain disabled, and the daemon page receives no native IPC permissions. In the browser client the same
links open in a separate tab with no opener access. Clipboard image paste and pane dragging depend on the
compositor and are not verified on every desktop.

On Wayland sessions with the NVIDIA driver loaded and a local XWayland socket available, the shell prefers
`GDK_BACKEND=x11,wayland` before GTK initializes (X11 first, Wayland as fallback). Any explicit `GDK_BACKEND`
value wins, so `GDK_BACKEND=wayland` opts out; WebGL, hardware acceleration and DMABUF settings are untouched.
Close and reopen the app after changing backends.

## Mobile companion (omp-mobile)

The two projects connect in one direction — the phone is another client of this daemon, not a second session
pool:

- The daemon spawns each runtime with `omp -e ../omp-mobile/extension.ts` and `OMP_MOBILE_SLOT=<runtime id>`. The
  extension serves a per-runtime Unix socket (`<state dir>/<runtime-id>.sock`) for that exact process.
- The mobile gateway (in `omp-mobile`) is an HTTP client of this daemon (`OMP_MOBILE_DESKTOP_URL`, default
  `http://127.0.0.1:4180`): it lists the same runtimes, starts/resumes/stops them, and serves the installable PWA
  to the phone.
- The desktop reads the extension's `/status` endpoint on its 2.5 s runtime poll for sidebar accents and
  working/done indicators; terminal repaints never imply agent activity. Without the extension the indicators are
  omitted rather than guessed.
- Deploy both checkouts together, and restart the daemon only when no session is running.

**Token.** The extension sockets are owner-only (`0600` inside a `0700` directory) and additionally require a
shared token when one is configured: `OMP_MOBILE_IPC_TOKEN` / `OMP_MOBILE_TOKEN`, or the file named by
`OMP_MOBILE_TOKEN_FILE`. The default `$HOME/.config/zellij/ompbox-mobile.token` is a legacy path kept for
existing installations. New setups can point the daemon and the mobile gateway at a portable location (for
example under `$XDG_STATE_HOME`) by setting the same `OMP_MOBILE_TOKEN_FILE` for both; if they disagree, the
gateway's calls are rejected. Spawned extensions read the token file themselves, so a runtime started before the
daemon saw a token still authenticates gateway calls.

## Security boundaries

- The daemon binds loopback only (`OMP_DESKTOP_HOST`, default `127.0.0.1`) and **has no authentication on its
  HTTP/WebSocket API**. Any local process can list, spawn, stop and read sessions. Keep it on loopback: do not
  point `OMP_DESKTOP_HOST` at a LAN or public interface, and avoid running it on a multi-user host where local
  users are untrusted.
- Resume is fenced: only real `.jsonl` files under `OMP_DESKTOP_SESSIONS_DIR` are accepted, so a request cannot
  make the daemon run an arbitrary path.
- The paste endpoint accepts only `image/png`, `image/jpeg`, `image/webp` and `image/gif` up to 32 MiB and writes
  only inside `OMP_DESKTOP_PASTE_DIR`.
- Native shell: the window may navigate only between the bundled connection page and the daemon origin;
  everything else opens in the system browser. The daemon origin is remote content and gets no native IPC
  permissions — only the local connection page can call the `connect` command, and it re-checks the caller.
- Extension sockets are owner-only and, when a token is configured, every request must present it
  (`x-omp-mobile-token` header or `Authorization: Bearer`). An ownership record prevents serving a socket that
  was replaced by another process.
- The daemon serves its client bundle and stylesheet with `cache-control: no-store` and publishes a build hash at
  `/api/build`.

## Configuration

Every variable is optional; defaults match a normal single-user machine.

| Variable | Default | Meaning |
|---|---|---|
| `OMP_DESKTOP_HOST` | `127.0.0.1` | listen address. Loopback only: the API is unauthenticated |
| `OMP_DESKTOP_PORT` | `4180` | listen port |
| `OMP_DESKTOP_MAX_RUNTIMES` | `8` | cap on live `omp` processes in the pool |
| `OMP_DESKTOP_CWD` | `$HOME` | fallback working directory for new sessions; a resume uses the transcript's recorded cwd, with this value only the fallback when that directory is gone |
| `OMP_DESKTOP_OMP` | `omp` | omp binary (overridable for tests) |
| `OMP_DESKTOP_OMP_ARGS` | empty | extra arguments for the omp binary |
| `OMP_DESKTOP_OVERLAY` | empty (no overlay) | optional `--config` overlay for experiments; omp otherwise runs with the user's own config |
| `OMP_DESKTOP_SESSIONS_DIR` | `$HOME/.omp/agent/sessions` | session store used by the sidebar index and resume validation |
| `OMP_DESKTOP_PASTE_DIR` | `$TMPDIR/omp-desktop-pastes` | destination for pasted images |
| `OMP_DESKTOP_STATE_DIR` | `$XDG_STATE_HOME/omp-desktop` (or `~/.local/state/omp-desktop`) | directory for the durable `state.json` workspace mirror; point it elsewhere to keep tests or secondary daemons off your state |
| `OMP_DESKTOP_STATE_FILE` | `<state dir>/state.json` | explicit state-file path; overrides the directory |
| `OMP_DESKTOP_LEDGER_FILE` | `<state dir>/sessions.json` | durable live-session pool, separate from the workspace document; explicit stops remove entries |
| `OMP_DESKTOP_EXTENSION` | `../omp-mobile/extension.ts` | omp extension injected into every spawn (`-e`, can repeat); empty or missing disables the mobile structured state |
| `OMP_MOBILE_IPC_DIR` | `$HOME/.local/state/omp-mobile` | directory for the per-runtime extension sockets (`<runtime-id>.sock`); the mobile gateway reads the same default |
| `OMP_MOBILE_IPC_TOKEN` / `OMP_MOBILE_TOKEN` | unset | shared token for the extension sockets; when unset, `OMP_MOBILE_TOKEN_FILE` is read |
| `OMP_MOBILE_TOKEN_FILE` | `$HOME/.config/zellij/ompbox-mobile.token` | token file (legacy default path kept for existing installations; point both the daemon and the mobile gateway at a portable path for new setups) |
| `GDK_BACKEND` | auto: `x11,wayland` on Wayland with NVIDIA and XWayland, otherwise unset | native shell GTK backend list; any non-empty value disables the preference (e.g. `wayland`) |
| `PI_FORCE_IMAGE_PROTOCOL` | `iterm2` | image protocol passed to omp so images render in xterm.js |

Every spawned runtime also gets `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=tern` (so omp emits
the OSC 1337 session-file marker the sidebar sniffs), `OMP_DESKTOP_RUNTIME=<id>` and `OMP_MOBILE_SLOT=<id>`.

## Behavior notes

**Panes.** Right-click any pane for the layout-wide split action (`Ctrl+Shift+E`); the first use turns 1×1 into
1×2, the next splits both columns into 2×2, and at four panes the action is disabled. `Ctrl+Shift+X` closes a
pane — closing a view never stops its session. In a 2×2 grid, closing one pane keeps the quadrant as an empty
slot with **new session here** (select or drag a sidebar session into it); closing a second occupied pane
collapses back to two side-by-side panes. Switch sessions by focusing a pane and clicking a sidebar session, or
drag a session onto a pane; drag a pane header onto another pane to swap them. Escape or a click outside dismisses
the menu.

**Sessions and the sidebar.** Closing and reopening the app reattaches surviving processes without changing their
PIDs. The daemon restores every ledger-recorded transcript before serving runtime requests, including sessions
with no pane open; concurrent resume requests for one transcript share one process, and explicit stops are
removed immediately. Pins persist by transcript path, survive stop/resume, and keep older chats reachable beyond
the recent-session limit. Session ages and ordering use the last user/assistant message timestamp, not file
modification time or terminal output. Sidebar live rows show the CLI's per-session accent and working/done
indicators, with a **Motion: System / On / Off** control that only affects animations (native defaults to On,
browsers to System, which honors `prefers-reduced-motion`).

**Rendering.** Terminal and chrome text use bundled fonts under `public/fonts/` (Hack regular/bold, with
JetBrainsMono Nerd Font Mono restricted to private-use icon planes and bundled DejaVu Sans Mono as the fallback),
so rendering does not depend on host fonts. Panes use xterm.js 6 with the WebGL addon; if WebGL is unavailable or
its context is lost, a visible **DOM** warning marks the fallback. `Ctrl/Cmd +`/`-`/`0` adjust the shared font
size. The app chrome reuses omp-mobile's palette and tokens verbatim; update both stylesheets together.

**Client bundle.** The daemon bundles the client and stylesheet at startup, serves them with
`cache-control: no-store`, and publishes their content hash at `/api/build`; open tabs reload themselves when the
hash changes. Applying client or style changes therefore requires a daemon restart, which ends live PTY children
— transcript-backed sessions resume on the next start.

**Not yet.** Daemon-owned multi-client pane layout (the mobile gateway drives the same live runtimes and the
desktop mirrors its workspace to the daemon, but the pane grid is not yet a layout service other clients read),
idle session unload, desktop notifications, and mirroring the pane grid on the phone.

## Advanced: app-private high-refresh WebKitGTK

System WebKitGTK is the default. For higher refresh rates with streaming terminals, `scripts/build-webkit.ts`
pins Ubuntu WebKitGTK **2.52.6** and GTK **3.24.52**, applies their distribution patch sets plus two local
patches (timer-backed display monitor uses the monitor refresh rate; GTK's X11 paint clock uses the monitor rate
when compositor feedback is absent; NVIDIA keeps DMA-buffer imports disabled but keeps the shared-memory
compositor transport), and builds only into a user cache/prefix. The system libraries, loader configuration, GTK
themes and input-method modules are not replaced, WebKit's process sandbox stays enabled, and the copied app
executable gets a private ELF RUNPATH instead of exporting `LD_LIBRARY_PATH`.

A fresh machine needs the distribution's WebKitGTK/GTK development dependencies plus Clang/LLD, CMake, Ninja,
Meson, Ruby, Bison, Flex, gperf, unifdef, gettext, sassc and patchelf; the script does not install system
packages. Without `OMP_DESKTOP_WEBKIT_SYSROOT` it uses the build tools and dependencies already installed on the
host. From `omp-desktop/`:

```sh
export OMP_DESKTOP_WEBKIT_PREFIX="$HOME/.local/share/omp-desktop/webkitgtk-2.52.6-refresh1"
bun run app:webkit:build
bun run app:install
# With an extracted sysroot, put its tools first for the install step:
#   PATH="$OMP_DESKTOP_WEBKIT_SYSROOT/usr/bin:$PATH" bun run app:install
```

`OMP_DESKTOP_WEBKIT_JOBS` defaults to 4 compilation jobs (linking is limited to one). `OMP_DESKTOP_WEBKIT_CACHE`
changes the build-cache root. Completed prefixes contain `runtime.json`; the installer refuses incomplete
runtimes, and changing patches requires a **new prefix** rather than overwriting libraries a running app may
still be using. Close and reopen the app after installation — no daemon restart is needed. To return to system
WebKitGTK:

```sh
env -u OMP_DESKTOP_WEBKIT_PREFIX bun run app:install
```

Private engines do **not** receive system package security updates: re-pin source versions/checksums, rebase the
two patch files, build a new prefix and reinstall when WebKitGTK/GTK updates are needed. Do not remove an old
runtime prefix while an app or its helper processes still use it.

## License

MIT — see [`LICENSE`](../LICENSE).

Bundled fonts under `public/fonts/` keep their own licenses:

- Hack (regular/bold) — MIT/Bitstream Vera; [`LICENSE-Hack.txt`](../public/fonts/LICENSE-Hack.txt)
- JetBrainsMono Nerd Font Mono — SIL OFL; [`LICENSE-JetBrainsMonoNerdFont.txt`](../public/fonts/LICENSE-JetBrainsMonoNerdFont.txt)
- DejaVu Sans Mono — Bitstream Vera license, DejaVu changes public domain, Arev-derived glyphs © Tavmjong Bah; [`LICENSE-DejaVu.txt`](../public/fonts/LICENSE-DejaVu.txt)
