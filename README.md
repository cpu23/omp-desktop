# omp-desktop

Desktop app for [omp](https://omp.sh) sessions: a daemon owns real `omp` TUI processes on PTYs and renders them in a
browser surface (sidebar, splits, drag-to-pane to come). The agent is never re-implemented — panes are the actual TUI.

Design and decisions: [`docs/desktop-architecture.md`](docs/desktop-architecture.md),
[`docs/desktop-app-options.md`](docs/desktop-app-options.md), [`docs/desktop-reqs.txt`](docs/desktop-reqs.txt).

## Status — P0

One pane: daemon + one PTY + one `omp` TUI, byte-transparent I/O, resize, replay buffer for late attach, iTerm2 image
protocol forced (`PI_FORCE_IMAGE_PROTOCOL=iterm2`) so pasted images render in xterm.js (`addon-image`).

Not yet: sidebar, session store, splits, persistence, mobile sync, app shell (browser tab for now).

## Run

```sh
bun install
bun run start        # http://127.0.0.1:4180
bun run smoke        # end-to-end check (bash round-trip + real omp TUI + reap)
bun run check        # typecheck
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `OMP_DESKTOP_HOST` | `127.0.0.1` | listen address (loopback only by design in P0) |
| `OMP_DESKTOP_PORT` | `4180` | listen port |
| `OMP_DESKTOP_CWD` | `$HOME` | working directory for the spawned session |
| `OMP_DESKTOP_OMP` | `omp` | omp binary (overridable for tests) |
| `OMP_DESKTOP_OMP_ARGS` | empty | extra args for the omp binary |
| `OMP_DESKTOP_OVERLAY` | `config/session.yml` | per-process omp config overlay; empty string disables it |

## Terminal look

The pane is meant to sit next to a real Konsole, so it is tuned against that profile: **Hack** at 10pt (`13.33px`) —
Konsole's font is `QFontDatabase::systemFont(FixedFont)` and both running Konsole processes on this machine have
`Hack-Regular.ttf` mapped (the same map shows `NotoSansMath` and `NotoColorEmoji`, i.e. exactly the proportional
fallbacks that clip inside a monospace cell) — plus Konsole's `LineSpacing=3`, which it applies as pixels on top of
the font height, approximated with xterm.js `lineHeight: 1.4`. Constants live at the top of `src/client.ts`;
`Ctrl/Cmd +`/`-`/`0` adjust the cell size live (persisted in `localStorage`) so it can be dialed in against the real
terminal.

`config/session.yml` is passed as `omp --config <file>`, a process-only overlay: the app must not edit the user's
global `~/.omp/agent/config.yml` when their terminal shares those sessions. It sets `symbolPreset: nerd` because
the `unicode` preset emits glyphs (U+29B8, emoji folders/images) that resolve to proportional or color-emoji faces
and clip in a monospace cell; the app vendors `Symbols Nerd Font Mono` (`public/fonts/`) and serves it from
`/fonts/`, so every PUA icon is one cell wide and `document.fonts`-gated before the first `fit()`.

## Layout

- `src/daemon.ts` — HTTP + websocket server; serves the client bundle, owns the runtime.
- `src/runtime.ts` — one PTY-backed omp process: spawn, byte fan-out, replay tail, process-group kill.
- `src/client.ts` — xterm.js pane: binary output in, JSON input/resize out.
- `src/protocol.ts` — wire types shared by both sides.
- `scripts/smoke.ts` — P0 acceptance test.
