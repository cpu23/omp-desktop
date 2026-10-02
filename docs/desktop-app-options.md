# omp Desktop App — Requirements & Options

Date: 2026-10-02. Status: decision input for moving off the zellij workflow.
Scope: desktop app hosting omp sessions; Linux/Wayland first (this machine).

**Decision (2026-10-02): build from scratch.** No omp GUI inside the app: the app hosts real
`omp` CLI/TUI processes in panes. The desktop daemon is the source of truth (owns PTYs,
sessions, layout); the GUI is a client, and the existing mobile webapp becomes another client.
Fork options A/B below are kept for reference only. Architecture: see
[desktop-architecture.md](./desktop-architecture.md).

## 1. Requirements (from user)

| ID | Requirement | Acceptance |
|----|-------------|------------|
| R1 | Desktop app host, not a terminal multiplexer | Native window on Linux/Wayland running omp sessions |
| R2 | Session sidebar | Live + recent omp sessions listed with title/status/project; click to focus (like Codex desktop / the omp-mobile slot list) |
| R3 | Pasted image viewing | Paste into composer, thumbnail in transcript, click for full-size — replacing today's literal `[image]` |
| R4 | State saving | Sessions resume mid-conversation after restart; app layout + pane assignments restore; ideally running sessions survive window close |
| R5 | Split sessions | Several concurrent omp sessions visible side by side |
| R6 | Swappable panes | Drag a session onto a pane and/or a recent-session picker per pane; no typing `/resume` inside a pane |
| R7 | 4-way splits | 2×2 grid at minimum, more panes if cheap |
| R8 | Keep omp capability | Subagents/Hub, model + effort, approvals, notifications; mobile webapp ideally keeps working |

## 2. Environment and hard facts

