/**
 * Keep a normal-buffer viewport out of the mutable active-screen band.
 *
 * xterm stores history and the active screen in one normal buffer: the last
 * `rows` lines are mutable, everything above `baseY` is history. A viewport
 * scrolled up by `k < rows` rows therefore shows `k` stable history rows above
 * `rows - k` rows of the active screen. OMP's append-only renderer repaints its
 * live window in place (cursor-addressed rows, no ED2/ED3 while streaming), so
 * while output continues the bottom of such a viewport rewrites every frame
 * while the top stays frozen. A frame that clears or omits a table row leaves a
 * blank gap below the seam. Synchronized output prevents mid-frame tearing, not
 * this history/live splice.
 *
 * The guard never leaves a mixed viewport on screen. When movement lands the
 * viewport inside the band, it resolves to one of the two coherent states:
 *
 * - upward movement with at least one screen of history (`baseY >= rows`)
 *   jumps to `baseY - rows`, a viewport made only of committed rows. xterm
 *   keeps `viewportY` fixed while the user is scrolled, so those bytes then
 *   stay stable as the stream scrolls underneath;
 * - downward movement jumps to `baseY`, the live tail, because a partly
 *   history / partly live frame is exactly the corruption being avoided. This
 *   also means the first wheel tick down from history goes all the way back to
 *   live rather than marooning the reader in the band;
 * - an ambiguous position (no measurable movement, e.g. reflow) resolves to
 *   history when one exists, the stable choice.
 *
 * With fewer than `rows` history lines there is no all-history viewport at all,
 * so any attempt to leave the tail snaps back to the live tail: history
 * browsing is unavailable until a full screen has scrolled by. Known
 * limitation; the alternative is the mixed, repainting viewport.
 *
 * Browser semantics: `CoreBrowserTerminal.scrollLines` routes through the DOM
 * viewport. Correcting synchronously from inside `onScroll` re-enters the
 * viewport's `_handleScroll` while its guard flag is set, so the programmatic
 * position change is ignored and the buffer never leaves the seam. Corrections
 * are therefore coalesced into a microtask (before the next render frame) and
 * tracked as an explicit pending target. Events that report a position between
 * the correction's start and target are its own progress; an event outside
 * that span is a reader gesture/reflow that supersedes it.
 */

/** The xterm surface this guard needs, structurally typed so the regression
 *  test can drive the real `@xterm/headless` implementation. */
export interface ScrollbackTerminal {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly baseY: number;
      readonly viewportY: number;
    };
  };
  scrollToLine(line: number): void;
  onScroll(listener: (event: number) => void): { dispose(): void };
  onWriteParsed(listener: () => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
}

/**
 * Install viewport protection on a terminal. Returns a disposer that removes
 * the subscriptions; the terminal itself is not disposed.
 */
export function protectScrollback(term: ScrollbackTerminal): () => void {
  /** Last settled viewport position; direction is measured against it. */
  let lastViewportY = term.buffer.active.viewportY;
  /** An issued, not-yet-observed correction. */
  let pending: { target: number; baseline: number } | null = null;
  let scheduled = false;
  let disposed = false;

  const reconcile = (): void => {
    const buffer = term.buffer.active;
    const { viewportY, baseY } = buffer;
    if (buffer.type !== "normal") {
      pending = null;
      lastViewportY = viewportY;
      return;
    }

    if (pending !== null) {
      const low = Math.min(pending.baseline, pending.target);
      const high = Math.max(pending.baseline, pending.target);
      if (viewportY === pending.target) {
        pending = null;
        lastViewportY = viewportY;
      } else if (viewportY > low && viewportY < high) {
        // Our own correction is still moving through the viewport.
        return;
      } else {
        // A reader gesture or reflow superseded it; classify the movement
        // from where the correction started, not from its unreached target.
        lastViewportY = pending.baseline;
        pending = null;
      }
    }

    if (viewportY >= baseY) {
      lastViewportY = viewportY;
      return;
    }
    if (viewportY + term.rows <= baseY) {
      lastViewportY = viewportY;
      return;
    }

    const direction = Math.sign(viewportY - lastViewportY);
    lastViewportY = viewportY;
    // Without a full screen of history there is no all-history viewport.
    const target = baseY < term.rows || direction > 0 ? baseY : baseY - term.rows;
    if (target === viewportY) return;

    pending = { target, baseline: viewportY };
    term.scrollToLine(target);
    if (term.buffer.active.viewportY === target) {
      pending = null;
      lastViewportY = target;
    }
  };

  // Defer past the emitting handler: the browser viewport ignores programmatic
  // scrolling while it is already inside `_handleScroll`. A microtask runs
  // after that stack unwinds and before the next paint.
  const schedule = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) reconcile();
    });
  };

  const subscriptions = [
    term.onScroll(schedule),
    term.onWriteParsed(schedule),
    // Reflow moves viewportY without a reader gesture; drop the stale
    // comparison so a resize cannot be read as a downward crossing.
    term.onResize(() => {
      pending = null;
      lastViewportY = term.buffer.active.viewportY;
    }),
  ];
  return () => {
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
}
