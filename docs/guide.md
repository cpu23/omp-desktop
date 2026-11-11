# Desktop guide

See the [README](../README.md) for the quick start.

OMP Desktop runs the actual `omp` TUI in PTYs managed by a local Bun daemon. Browser tabs, the GTK4/WebKitGTK 6
Linux window, and the Tauri 2 macOS/Windows windows are clients of that daemon; panes display terminal output rather
than re-rendering conversations. The optional `omp-mobile` extension supplies structured status and mobile actions.

## Requirements and browser setup

- Bun 1.3+, Git and OMP 18.13.1+ on `PATH`; set `OMP_DESKTOP_OMP` to use a different binary. Complete OMP's provider
  setup by running `omp` once. Desktop uses OMP's own configuration and credentials and does not modify them.
- The browser client needs a host that supports Bun and PTYs. Linux uses GTK4/WebKitGTK 6 for its native window;
  macOS and Windows retain the Tauri shell.

From the checkout:

```sh
bun install --frozen-lockfile
bun run start
```

Open <http://127.0.0.1:4180>. Keep the daemon terminal running while using the browser client. No system service
or prior state is required.

For optional phone integration, keep `omp-desktop` and `omp-mobile` in sibling directories. The daemon uses
`../omp-mobile/extension.ts` when present. Without it, terminal sessions still work and saved-session discovery
falls back to OMP transcript files, but structured status and mobile actions are unavailable. Set
`OMP_DESKTOP_EXTENSION` to another file or an empty string to disable the extension. Deploy matching versions
together; restart the daemon only when no session is running.

## Native Linux app

The Linux shell is a GTK4/WebKitGTK 6 application over the same local daemon. It uses the system GTK and WebKit
libraries; it does not bundle a browser engine or install a service. The supported API baseline is GTK 4.14 and
WebKitGTK 6.0 version 2.44. Install Rust 1.92 or newer with Cargo, `pkg-config`, a C toolchain, and these Ubuntu/Debian
development packages:

```sh
sudo apt install build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev
```

From `omp-desktop/`:

```sh
bun install --frozen-lockfile
bun run app          # GTK4 development shell on Linux
bun run app:build    # locked release binary
bun run app:install  # release binary and per-user launcher
```

On macOS and Windows, `app` and `app:build` continue to use the local Tauri CLI.

`app:install` installs `~/.local/bin/omp-desktop`, an application-menu entry at
`$XDG_DATA_HOME/applications/sh.omp.desktop.desktop` (default `~/.local/share/applications/sh.omp.desktop.desktop`),
and an icon under `$XDG_DATA_HOME/icons/hicolor/scalable/apps/sh.omp.desktop.svg` (default
`~/.local/share/icons/hicolor/scalable/apps/sh.omp.desktop.svg`). Re-run it to update the shell. To uninstall,
remove those three installed files; the daemon and its state are unaffected. The system GTK4/WebKitGTK 6 runtime
libraries must remain installed. Private WebKit runtime prefixes are no longer supported; the installer rejects a
nonempty `OMP_DESKTOP_WEBKIT_PREFIX`.

The shell connects to `http://127.0.0.1:4180` (override with `OMP_DESKTOP_PORT` when launching it). If no daemon
answers, it starts an existing `omp-desktopd` systemd user unit, if present; it never installs, restarts, or stops
that unit. Otherwise run `bun run start` yourself. A custom port requires a daemon already running on that port.
Closing the window leaves sessions running. Browser and native webview storage are separate, but both use the
same daemon and its workspace mirror.
A requested restart is delegated to `systemctl --user restart` only when this process is the main program of the
detected user unit (`MainPID` matches); a daemon merely running inside a terminal that belongs to a service
restarts itself instead of that service. Set `OMP_DESKTOP_SYSTEMD_UNIT` to force a unit name explicitly.

The GTK shell selects Wayland automatically when `GDK_BACKEND` is unset and the session is Wayland; X11 remains
available. When `GSK_RENDERER` is unset it defaults to `gl`. Only when the resulting backend is exactly `wayland`,
the shell defaults `WEBKIT_FORCE_DMABUF_RENDERER=1` unless a conflicting WebKit DMA-BUF override is present.
Explicit nonempty environment values are respected; set `WEBKIT_FORCE_DMABUF_RENDERER=0` to disable the default
for diagnosis. The shell does not automatically relaunch with another backend or renderer after graphics failure.

## Sessions, spaces and panes