- omp `18.4.9` at `/home/mrw/.local/bin/omp`. Modes: interactive TUI, `-p/--print`, `--mode=text|json|rpc|rpc-ui`, `acp`. No HTTP serve/daemon subcommand.
- Sessions: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`; global blobs `~/.omp/agent/blobs/<sha256>` for images; `history.db` title index; resume by path or id prefix; `--session-dir` for scoping.
- RPC mode (`omp --mode rpc`, docs: <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md>) is newline-JSON over stdio and already exposes: `prompt`/`steer`/`follow_up` with `images`, `switch_session`, `new_session`, `get_messages_page`, `get_entries`, `get_state`, model/thinking, subagents (`get_subagents`, `steer_subagent`), extension UI requests (`select`/`input`/`editor`/`confirm`), host tools. `rpc-ui` keeps tool UI such as `ask` enabled. This is the documented path community GUIs use.
- SDK (`@oh-my-pi/pi-coding-agent`) supports in-process embedding and multiple concurrent top-level sessions (private `AgentRegistry` per session).
- `packages/collab-web` in the omp repo is MIT and standalone: transcript entries, markdown, per-tool React renderers, composer, subagent panel; consumes `@oh-my-pi/pi-wire` and is reused by HTML session exports. Directly reusable UI prior art: <https://github.com/can1357/oh-my-pi/tree/main/packages/collab-web>.
- No first-party GUI. The GUI request is open and unresolved: <https://github.com/can1357/oh-my-pi/issues/5742>.
- Tern (Stencil, same devs): closed beta/waitlist; build targets include `linux`/`linux-musl` x86_64, and the CEO says Linux is usable from v0.2.4 (`x.com/_can1357/status/2105537028461084712`). Native daemon terminal, sessions outlive the window, panes/layouts, kitty graphics, TSP native omp rendering, `tern split|run|capture`, `tern events`, `tern web serve`, `tern remote serve` (QUIC). No public docs/SDK beyond the CLI; no evidence of session-drag-to-pane or a session sidebar; omp changelog (18.4.6) notes attached images open in Tern's image viewer.
- Current setup: zellij `0.45.1` local fork + `omp-zellij-pane` per-pane wrapper + `omp-minimal-bar` wasm plugin + a fixed 6-slot layout. Zellij's plugin API *can* move panes across tabs, open a command pane in place of a pane id, and do runtime 4-way splits, and zellij serializes sessions — but there is no global pointer stream, so drag-and-drop across panes is impossible; pane↔session binding is fixed by layout args.
- `omp-mobile` today: in-process omp extension per pane over a Unix socket (`GET /state`, `POST /action`: prompt/abort/model/effort/theme/move/summary) + Bun gateway + zellij `dump-screen` for terminal text; fixed slots; no session CRUD; images render as `[image]`; polling; web-push notifications.

## 3. Options

### A. Fork nornzach/oh-my-pi-gui (Electron + React)
<https://github.com/nornzach/oh-my-pi-gui> — 44★, MIT, active daily, Linux AppImage/deb.
Has: up to 10 tabs each with its own sidecar, two-pane split with drag-tab-to-split, layout restore across restarts, session library/search/forks, images/math/Mermaid renderers, models/roles/providers, stats, command palette.
Gaps: split caps at two panes; no session→pane drag or per-pane recent picker; no notifications; bundles a sidecar built from a fork of omp (upstream sync cost); Electron.
Effort: extend the 2-pane split into an N-pane grid and add drag/recent-picker + layout persistence. Closest base to "everything but the panes".

### B. Fork apoc/omp-desktop (Tauri 2 + Rust + React)
<https://github.com/apoc/omp-desktop> — 69★, MIT, active, Linux AppImage/deb/rpm. One `omp --mode rpc` child per tab, sidebar/history/resume, image paste with full-size viewer, per-session journal replay.
Gaps: no panes at all; renderer/feature breadth not verified equal to A; notifications absent.
Effort: build the pane manager from zero (tabs→panes), but on a lighter, Rust-native stack. Best long-term engineering base, more greenfield.

### C. From scratch: session daemon + `omp --mode rpc` + collab-web renderers (+ Tauri/Electron shell)
Architecture (proven by two community projects): a daemon owns exactly one `omp --mode rpc` process per session with a WebSocket/JSON bridge; the app renders transcripts with vendored MIT collab-web renderers; panes are views over the daemon's session runtimes.
Prior art: `MhAhmadAli/omp-gui` (Bun daemon + RPC per session + React SPA, vendors collab-web, Docker) and `ddallabenetta/omp-web` (omp SDK in-process, sidebar, image drag/drop, fork/branch; no splits).
Pros: exact pane semantics wanted, no fork debt, wire-format alignment via `@oh-my-pi/pi-wire`, can share a backend with the mobile webapp. Cons: must build composer, session library, settings/providers, approvals/extension-UI mapping, packaging — months, not weeks.

### D. Tern as the base/backend
Gives: daemon persistence (omp mid-conversation after reboot), native TSP rendering of omp components, image viewer, pane/layout presets + scripting (`tern split/run/capture`, events), remote/web/iOS clients.
Does not give: a session sidebar, drag session→pane, arbitrary pane swaps, public API/docs, or Linux GA. It is a terminal, so swapping the session *inside* a pane is still an in-terminal resume or a new process.
Verdict: join the waitlist now; treat as a future terminal/remote backend, not the app base.

### E. Third-party agent hosts (stopgap/benchmark)
- Superset (<https://github.com/superset-sh/superset>): Linux x64 AppImage (experimental), PTY agents, omp listed "fully supported", sidebar with status, infinite splits, drag tab onto a split drop zone, scrollback survives restarts. Elastic License 2.0, paid seats. Closest product to the brief today.
- Nimbalyst (Linux, best session management, but fixed layout; omp support unproven), Sculptor (Linux, MIT, any terminal agent, image paste, tabs not panes), Zed (Linux/Wayland, Terminal Threads + sidebar + notifications + image paste; no panes, threads don't stay live), Warp, cmux TUI (detachable headless server).
- None satisfies R5–R7 with omp-session semantics; useful as short-term fallbacks.

### F. Keep zellij, add a smarter plugin/app
Possible via the plugin API (pane move across tabs, `open_command_pane_in_place_of_pane_id`, 4-way splits, serialization) but drag-and-drop cannot work (no global pointer events), and pane swaps still mean restarting a pane process with `omp --resume`. Only viable if R6 is relaxed.

## 4. Comparison

| | A fork nornzach | B fork apoc | C scratch | D Tern | E Superset |
|---|---|---|---|---|---|
| Sidebar sessions | yes | yes | build | no (file tree) | agent list, not omp sessions |
| Images paste/view | yes | yes | via blobs+renderers | yes (terminal viewer) | undocumented |
| State save (layout) | yes (tabs) | sessions only | build | panes/daemon yes | scrollback yes |
| Splits | 2 panes | none | any (4-way) | presets/N-way? | infinite |
| Drag session→pane | partial (tab→split) | no | build | no | tab→split |
| omp fidelity | forked sidecar | `--mode rpc` | `--mode rpc`/SDK | TSP native | PTY TUI |
| Linux | yes | yes | yes | beta, v0.2.4+ | experimental x64 |
| License | MIT | MIT | own | closed beta | ELv2 |
| Effort to R1–R8 | M | L | XL | blocked | not a base |

## 5. Design note (applies to A/B/C)

A "session" must have exactly one runtime (one omp process/RPC channel) because two processes on one session file would conflict. Therefore: **panes are views over session runtimes, not processes**. Drag-and-drop and the per-pane recent-session picker reparent a view (or attach the pane to another existing runtime); they must never start a second writer for the same session file. Layout state (grid tree + pane→session) is app-owned JSON; session content stays in `~/.omp`.

## 6. Recommendation

1. Day-0 spike: run the A and B Linux builds on this machine; verify Wayland, omp 18.4.9 compatibility, image paste, resume, and inspect how hard the tab→pane refactor is in each codebase.
2. Default route: **fork A (nornzach) if velocity matters** — it already ships renderers, session library, images, layout restore; replace its 2-pane split with a small N-pane tree (up to 4+), add session→pane drag + recent-session picker + layout JSON. Choose **B (apoc, Tauri)** if Electron is unacceptable; more pane work, cleaner stack.
3. Take **C** only if owning the stack matters more than time; vendor collab-web renderers and reuse this repo's extension/gateway protocol knowledge (plus notifications) for the daemon.
4. Join the Tern waitlist now; re-evaluate when Linux GA + CLI docs land. Try Superset as a stopgap if a usable app is needed this week.
