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

## Layout

- `src/daemon.ts` — HTTP + websocket server; serves the client bundle, owns the runtime.
- `src/runtime.ts` — one PTY-backed omp process: spawn, byte fan-out, replay tail, process-group kill.
- `src/client.ts` — xterm.js pane: binary output in, JSON input/resize out.
- `src/protocol.ts` — wire types shared by both sides.
- `scripts/smoke.ts` — P0 acceptance test.