Create spaces with **+** in the top bar. Each space has its own layout (up to four panes); drag a pane header or
a sidebar session onto another space's tab to move/open it there. Right-click a pane and choose **Split**, or use
the top-right split button: 1×1 becomes side-by-side, then 2×2. The button previews the next layout and disables at
four panes. Panes meet at a single 1px separator with no gutter or duplicate borders;
drag on or just beside the separator to resize. In a 2×2 grid, closing one pane leaves an empty
slot; closing another occupied pane collapses the grid. New-session controls and newly split panes
start regular live OMP terminals immediately, without a first message. Clicking a saved sidebar session opens its read-only history.

The sidebar's magnifying-glass button opens search over its heading row, with the search icon on the left and
a close button on the right. Close it with **×** or **Escape** to clear the filter and restore the full list.
Workspace sessions are indented beneath their folder. The sidebar edge has no permanent border; hover or focus
its resize handle to reveal it.

Saved conversations render read-only history through `omp render`, with at most two history requests active at once.
Output is spooled to a private temporary file before streaming to the pane, so large transcripts and inline images
do not lose their final messages when the renderer exits. The temporary output is removed after delivery or cancellation.
No resident agent or model request is started, and the transcript is not modified.
Opening an unloaded session or clicking its pane focuses the draft; there is no Send button.
Type and press **Enter** to resume a saved agent; **Shift+Enter** inserts a newline.
Typing alone never starts an agent. History selection, scrolling and links remain usable.
Drafts and attachment references survive navigation; unconfirmed input is retained for review, never automatically resubmitted.

Cold submission transitions the conversation from unloaded to **Starting**, not immediately to a usable loaded session.
The daemon waits for the parsed initial clear-screen frame, an available idle IPC endpoint and the matching transcript
before submitting the prompt. The pending composer is disabled; a startup timeout or failure preserves its draft for
explicit retry, including if the process finishes initializing later. No prompt is automatically retried.
Live panes remain input-disabled until server readiness, replay completion and the local terminal parser's write fence.
The 10-second diagnostic changes the status text only; it never unlocks an uninitialized terminal.
Desktop sets `PI_TUI_NATIVE=0` because xterm does not implement Tern Surface Protocol. This avoids the unsupported
native-rendering fallback race without disabling native-shell GPU acceleration.

Closing a pane or space only detaches its view; execution continues. For live runtimes, the daemon keeps a
terminal-state mirror and restores its screen,
scrolling margins (DECSTBM) and cursor visibility when a pane reconnects, along with up to 20,000 history rows and
retained inline images. Replay follows the producer's resize history instead of parsing a truncated raw-output tail
at the latest size. Encoded image sidecars are capped at 128 MiB per runtime and 512 MiB across the daemon; the oldest
images may be evicted while their reserved rows remain. Scrollback grants share an aggregate cell budget, accounting
for actual columns and both visible terminal buffers, and are rebalanced on creation, resize and release.
The client separately caps decoded image pixels at 128 MB per pane. Cache eviction can leave a checkerboard
placeholder. Partial image-row deletion preserves surviving tiles through scrolling redraws; images are released
when their remaining rows leave history or the cache limit requires eviction. Text erasure also releases images
whose last tile disappeared, including between image insertions in one parser write, so erased redraws do not
evict still-visible charts. Fractional-height terminal rows use disjoint pixel-aligned clearing and drawing bounds
to avoid leaving a strip of pixels after text overwrites an image.
Use the sidebar stop action to terminate a session. Only live sessions are recorded in a durable
ledger and resumed from their OMP transcripts after a daemon restart; the old processes are not preserved, and
in-flight work or unsaved input cannot be restored. Each transcript has one live process at a time; attaching an
existing session reuses its process. On first upgrading from a daemon that predates the ledger, checkpoint its
live pool with `bun run scripts/checkpoint-sessions.ts` before restarting. The command does not stop processes;
finish their current work before the restart.

**Idle unloading:** the default grace period is 60 minutes, checked once per minute by the daemon, including for
sessions that have no attached view. Change **Settings → Sessions → Idle timeout (minutes)** to apply a new
nonnegative whole-minute value immediately; **0** disables automatic unloading.

Eligibility comes from OMP's authoritative session, tool, async-job and agent-registry state, not quiet terminal
output. Running execution (including sleeps), admitted submissions, retry/compaction, background jobs, pending
result delivery, active subagents, named Bash services, queued messages, dialogs/approvals and unsent terminal
input all protect the session. Unavailable, incompatible or unknown activity state fails closed: keep it loaded.
An unload rechecks activity immediately before calling the SDK's graceful shutdown; it never escalates to a signal.
The idle clock starts only after protected work settles.

