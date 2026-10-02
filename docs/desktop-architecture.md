# omp Desktop — Architecture (from scratch, daemon-owned TUI panes)

Date: 2026-10-02. Implements the decision in [desktop-app-options.md](./desktop-app-options.md):
GUI outside omp, real `omp` CLI/TUI processes in panes, desktop daemon is the source of truth.
Status: design ready for a P0 spike. Sources for every borrowed idea are linked in §12.

## 1. Principle

- The app never re-renders the agent's conversation. Each pane is a **real terminal attached to a real `omp` TUI process**.
- A **daemon** owns PTYs, session runtimes, layout state, and history. The GUI (desktop window, mobile webapp, later anything)
  is a client. Window close ≠ sessions stop; app restart ≠ sessions lost.
- zellij is removed from the loop; `omp-mobile` becomes a client of this daemon (same wire contract, new transport).

## 2. Topology

```
┌─ clients ─────────────────────────────────────────────┐   ┌─ daemon: omp-desktopd (Bun) ──────────────────────────────┐
│ Desktop window (webview: xterm.js grid + sidebar)     │◄──┤ HTTP (RPC) + WebSocket (topics, seq/delta/snapshot)      │
│ Mobile PWA (existing omp-mobile UI, new client)       │   │  ├─ RuntimeManager: N × omp TUI in PTY (bun-pty)          │
└───────────────────────────────────────────────────────┘   │  │    each: raw byte log (bounded) + live fan-out         │
                                                            │  ├─ SessionIndex: omp SessionManager/SDK + history.db     │
                                                            │  ├─ LayoutStore: state.json (split tree, pane bindings)   │
                                                            │  ├─ Notifications (port of notifications.ts)              │
                                                            │  └─ per-runtime extension socket ◄── omp desktop extension│
                                                            └───────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Choice | Why / evidence |
|---|---|---|
| Daemon runtime | **Bun 1.3** | Existing stack (`server.ts`), omp runs on Bun ≥1.3.14; can import `@oh-my-pi/pi-coding-agent` for session indexing |
| PTY | **`bun-pty`** (MIT, Rust `portable-pty` over FFI) | node-pty has no supported Bun path ([node-pty#632](https://github.com/microsoft/node-pty/issues/632)); Bun's built-in `Bun.Terminal` lacks `setsid`/`TIOCSCTTY` ([bun#33237](https://github.com/oven-sh/bun/issues/33237)). Fallback: 200-line Rust helper with `portable-pty` behind the same PTY interface |
| Terminal renderer | **xterm.js** + addon-image, fit, web-links, unicode11, clipboard | ZCode ships `@xterm/xterm 6`; addon-image 0.9.0 stable renders **SIXEL + iTerm2**, kitty only in 0.10 betas and without unicode placeholders ([inventory](https://github.com/xtermjs/xterm.js/discussions/5683)) |
| In-pane images | spawn omp with `PI_FORCE_IMAGE_PROTOCOL=iterm2` (or `sixel` + `PI_ALLOW_SIXEL_PASSTHROUGH=1`) | Both verified in the omp 18.4.9 binary; stable addon-image path. Kitty path revisited if 0.10 lands placeholders |
| Shell | **deferred** — P0–P2 run as localhost webapp/PWA; P3 wraps in Tauri 2 (or Electron) | Removes shell risk from the critical path; Tauri byte transport = `ipc::Channel`; Electron is the proven terminal performer (ZCode) |
| Client transport | WS topics with monotonic seq + bounded delta log + snapshot resync; HTTP POST for commands | Stolen from OmpCode `sessionIndexTopics.ts` / `topicPublisher.ts`; beats omp-mobile's 2–8s polling |
| Auth | loopback only + launch token → signed HttpOnly cookie, Host/Origin fence | OmpCode's relay has no auth (`127.0.0.1:8765`); dsh's model is stronger ([connection README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)) |
| omp integration | TUI via PTY **plus** a desktop extension (fork of `extension.ts`) over a per-runtime unix socket | Extension gives structured state/actions (title, status, session file, cost, capabilities); PTY gives the real UI |

## 4. Data model

```
Runtime {            # one omp TUI process = one live session
  id, sessionFile, cwd, title, status, generation, pid,
  pty: { cols, rows }, logPath, lastActivity, attachedClients[]
}
Layout {
  tree: Node,                      # split tree: {split: "h"|"v", ratio, a, b} | {leaf}
  leaf: { id, content: { kind: "runtime", runtimeId } , focus?: bool },
  maxPanes: 4                      # ≤4 like ZCode/OmpCode
}
RecentSessions = SessionManager.listAllForPicker()   # ~/.omp/agent/sessions/*, history.db titles
```

**Invariant: at most one Runtime per `sessionFile`.** omp holds a cross-process write lease; a second process that writes
the same session forks to a sibling file with `parentSession` ([session.md](omp://session.md) §persistence). Attaching an
already-live session **rebinds the pane to that runtime**; it never spawns a second writer. An explicit "Fork here" action
spawns a real omp fork and is labeled as such.

## 5. Key flows

- **New/resume runtime**: `omp [--resume <abs sessionFile>]` in PTY, env `TERM=xterm-256color`, `OMP_DESKTOP_RUNTIME=<id>`,
  `PI_FORCE_IMAGE_PROTOCOL=iterm2`, extension path + socket dir. cwd from the saved session.
- **Attach**: replay the tail of the runtime's raw byte log into a fresh xterm, then live stream; one client per pane owns
  input/resize, others read-only (dsh `terminal-controller` model).
- **Swap session into pane**: drop target `(session, pane)` → if `session` has a live runtime, rebind leaf to it; else spawn
  `--resume` and bind. The displaced runtime keeps running (pool) and stays in the sidebar with its scrollback.
- **Recent-session picker per pane**: `SessionManager.listForPicker()` + `history.db` search; pick = swap flow above.
- **4-way split**: split tree op (ratio via CSS var so splitting never remounts live xterms — ZCode `workbenchLayout.ts`).
- **Session tracking inside a pane**: extension `session_start/switch` events are authoritative; optional `TERM_PROGRAM=tern`
  makes omp emit OSC 1337 `omp_session_file` (verified in CHANGELOG 18.4.4), which we can sniff as a fallback.
- **State saving**: daemon persists `state.json` (layout + runtime→session/cwd + `running` flag) and each runtime's byte log;
  GUI close leaves the daemon running (systemd user unit); daemon restart respawns `running` runtimes with `--resume`.
- **Idle pooling**: keep sessions with attached panes + recently active ones resident; LRU-deactivate beyond a budget
  (ZCode `session-resident-pool.ts`: leases, TTL, high-water); deactivation keeps the log, next attach resumes.
- **Images**: paste in webview → write image to system clipboard (`navigator.clipboard.write`) → send `0x16` (omp's paste
  chord) → omp attaches it and draws via iTerm2/SIXEL → addon-image renders it in-pane. App-side blob previews
  (`~/.omp/agent/blobs/<sha256>`, from the extension's message snapshot) give click-to-zoom as a bonus.
- **Notifications**: extension events → daemon → desktop notification + web-push to the existing PWA (reuse `notifications.ts`).

## 6. PTY/daemon engineering rules (from the research)

- Byte-transparent bidirectional passthrough: never swallow DA1/APC/DCS replies, OSC 52/1337, kitty ACKs; forward client
  replies back to the PTY.
- Resize = `TIOCSWINSZ` on the shared master (all attached xterms mirror the max/min agreed size; v1: last writer wins per pane).
- Backpressure: ack-based flow control into xterm.js (`write` callbacks); addon-image output is bursty.
- Bound and rotate the raw log; replay window (e.g. 2 MiB) on attach.
- Spawn omp with a clean env except the explicit overrides; no `ZELLIJ_*` leakage.

## 7. Sidebar

Live runtimes (status dots: working / needs-approval / done-unseen from extension events) + recent sessions from omp's own
store; pin/rename/archive where omp supports it; search over `history.db` titles and first messages; drag source for panes.
Ports of OmpCode's `taskIndexRepo.ts` behavior, reimplemented on omp's real data instead of a derived SQLite index.

## 8. Mobile client

Existing PWA keeps its screens but swaps gateway for the daemon: `/api/slots` → `/api/runtimes`, terminal snapshot →
WS terminal topic (real bytes), actions unchanged (`shared.ts` types survive). Desktop is the source of truth; mobile is a
read/write client (prompt, abort, model, view panes), matching the "shared live" goal.

## 9. Phases and acceptance

| Phase | Deliverable | Acceptance (must observe) |
|---|---|---|
| **P0 spike** | daemon spawns one `omp` TUI in PTY (bun-pty), WS byte stream, xterm.js attach | Type a prompt, see streaming response; resize works; paste a screenshot → it renders in the pane; kill/restart daemon → `--resume` restores the session |
| **P1 grid+sidebar** | split tree ≤4, drag session→pane, recent picker, live session list | Swap two live sessions between panes without restarting either; layout survives client reload |
| **P2 persistence** | state.json, byte logs, systemd user unit, LRU pool, notifications | Close window → agent keeps working; restart daemon → panes and sessions restored; mobile PWA drives the same runtimes |
| **P3 shell** | Tauri 2 window/tray/autostart (or Electron if WebKitGTK fails the perf test) | App-like launch, no browser chrome; perf test: 4 panes, 60 fps scroll, input latency < 30 ms measured |
| **P4 polish** | app-side image previews, fork action, layout undo (dockkit-style ops), retire zellij wrappers | zellij unused for a week |

## 10. Risks

- **addon-image kitty gap**: unicode placeholders unsupported → we force iTerm2/SIXEL. If omp's rendering with iTerm2 is
  degraded, fall back to app-side image rendering from blobs (needs extension data, not PTY sniffing).
- **Bun PTY maturity**: bun-pty is a third-party FFI wrapper; P0 must stress it (resize storms, SIGWINCH, flow control).
  Rust `portable-pty` helper is the planned fallback.
- **WebKitGTK (Tauri on Wayland)**: IME/GPU/key handling caveats; P3 perf test decides Tauri vs Electron. P0–P2 stay shell-free.
- **omp lease/fork semantics**: second writer forks a sibling — surfaced as an explicit fork, never silent.
- **Input semantics**: xterm.js must enable mouse reporting and bracketed paste exactly like zellij does today; verify omp's
  `tui.mouse` interactions in P0.

## 11. Ideas borrowed (and from where)

- Split tree, never-remount leaves, CSS-var ratios, drag-session-to-pane, ≤4 panes: ZCode/OmpCode `packages/ui/src/v4/*`.
- Session residency pool (lease/TTL/LRU): ZCode `session-resident-pool.ts`.
- Topic transport with seq/delta/snapshot resync; mobile relay fragmentation: OmpCode `sessionIndexTopics.ts`,
  `hostV4RpcBridge.ts`, `mobileRelayServer.ts`.
- Attach/detach terminal controller, follow stream, one input owner: DeepSeek Harness `terminal-controller`.
- Invertible layout ops + content identity `(kind, contentId)`: DeepSeek Harness `ui-dockkit`.
- Session list/pin/archive/search UX: dsh `ui-sidebar`; ZCode `taskIndexRepo.ts`.
- Loopback token→cookie trust fence: dsh `connection`.
- Raw-byte-log replay + portable-pty daemon: WezTerm mux; VS Code ptyHost for revive/replay semantics; raw log rotation and
  attach semantics from tmux control mode (`-CC`).
- omp-specific: `--mode rpc-ui` embedders (OmpCode), OSC 1337 `omp_session_file` (omp CHANGELOG 18.4.4, Tern),
  `PI_FORCE_IMAGE_PROTOCOL`/`PI_ALLOW_SIXEL_PASSTHROUGH` (env docs), blob store (blob-artifact docs).

## 12. User requirements v2 (`desktop-reqs`, 2026-10-02) — disposition

| # | Requirement | Mechanism |
|---|---|---|
| 1 | Preserve omp CLI/TUI; GUI only around it; version agnostic | Daemon spawns the `omp` binary in a PTY. Only stable surfaces used: terminal bytes, `--resume <path>`, env vars, and an optional extension that degrades silently if it fails to load. No SDK/RPC coupling. |
| 2 | 2- and 4-way splits, side by side and stacked | Split tree with `h`/`v` nodes and ratios, ≤4 leaves (ZCode model). |
| 3 | Remote access + sync via mobile webapp | Daemon serves WS/HTTP; existing PWA becomes a client; desktop is the source of truth. |
| 4 | Sessions persist across app close / computer restart | Daemon owns PTYs; `state.json` + raw logs; systemd user unit; respawn on boot with `--resume`. |
| 5 | 1-click new session, synced to mobile + sidebar | Spawn runtime; session index broadcast to all clients over the topic bus. |
| 6 | Auto-unload idle sessions (no background tasks), cached for resume | Activity from extension events + `omp ps` background-job check → LRU unload; byte log retained; attach resumes. |
| 7 | Session scrolling with scrollbar | xterm.js scrollback, backed by the daemon's replay log so it survives detach/unload. |
| 8 | No free-dragging tabs; replace a pane via tab drag or top session selector | Panes hold a `content` identity; drag/selector rebinds the leaf (attach live runtime or resume). No tab reordering. |
| 9 | Model roles / updates propagate without manual session restarts | Daemon watches config + omp binary mtime; auto-restarts **idle** sessions; busy sessions get a "restart pending" badge. |
| 10 | Pasted image/screenshot viewing | Paste → system clipboard + `0x16` (omp paste chord) → omp draws via iTerm2/SIXEL → xterm.js addon-image; blob previews app-side as bonus. |

## 13. Limitations of this architecture (accepted or to verify)

**Terminal renderer (xterm.js)**
- **Glyph set (resolved 2026-10-02).** omp's default `symbolPreset: unicode` emits marks no monospace font covers consistently: the reasoning/effort indicator (U+29B8) resolves to proportional Noto Sans Math, and folder/image marks are color emoji at ~1.17em advance — both clipped inside a monospace cell. Fix: `config/session.yml` sets `symbolPreset: nerd` through `omp --config` (process-only overlay; the user's global `~/.omp/agent/config.yml` stays untouched, so their Konsole keeps its own preset), and the app vendors `JetBrainsMonoNerdFontMono-Regular.ttf` as the icon fallback after Hack, restricted by `unicode-range` to the private-use planes so text keeps Hack's letterforms. Every PUA codepoint omp emitted in a probe (U+E0B0/E0B1/E0B6, U+F115, U+F0068, U+F055D, U+F067A, U+F0A9F, U+F0D57) is covered by the vendored file; the smoke test asserts PUA glyphs actually appear in the PTY stream. **The patch family matters, not just the family name:** Nerd Fonts' *Symbols-only* builds draw icons at ~1em ink with a 1em advance, so inside Hack's 0.6em cell every icon overflowed its cell (clipped at the row edge, visibly detached from its neighbours, measured 13.33px advance/14px ink at a 8.02px cell). The **Mono** patch of a real base font (`JetBrainsMono Nerd Font Mono`, advance 0.6em = 8.02px, ink ~8px) drops into the cell exactly; verified in-browser by canvas advance/ink measurement and 3x screenshots.
- **Stale bundle must be impossible (resolved 2026-10-02).** A tab kept an old `client.js` while the daemon restarted with new code (no cache headers + no reload path), so fixes looked like "nothing changed". The daemon now serves `/`, `/client.js`, `/styles.css`, `/xterm.css` with `cache-control: no-store`, publishes its bundle hash at `/api/build`, and the client polls it (10s + on focus) and reloads itself when it differs; the hash is shown in the pane header so the running build is always identifiable.
- **Cell geometry.** Matches the Konsole profile the sessions normally run in. Konsole's font is `QFontDatabase::systemFont(FixedFont)` (`Profile.cpp:293`) and the profile sets no `Font=`, so the platform default applies; the running Konsole processes have `Hack-Regular.ttf` mapped (that map also shows `NotoSansMath-Regular.ttf` and `NotoColorEmoji.ttf` — the fallbacks behind the clipping above). Hack at 10pt = 13.33px, plus Konsole `LineSpacing=3`, which `TerminalFont` adds as pixels to the font height → approximated as xterm.js `lineHeight: 1.4` (measured cell 8.02 × 20.8px at dpr 1.25, i.e. ~20px, within a few percent of Qt's `Hack@10pt + 3`). `Ctrl/Cmd +/-/0` adjusts live (persisted) since Qt's effective font cannot be introspected from outside.
- **Fit must be font-gated.** An initial `fit()` before the webfont loads measures fallback metrics and leaves the bottom rows (status line, prompt) outside the viewport. `document.fonts.load` for every family in the stack gates the first fit; `loadingdone` re-fits.
- Stable `addon-image` renders SIXEL + iTerm2 only; **kitty graphics is beta-only and lacks unicode placeholders**, so omp's default kitty image path is unavailable → force `PI_FORCE_IMAGE_PROTOCOL=iterm2|sixel`. If that degrades omp's rendering, fall back to app-side image rendering from the blob store (needs extension data). P0 gate.
- Kitty keyboard protocol has open bugs in xterm.js → some modifier chords may not reach omp identically to a native terminal.
- Images are not serialized by the renderer; on re-attach they exist only if still inside the replayed log window (log rotation eventually drops them).
- Web renderer is slower than a native terminal; 4 busy panes can stutter. WebKitGTK (Tauri) adds IME/GPU caveats on Wayland; Electron is the fallback (heavier).

**PTY / process layer**
- Bun's built-in PTY lacks `setsid`/`TIOCSCTTY` ([bun#33237](https://github.com/oven-sh/bun/issues/33237)) → `bun-pty` (third-party FFI wrapper). If it proves unstable, swap in a small Rust `portable-pty` helper. P0 gate.
- Each live session costs a full omp process (~hundreds of MB RSS); RAM is only reclaimed by unloading, and unloading only works for idle sessions.
- A session mid-turn or with background jobs cannot be unloaded or auto-restarted (req 6 and 9 are best-effort by design).

**omp semantics**
- One writer per session file: omp's lease makes a second process **fork to a sibling file**. "Same session in two panes" is therefore impossible without forking; we attach the live runtime instead. Running the same session in an external terminal also causes a fork branch.
- Session switching done by typing `/resume` inside the TUI is tracked via the extension (or OSC 1337); if the extension fails to load after an omp update, the sidebar degrades to file-based discovery. Core PTY streaming still works.
- The optional extension is the only version-coupled piece; it must fail soft on every omp release.

**Scope of the GUI**
- Panes render the TUI, not structured chat: no app-side rich cards, clickable diffs, or tool UI inside panes. Anything omp shows as text stays text. (A structured surface could be added later via `--mode rpc-ui`, as a second pane kind.)
- Tern's native TSP rendering is not used; we run omp's ANSI/rows renderer.
- ≤4 panes by design; useful pane count is bounded by screen space anyway.

**Remote / mobile**
- Remote access needs an authenticated exposed port (Tailscale etc.); terminal streams are latency-sensitive over WAN.
- Mobile cannot mirror a 4-pane layout meaningfully; the phone client stays session-centric.

**State**
- Scrollback beyond the retained log window is lost on unload; omp redraws conversation on `--resume`, but raw terminal-only output is not replayed.
- Layout/runtime state can lose the last few seconds of changes on power loss (flush interval).

## 14. Open questions

1. Shell: Tauri 2 vs Electron — decide at P3 by measurement, not taste.
2. Do panes ever host non-omp content (shell, file preview) in v1? (ZCode's dock has them; out of scope for P0.)
3. Scrollback budget and whether the daemon writes logs on every runtime or only when detached.
4. Whether to keep `--mode rpc` child processes for sidebar metadata or rely solely on the extension + file scan.

## 15. Measured baseline (this machine, 2026-10-02)

- **Startup is cheap.** Fresh `omp` TUI first frame: **0.23 s** (pty, new session). `omp --mode rpc` ready frame: **0.22 s**.
- **Memory is the constrained resource.** Fresh TUI: **368 MB RSS / 246 MB PSS / 236 MB private**, of which ~131 MB is
  shared code pages the OS dedupes across all omp processes. RPC-only: 335 MB RSS / 218 MB PSS / 208 MB private.
- **Current hot-set cost**: the 5 live zellij sessions on this machine hold **~404–605 MB RSS each (~2.4 GB total)**.
- **No TUI process reuse exists**: interactive omp is one session per process; `--rpc-project` is absent in omp 18.4.9
  (OmpCode's fork has it, headless `rpc-ui` only).
- **Caching strategy**: hot/cold session pool — evict idle sessions (frees private memory), reattach costs ~0.2 s + resume
  redraw. In-omp reuse already available: OS-shared code pages, `lspmux` broker-shared LSP servers, project-shared managed
  Chromium, `lsp.lazy` default. Not dedupable from outside: MCP servers, eval kernels.

## 16. P0 simplicity rules (2026-10-02)

Build only the straight line; no fallbacks until a gate fails:
1. `bun-pty` only — Rust `portable-pty` helper is a contingency, not work.
2. xterm.js + `PI_FORCE_IMAGE_PROTOCOL=iterm2` only — no app-side image renderer, no kitty work.
3. One omp process per session, lazy spawn, no pool until P2 (idle unload = kill + `--resume`).
4. Browser client first — no Tauri/Electron decision, no packaging.
5. Extension optional at runtime; if it fails to load, the pane still works (terminal bytes only).
