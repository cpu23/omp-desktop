# OMP Desktop 0.1.0 — Initial source release

Initial browser workspace for live and saved OMP sessions, searchable session list, up to four terminal panes, and
an optional native Linux window sharing the local daemon.

Source release only; no prebuilt binaries or installers. See the [current guide](guide.md) for requirements,
setup, and security boundaries.

## Rendering corrections

- Inline iTerm2 images without an optional `size` field now render instead of leaving their reserved rows black.
- Reconnecting panes restore terminal-state snapshots rather than a 512 KiB raw tail that could begin inside a
  repaint or image sequence. Snapshots retain bounded scrollback and inline images across producer resizes.
- Snapshot/live-output handoff shares a parser boundary so output is neither skipped nor duplicated.

Apply these daemon and client changes only after active work finishes: restarting the daemon ends its PTY
children. Existing transcript sessions resume on the next start; an already-discarded raw tail cannot be recovered
from the old daemon's buffer.