Unloaded sessions leave the live ledger and remain cold after daemon restart. Their history stays readable;
the next explicit submission resumes from disk. This releases the agent process and terminal resources, not
memory owned by an independent local model server.

Explicit stop allows 500 ms for graceful termination before forcing a still-owned child to exit.
A successful stop response waits for process cleanup and resource release, so its slot can be reused immediately.
Natural exits also release capacity, after final output has passed the parser/subscriber boundary.
On Linux, initial process-group signals require a verified original PTY leader identity; if it cannot be verified,
only the PTY child is targeted. If the leader exits during graceful termination, escalation checks for remaining
members of its original process group and session before signaling them. A reused leader PID is rejected;
descendants that leave the original group are not targeted. Daemon shutdown waits for bounded child cleanup
as well as ledger writes.
Bun's frozen-lockfile install applies the checked-in `bun-pty@0.4.11` patch automatically. It releases native
PTY handles after genuine exits, preserving final output without synthesizing a second exit event.

Spaces, focus and pane layouts are stored in the browser profile and mirrored in the daemon's workspace state.
Browser and native profiles do not share local settings, but the daemon workspace mirror can restore layout,
pins and settings if webview storage is lost. The live-process limit is shared across spaces (default 16).
The client bundle and stylesheet are built at daemon startup; restart the daemon to apply changes, which also
ends its PTY children. Only ledgered live sessions resume on its next start; unloaded conversations remain cold.
Production assets are minified, gzip-compressed and cache-validated; fingerprinted URLs are immutable, while HTML
and canonical URLs revalidate. Fonts use WOFF2, and production JavaScript does not include inline source maps.
Unchanged sidebar nodes are retained, periodic polling pauses while hidden, and workspace writes are coalesced.
Local edits made while the daemon is unavailable survive reconciliation with its older workspace document.
When scrolled at least one screen above the latest output, a double-down-chevron button appears in the pane.
Click **Jump to latest** to return to the bottom and focus the terminal.

History browsing stays above OMP's mutable live screen so streaming redraws cannot overwrite the lower half
of a scrolled viewport. Scrolling up from live output moves back at least one screen; scrolling down into the
live region returns to latest. Until a full screen of committed history exists, the pane stays live.
Output continues to be parsed while reading history; it is not paused or discarded.
The terminal uses Unicode 15 grapheme widths so emoji and joined emoji occupy the same table columns as OMP.

Terminal panes use WebGL on hardware and unknown renderers. Recognized software rasterizers (including
SwiftShader and llvmpipe) use the existing DOM renderer instead; its **DOM** indicator warns that box/block
glyphs may have seams. Masked or unavailable renderer information does not disable WebGL.
Unchanged terminal snapshots are reused for subsequent attaches until output or geometry changes. Cached snapshots
have per-runtime and aggregate byte budgets; a snapshot too large to cache still replays completely, uncached.
Slow WebSocket readers receive ordered replay, live bytes and exit metadata. A reader that exceeds the bounded
pending-live queue is disconnected for resynchronization rather than silently losing bytes.

### Clipboard and file drops

In a terminal, **Ctrl+C** with no selection sends Escape rather than the Ctrl+C byte, so repeated presses cannot
trigger OMP's session-exit shortcut. Existing selection-copy behavior is unchanged; unselected **Ctrl+Shift+C**
does nothing. Use the sidebar's **Unload session** action to stop a session deliberately.

Ctrl/Cmd+V and Ctrl+Shift+V are handled by the webview. Text paste retains xterm's bracketed-paste behavior;
image paste uploads to the daemon, which stores the image and types its path into the terminal for OMP to attach.
Supported types are PNG, JPEG, WebP and GIF, up to 32 MiB. The daemon forces the iTerm2 image protocol for
inline rendering. Clipboard permission errors appear in the status area; large images can take longer for OMP
to decode.

OMP's iTerm2 images omit the optional file-size field. The desktop supplies the exact decoded size before
passing these images to the image addon. A pinned `@xterm/addon-image@0.9.0` patch also recognizes WebP
(lossy, lossless and extended headers), which OMP can emit for screenshots. Upstream recognizes only PNG,
JPEG and GIF; without the patch, WebP payloads are silently discarded and leave empty image-sized bands.
Both live output and replay use the same decoder, resizing rules and pixel limits. Frozen-lockfile installs
apply this patch automatically. Restart the daemon after updating dependencies and reload the client to use
the rebuilt bundle; wait for active work to finish first, since restarting ends its PTY children.

