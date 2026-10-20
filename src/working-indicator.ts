/**
 * Sidebar working indicators, ported from omp-mobile/client.ts.
 *
 * - Spinner: `SPINNER_FRAMES.unicode.status`, phase-locked to the epoch like
 *   `sharedSpinnerFrame` in tool-execution.ts (80 ms per glyph).
 * - Shimmer: `modes/theme/shimmer.ts` classic profile — fixed 30 cells/s band
 *   travel, cosine bump of half-width 6 with 10 cells of edge padding, three
 *   intensity tiers at 0.65 / 0.22 (low → high).
 *
 * Like OMP's loader, shimmer updates at 30 Hz and spinner phase advances every
 * 80 ms. Rows cache their glyph references; sidebar lifecycle hooks refresh the
 * visible set before animation writes, never by reading layout inside a tick.
 *
 * Motion: the badge is functional activity — the same braille spin the CLI
 * prints inside the panes — and the native shell shows it by default. There
 * `prefers-reduced-motion` is implemented by WebKitGTK from GTK's
 * `gtk-enable-animations` widget switch, which may not express the user's
 * intent, so the sidebar footer carries an explicit System / On / Off control
 * (`MOTION_KEY`, "omp-desktop.motion.v1" = "system" | "animate" | "reduce").
 * Unset means On in the shell and System in a browser; an explicit System
 * keeps honoring the platform reduced-motion signal.
 */

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const SPINNER_ADVANCE_MS = 80;
const SHIMMER_INTERVAL_MS = 1000 / 30;
const SHIMMER_SPEED_CELLS_PER_S = 30;
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF_WIDTH = 6;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

type WorkingRow = {
  spinner: HTMLElement;
  chars: HTMLElement[];
  tiers: Uint8Array;
  frame: number;
};
const workingRows = new WeakMap<HTMLElement, WorkingRow>();
let visibleRows: WorkingRow[] = [];

/** App-local working-indicator motion choice; see the file header. */
export const MOTION_KEY = "omp-desktop.motion.v1";

type MotionPreference = "system" | "animate" | "reduce";

function storedMotion(): MotionPreference | null {
  try {
    const value = localStorage.getItem(MOTION_KEY);
    return value === "system" || value === "animate" || value === "reduce"
      ? value
      : null;
  } catch {
    // Storage denied (private mode): the default still applies.
    return null;
  }
}

/**
 * Unset means On in the shell (functional animation, CLI parity) and System in
 * a browser. `__TAURI_INTERNALS__` is the shell's own global; the client page
 * is identical in both.
 */
function defaultMotion(): MotionPreference {
  return "__TAURI_INTERNALS__" in window ? "animate" : "system";
}

let motionPreference = storedMotion() ?? defaultMotion();

function reduceMotion(): boolean {
  const preference = motionPreference;
  if (preference !== "system") return preference === "reduce";
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function shimmerTier(index: number, pos: number): 0 | 1 | 2 {
  const dist = Math.abs(index + SHIMMER_PADDING - pos);
  if (dist >= SHIMMER_BAND_HALF_WIDTH) return 0;
  const intensity =
    0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_BAND_HALF_WIDTH));
  return intensity >= TIER_HIGH ? 2 : intensity >= TIER_MID ? 1 : 0;
}

/** Braille spinner + shimmering session title, tinted by the row's --row-accent. */
export function workingIndicator(title: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "row-working";
  const spinner = document.createElement("span");
  spinner.className = "working-spinner";
  spinner.setAttribute("aria-hidden", "true");
  spinner.textContent = SPINNER_FRAMES[0];
  wrap.setAttribute("aria-label", `${title} — Working`);
  // Wrap once; animation updates only intensity tiers, not the sidebar tree.
  const shimmer = document.createElement("span");
  shimmer.className = "title shimmer shimmer-accent";
  shimmer.setAttribute("aria-hidden", "true");
  const chars: HTMLElement[] = [];
  for (const char of title) {
    const glyph = document.createElement("span");
    glyph.className = "shimmer-char";
    glyph.dataset.tier = "0";
    glyph.textContent = char;
    shimmer.append(glyph);
    chars.push(glyph);
  }
  wrap.append(spinner, shimmer);
  workingRows.set(wrap, { spinner, chars, tiers: new Uint8Array(chars.length), frame: 0 });
  return wrap;
}