The replay mirror preserves the producer's saved cursor during image repaint. When an upward image move
clamps at the viewport or scroll margin, it records the actual parsed image origin rather than assuming
that moving down reverses the move. This prevents repeated redraws from inserting blank history rows.
The client draws only the surviving bottom slice of a clamped iTerm2 image, rather than painting its hidden top
back over later text. Replay carries that visible-row budget in the inline-image header, so reconnecting at a
different screen position cannot bring the hidden part back. Rows already inserted or lost by an older daemon
remain damaged in that daemon's history; a client reload does not repair them.

For a systemd installation, check `systemctl --user cat omp-desktopd` before deploying: `WorkingDirectory`
and `ExecStart` must point to the updated checkout, not an older branch or worktree.
Run `bun install --frozen-lockfile` there before restarting. Updating a different worktree, or reloading the app alone, does
not replace the JavaScript bundle held in the running daemon. Restart only after active work has finished:
ledgered live chats resume, but in-flight tools and unsaved terminal input do not. Unloaded chats remain cold.

Drop files onto a pane to insert quoted paths without submitting them. The native window uses original paths for
all file types and does not upload file contents. In browsers, if security hides a file's path, only images can
fall back to upload; other pathless files are ignored. Paths containing control characters are rejected.
In a cold composer, paths remain draft references until you submit with **Enter**. Supported PNG, JPEG, WebP and GIF files
are read then and attached to the model request, within the existing 32 MiB image limit; other files remain path references.

### Sidebar, settings and shortcuts

The default **Workspaces** view groups sessions by their directory, showing the directory basename once in the
group heading and compact title-only rows beneath it. Hover a heading to see its full path. In the native app,
click the folder-plus **Add workspace** icon to open the system directory chooser at your home directory.
Cancel leaves the list unchanged; choosing the same directory again selects the existing workspace.
Added workspaces remain visible even without sessions. Selection and collapsed groups persist across reloads
and are included in the daemon's durable sidebar mirror.
Workspaces show six sessions initially; when a seventh exists, **Show more (N)** reveals the remaining sessions
in that workspace and focuses the first newly revealed row. Reloading returns to the six-row default.
Search shows every matching session without applying this six-row cutoff.

Hover a workspace heading (or focus it with the keyboard) to reveal **+** and start a session in that directory.
The header **+** uses the selected workspace, falling back to the daemon's default directory when none is selected.
Each workspace heading also has a **⋯** menu. **Archive workspace** hides that workspace and its sessions from
both sidebar views, without deleting transcripts or stopping running sessions. The archive preference survives
reloads and is included in the durable sidebar mirror. Add the same directory again to restore it.
**Show folder** opens the directory in the operating system's file browser and requires the native desktop shell.

Browser clients can use saved
workspaces, but adding a directory requires the native desktop shell; the browser reports this rather than
pretending an upload picker can return an absolute local directory.

Running and saved sessions appear together, with pinned sessions first and then newest conversation activity.
Opening a running session reattaches to its existing process; opening a saved session reads its transcript without
loading an agent. Only explicit submission creates or resumes the agent.
Working and unread-completion indicators remain authoritative extension state. Stopping a process does not
delete its saved conversation. Settings offers a flat **Sessions** view with **Pinned** and **Sessions** sections,
where rows retain directory subtitles. Hover or focus within a row to reveal pin and stop controls.
The sidebar stays open and remains resizable.
Pane title bars retain their compact single-line layout without a bottom border. Only the close and pin icons
match the sidebar controls; they appear on hover or keyboard focus. Pinning updates both surfaces;
closing a pane only detaches its view and does not stop the session.

Settings separates **Appearance**, **Notifications**, **Sessions**, and **Keyboard shortcuts**. Shortcut editors
are grouped into Panes, Spaces, and Terminal text; expand a group to edit its bindings, then save.

The sidebar supports search, pins and opt-in completion notifications. Working/completion indicators and
per-session accents come from the optional extension, not terminal output. Notifications default to off,
require OS/browser permission, and are not replayed when reopening the app. Browsers deliver web notifications
while the page is open; the native shell uses OS notifications.
Working sessions show a spinner immediately before the shimmering session title, with no separate “Working…” label.
The Motion setting still controls animation; long titles truncate without squeezing the subtitle.
The spinner and title shimmer use transform animations, a fixed glyph strip and a counter-translated gradient mask:
no per-frame JavaScript, glyph replacement or geometry reads. Hidden documents, collapsed rows and the settings view
suspend animation; Motion **Off** retains the existing settled appearance.

Saved-session header, activity and cost caches each have an approximate 8 MiB budget. Listings still scan
file metadata to detect new, changed, replaced and deleted transcripts; unchanged cached files do not need
their contents reread. Activity ordering and search cover the complete store, not just the visible rows.
Cost accounting reads newly appended journal bytes instead of rescanning an unchanged prefix. Truncation and atomic
file replacement invalidate the accumulated total; this assumes OMP's append-only journal/atomic-rewrite contract.
Externally rewriting interior bytes while also growing a file is not guaranteed to invalidate an incremental total.
Concurrent listings share indexing work, and responses are capped at 200 rows without narrowing search coverage.

Set a custom **Session limit** in Settings. The limit is shared by all windows and spaces and is saved by the
daemon, not just the browser profile. A saved change that differs from the running limit shows **Restart now**;
restart when current work has finished. Restarting interrupts running work and loses unsaved input, then resumes
ledgered live sessions from their transcripts. Reverting the setting to the running value removes the restart prompt.
While a lowered change awaits that restart, the daemon already refuses new sessions beyond the saved limit —
session-less allocations included — so the restart cannot silently drop one. Reattaching a session that is
already live is unaffected.
When capacity is reached, the error explains the limit: stop an unused session, let it unload safely, or increase
the limit in Settings. Reading saved history does not occupy a live-session slot.

Default shortcuts:

| Action | Keys |
| --- | --- |
| Select space 1–9 | `Alt+1` through `Alt+9` |
| Increase font | `Ctrl+=`, `Ctrl+Plus`, `Meta+=`, `Meta+Plus` |
| Decrease font | `Ctrl+-`, `Ctrl+Shift+Minus`, `Meta+-`, `Meta+Shift+Minus` |
| Reset font | `Ctrl+0`, `Meta+0` |
| Split layout | `Ctrl+Shift+E`, `Meta+Shift+E` |
| Close focused pane | `Ctrl+Shift+X`, `Meta+Shift+X` |
| Toggle selected pane focus | `Ctrl+Shift+F`, `Meta+Shift+F` |

Edit shortcuts under sidebar **Settings → Keyboard shortcuts**. Use commas for sequence presses and semicolons
for alternative bindings (for example, `Ctrl+K, Ctrl+1`). The first press must include Ctrl, Meta, Alt or Shift;
sequences time out after one second. Bindings are stored in the local browser/app profile.

Toggle pane focus expands the selected terminal to fill the workspace; press the same shortcut again to restore
the split layout and its divider ratios. Other sessions keep running with their existing processes. This
temporary presentation does not change the saved layout; switching spaces, changing the layout, or reloading
returns to the split view. A single-pane space is unchanged by the toggle.

## Configuration