/** Compact completion marker; keep the finished state accessible without a badge. */
export function doneIndicator(): HTMLElement {
  const done = document.createElement("span");
  done.className = "row-done";
  done.setAttribute("role", "img");
  done.setAttribute("aria-label", "Session finished");
  done.title = "Session finished";
  return done;
}

/** All geometry reads happen in syncWorkingAnimation, before these writes. */
function paintWorkingRows(time: number, reduced: boolean): void {
  const frame = Math.floor(time / SPINNER_ADVANCE_MS) % SPINNER_FRAMES.length;
  const travel = (time / 1000) * SHIMMER_SPEED_CELLS_PER_S;
  for (const row of visibleRows) {
    if (!reduced && row.frame !== frame) {
      row.spinner.textContent = SPINNER_FRAMES[frame];
      row.frame = frame;
    }
    const pos = travel % (row.chars.length + SHIMMER_PADDING * 2);
    for (let index = 0; index < row.chars.length; index++) {
      const tier = reduced ? 1 : shimmerTier(index, pos);
      if (row.tiers[index] === tier) continue;
      row.chars[index].dataset.tier = String(tier);
      row.tiers[index] = tier;
    }
  }
}

let animationTimer = 0;

function animationTick(): void {
  animationTimer = 0;
  paintWorkingRows(performance.now(), false);
  animationTimer = window.setTimeout(animationTick, SHIMMER_INTERVAL_MS);
}

/**
 * Called after rows or sidebar visibility change. Rebuild references once per
 * lifecycle change; no DOM queries, geometry reads or detached rows in ticks.
 * Hidden documents stop entirely; reduced motion freezes every tier at mid.
 */
export function syncWorkingAnimation(): void {
  if (animationTimer) window.clearTimeout(animationTimer);
  animationTimer = 0;
  visibleRows = [];
  if (document.visibilityState !== "visible") return;
  for (const wrap of document.querySelectorAll<HTMLElement>(".row-working")) {
    const row = workingRows.get(wrap);
    if (row && wrap.getClientRects().length > 0) visibleRows.push(row);
  }
  if (!visibleRows.length) return;
  const reduced = reduceMotion();
  paintWorkingRows(performance.now(), reduced);
  if (!reduced) {
    animationTimer = window.setTimeout(animationTick, SHIMMER_INTERVAL_MS);
  }
}

document.addEventListener("visibilitychange", syncWorkingAnimation);
window
  .matchMedia?.("(prefers-reduced-motion: reduce)")
  .addEventListener("change", syncWorkingAnimation);

/* The sidebar settings control is static markup, so one query at page load is
   enough (client.js is a deferred module script). */
const motionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".motion-control [data-motion]"),
);

function reflectMotionControl(): void {
  const active = motionPreference;
  for (const button of motionButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.motion === active),
    );
  }
}

for (const button of motionButtons) {
  button.addEventListener("click", () => {
    const value = button.dataset.motion;
    if (value !== "system" && value !== "animate" && value !== "reduce") return;
    motionPreference = value;
    try {
      localStorage.setItem(MOTION_KEY, value);
    } catch {
      // Storage denied: the choice still applies to this page life.
    }
    reflectMotionControl();
    syncWorkingAnimation();
  });
}
reflectMotionControl();

// The daemon origin is shared by the shell and any browser tab: keep them in
// step when the choice changes elsewhere.
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== MOTION_KEY) return;
  motionPreference = storedMotion() ?? defaultMotion();
  reflectMotionControl();
  syncWorkingAnimation();
});