All variables are optional. Defaults below assume a single-user machine.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_DESKTOP_HOST` | `127.0.0.1` | Daemon listen address; keep it on loopback because the API has no authentication. |
| `OMP_DESKTOP_PORT` | `4180` | Daemon and native-shell port. |
| `OMP_DESKTOP_MAX_RUNTIMES` | `16` | Initial process limit across all spaces; a custom limit saved in Settings takes precedence. |
| `OMP_DESKTOP_IDLE_TIMEOUT_MINUTES` | `60` | Idle-unload grace period; nonnegative whole minutes, `0` disables. A custom idle timeout saved in Settings takes precedence and applies without restart. |
| `OMP_DESKTOP_REPLAY_ROWS_PER_RUNTIME` | `20000` | Per-runtime scrollback ceiling, subject to the shared cell budget. |
| `OMP_DESKTOP_REPLAY_CELLS_TOTAL` | `33554432` | Aggregate terminal cells, including both visible buffers and granted scrollback. |
| `OMP_DESKTOP_IMAGE_BYTES_PER_RUNTIME` | `134217728` | Encoded image-sidecar budget per runtime. |
| `OMP_DESKTOP_IMAGE_BYTES_TOTAL` | `536870912` | Encoded image-sidecar budget across runtimes. |
| `OMP_DESKTOP_SNAPSHOT_BYTES_PER_RUNTIME` | `8388608` | Cached replay snapshot budget per runtime; larger snapshots are served uncached. |
| `OMP_DESKTOP_SNAPSHOT_BYTES_TOTAL` | `67108864` | Aggregate cached replay snapshot budget. |
| `OMP_DESKTOP_SYSTEMD_UNIT` | auto-detected | Unit the daemon delegates its restart to; set explicitly for unusual unit names or non-user services (bypasses the `MainPID` ownership check). |
| `OMP_DESKTOP_CWD` | `$HOME` | New-session directory and fallback if a resumed transcript's recorded directory is gone. |
| `OMP_DESKTOP_OMP` | `omp` | OMP executable. |
| `OMP_DESKTOP_OMP_ARGS` | empty | Extra space-separated executable arguments. |
| `OMP_DESKTOP_OVERLAY` | empty | Optional OMP `--config` overlay; by default the user's OMP configuration is used unchanged. |
| `OMP_DESKTOP_SESSIONS_DIR` | `$HOME/.omp/agent/sessions` | Session index and resume validation root. |
| `OMP_DESKTOP_PASTE_DIR` | `$TMPDIR/omp-desktop-pastes` | Stored pasted images. |
| `OMP_DESKTOP_PASTE_BUDGET_BYTES` | `536870912` | Pasted-image directory quota, at least 32 MiB; also capped at 4096 files. Full storage returns `507` without deleting existing images. |
| `OMP_DESKTOP_STATE_DIR` | `$XDG_STATE_HOME/omp-desktop` or `~/.local/state/omp-desktop` | Directory for durable workspace state and session ledger. |
| `OMP_DESKTOP_STATE_FILE` | `<state dir>/state.json` | Explicit workspace-state path; overrides the directory for this file. |
| `OMP_DESKTOP_LEDGER_FILE` | `<state dir>/sessions.json` | Explicit durable live-session ledger path. |
| `OMP_DESKTOP_SETTINGS_FILE` | `<state dir>/settings.json` | Daemon-owned custom session limit and idle timeout, shared by browser and native windows; each field overrides its environment default independently. |
| `OMP_DESKTOP_EXTENSION` | `../omp-mobile/extension.ts` | Optional OMP extension path; empty or missing disables structured mobile state. |
| `OMP_MOBILE_IPC_DIR` | `~/.local/state/omp-mobile` | Per-runtime extension socket directory. |
| `OMP_MOBILE_IPC_TOKEN` / `OMP_MOBILE_TOKEN` | unset | Shared socket token; if unset, the token file is used. |
| `OMP_MOBILE_TOKEN_FILE` | `~/.config/zellij/ompbox-mobile.token` | Legacy token-file path. Set the same portable path for Desktop and Mobile in new installs. |
| `GDK_BACKEND` | automatic Wayland selection when unset in a Wayland session; otherwise GTK default | GTK backend for the Linux shell; explicit values are respected. |
| `GSK_RENDERER` | `gl` | GTK renderer used by the Linux shell when unset. |
| `WEBKIT_FORCE_DMABUF_RENDERER` | `1` only when the selected `GDK_BACKEND` is exactly `wayland` and no conflicting WebKit override is set | WebKit DMA-BUF renderer setting for the Linux shell; explicit values are respected. |
| `PI_FORCE_IMAGE_PROTOCOL` | `iterm2` | Inline image protocol passed to OMP. |

The sessions directory is read-only for Desktop's indexing and resume checks; OMP writes transcripts. Workspace
state and the live-session ledger are separate files.
These budgets limit retained terminal/cache data, not total daemon RSS or the memory of OMP child processes.
Individual pasted and inline images permit up to 32 MiB of encoded image data; the client separately limits decoded
pixels. Existing pasted files count toward the directory quota and are never automatically deleted.

The default token-file path is retained for existing installations. Extension sockets use an owner-only directory
and socket; when a token is configured, both Desktop and Mobile must use the same one. Set `OMP_MOBILE_IPC_TOKEN`,
`OMP_MOBILE_TOKEN`, or `OMP_MOBILE_TOKEN_FILE` to configure it.

## Local API and verification

The API remains loopback-only and unauthenticated; do not expose it directly to a network.

| Route | Contract |
| --- | --- |
| `GET /api/runtimes` | Runtime list, default-directory metadata and current daemon `generation`; exited and unloaded runtimes leave the pool. |
| `GET /api/runtimes/:id/screen` | Parser-fenced `{cols, rows, screen}` for the visible plain-text screen; no history serialization or resize. |
| `POST /api/runtimes/:id/input` | `{data: string}`, at most 16,384 UTF-16 code units and a 128 KiB request body. Returns 503 without writing while the runtime is starting. |
| `DELETE /api/runtimes/:id` | Stop and release the runtime before returning success. |
| `GET /api/sessions/history` | Stream ANSI history for a validated saved-session path and viewport; read-only, without a resident agent. |
| `POST /api/sessions/request` | `{path?, cwd?, text, files?}`; create/resume only for this explicit request. Wait for terminal and idle IPC readiness, then respond after SDK admission, not model generation. Startup timeout does not dispatch the prompt. File references preserve inline image attachments. Maximum HTTP body and serialized IPC envelope (including transcript path and attachment paths) 128 KiB each. Oversize requests return 413 without dispatch. Fresh transcript paths are known only after startup; a final oversize rejection attempts safe idle cleanup. |
| `GET /api/settings` | Desired/effective process limits, idle timeout and whether a restart is required. |
| `PUT /api/settings` | Partial `{maxRuntimes?, idleTimeoutMinutes?}`; idle changes apply immediately, process-limit changes retain restart semantics. |
| `PUT /api/state` | Workspace document; requires `X-OMP-Generation` from the current runtime-list response. Missing or stale generations return `409`. |

Polling JSON routes support conditional ETags and gzip. Input producers must split larger text at Unicode-safe
boundaries; the browser client does so before sending. WebSocket application queues are bounded to 4 MiB of pending
live data and 4096 frames, with lazy replay encoding and native backpressure/drain handling.

Runtime status is `starting` until its first parsed terminal frame; thereafter it is `idle` or `streaming`.
WebSocket clients process `hello` and replay, then a `ready` control event if initialization was still pending.
An already-ready `hello` needs no separate `ready` event. Ordinary `input` is rejected without acknowledgement during
startup. A separate validated `terminalReply` message carries only terminal-negotiation replies so startup cannot
deadlock while user input is locked; it does not count as user activity. Browser clients additionally wait for
`replayDone` and a local terminal write callback before accepting user input.

Run `OMP_MOBILE_CHECKOUT=/path/to/omp-mobile bun run release:check` from the Desktop checkout for paired verification.
It checks the invoking worktree and the chosen companion in a disposable home, including frozen installs, typechecks,
tests and real OMP extension/process smoke checks. It does not verify the native shell, provider login or real push delivery.

## Security and limitations

- The daemon binds to loopback by default and its HTTP/WebSocket API has no authentication. Any local process can
  list, start, stop and read sessions. Do not expose it to a LAN/public interface or run it on a host with
  untrusted local users.
- Resume requests accept only real `.jsonl` files under `OMP_DESKTOP_SESSIONS_DIR`. Image uploads are limited to
  the types and size above and written only under `OMP_DESKTOP_PASTE_DIR`.
- Native navigation is restricted to the connection page and daemon origin; other links open in the system
  browser, and file links are disabled. Daemon-origin content receives only notification-plugin permissions.
- Configured extension tokens are required on every socket request. Socket ownership checks prevent using a
  socket replaced by another process.
- Idle-session unloading is enabled by default after 60 minutes; set the timeout to `0` to disable it. Each live
  session is an OMP process; daemon restarts terminate those processes and restore recorded transcripts, not running
  tasks or unsaved input. The phone client is session-centric; the desktop's pane layout is not a mobile layout service.
- Native clipboard-image paste, pane dragging and WebGL behavior depend on the desktop environment and are not
  verified on every compositor.

## Checks

```sh
bun run check
bun test
bun run smoke
bun run smoke:images
```

`smoke:images` needs Playwright's WebKit browser and native dependencies: install them once with
`bunx playwright install --with-deps webkit`. It checks actual image-layer pixels in WebKit (DOM) at 1×, 1.25×,
1.5× and 2× display scales. Coverage includes PNG/WebP, text erasure, partial deletion, batched cache pressure,
clamped upward redraws, margins, history scrolling, resize, and repeated replay followed by live output. Its
temporary home, local fixture server and browser contexts do not use the user's daemon, sessions or credentials.
Pull-request CI runs this browser matrix; the native smoke separately exercises the GTK4/WebKitGTK 6 shell.

### Native GTK smoke

Build the native binary with `bun run app:build`, then run the real-shell scenarios with:

```sh
bun run smoke:native -- --images
```

The full runner uses isolated fixture daemons, profiles and a private D-Bus notification service. It needs
`WebKitWebDriver`, `dbus-daemon`, Python 3 with PyGObject, AT-SPI (`at-spi2-core` and `gir1.2-atspi-2.0`), Xvfb,
`xdotool`, `xprop` (`x11-utils`), `wmctrl`, `xclip`, `scrot`, and Openbox. The driver package is `webkitgtk-webdriver`
on Ubuntu 26.04; older Ubuntu releases use `webkit2gtk-driver`.

On Ubuntu 24.04, `bwrap: setting up uid map: Permission denied` can indicate AppArmor is blocking the user namespace
required by WebKit's sandbox. See [Ubuntu bug 2144531](https://bugs.launchpad.net/ubuntu/+source/bubblewrap/+bug/2144531)
for the narrow `/usr/bin/bwrap` AppArmor profile approach; merge the `userns` permission into an existing profile
rather than replacing stricter rules. Keep the WebKit sandbox enabled and do not disable user-namespace restrictions
globally. The application installer does not modify system AppArmor policy.

`ENABLE_WEBDRIVER=OFF` is a WebKitGTK library build option that can leave `WebKitWebDriver` available for navigation and DOM
inspection without native mouse/keyboard actions. The runner uses actual `xdotool` OS events for native input; no JavaScript
click or keyboard fallback is used. The full input scenarios require X11 (provided by the fixture-owned Xvfb). The focused real-PTY input case is:

```sh
bun run smoke:native -- --input-only
```

`bun run smoke:native -- --notification-only` uses the normal production binary (without WebKit automation mode) and
real X11 controls inspected through AT-SPI. It verifies notification opt-in, GIO delivery, action-to-focus, identity
deduplication, UI Off behavior, and same-profile preference/workspace/live-PTY persistence. The full `--images` run
includes the same normal-mode checks. Controlled WebKit automation sessions are ephemeral and reject
`Notification.requestPermission()`; they cannot prove local profile persistence, so those behaviors are deliberately
tested only in the normal production application.

The production GTK WebView reuses the Linux profile under `$XDG_DATA_HOME/sh.omp.desktop`
(`~/.local/share/sh.omp.desktop` by default) and cache under `$XDG_CACHE_HOME/sh.omp.desktop`
(`~/.cache/sh.omp.desktop`). Before the first launch after upgrading, close the old desktop shell; never run
old and new shells concurrently against the same profile. The app does not reset or migrate profile data
automatically; preserve it and investigate an offline backup if reuse fails.

For native WebGL image verification on a Wayland desktop, leave `GDK_BACKEND`, `GSK_RENDERER`, and WebKit DMA-BUF
overrides unset and run:

```sh
bun run smoke:native -- --images-only --require-gpu
```

That run opens the real GTK/WebKit shell on the current display and exercises shared DOM and WebGL image assertions;
it does not exercise keyboard or pointer input. WebKitGTK may mask `UNMASKED_RENDERER_WEBGL` as `Apple GPU`. That label
alone is not accepted as hardware evidence: masked NVIDIA rendering is corroborated from the owned WebKit process's
NVIDIA driver mappings, DRM/NVIDIA device descriptors, and matching `nvidia-smi` graphics-process data. X11 input
and Wayland rendering are intentionally separate coverage levels. Real file-manager drag-and-drop and normal-desktop
notification delivery remain separate manual hardware/user-session checks; the runner's injected file-drop event is
not OS DnD proof.


`smoke` needs a real OMP executable (or `OMP_DESKTOP_OMP`) and runs in a disposable home with a local test daemon;
it does not control a user's running daemon or services. With both sibling checkouts, Git and OMP installed,
`bun run release:check` snapshots current public working-tree files, installs both projects with frozen lockfiles,
runs their typechecks/tests and Desktop's PTY smoke, builds Mobile, and checks shared-token creation/reuse plus
authenticated Mobile-to-Desktop start/state/stop. It uses private state, sockets and loopback ports, refuses
tracked files covered by ignore rules, inherits no provider credentials, and removes its temporary workspace
after stopping only processes it started. Native installation and real-device push delivery are separate.


## License

MIT; see [`LICENSE`](../LICENSE). Bundled font licenses: [Hack](../public/fonts/LICENSE-Hack.txt),
[JetBrainsMono Nerd Font Mono](../public/fonts/LICENSE-JetBrainsMonoNerdFont.txt), and
[DejaVu Sans Mono](../public/fonts/LICENSE-DejaVu.txt).
