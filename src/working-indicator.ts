/**
 * Sidebar working indicators, ported from omp-mobile/client.ts.
 *
 * - Spinner: `SPINNER_FRAMES.unicode.status`, phase-locked to the epoch like
 *   `sharedSpinnerFrame` in tool-execution.ts (80 ms per glyph).
 * - Shimmer: `modes/theme/shimmer.ts` classic profile — fixed 30 cells/s band
 *   travel, cosine bump of half-width 6 with 10 cells of edge padding, three
 *   intensity tiers at 0.65 / 0.22 (low → high).
 *
 * The sidebar rebuilds its rows on every runtime refresh, so the tick looks its
 * nodes up by class instead of holding references, and mutates only textContent
 * and data-tier — never the sidebar tree. The rAF loop exists only while a
 * working row is actually on screen.
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
const SHIMMER_SPEED_CELLS_PER_S = 30;
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF_WIDTH = 6;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

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

function shimmerTier(time: number, index: number, length: number): 0 | 1 | 2 {
  const period = length + SHIMMER_PADDING * 2;
  const pos =
    ((((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period) + period) % period;
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
  for (const char of title) {
    const glyph = document.createElement("span");
    glyph.className = "shimmer-char";
    glyph.dataset.tier = "0";
    glyph.textContent = char;
    shimmer.append(glyph);
  }
  wrap.append(spinner, shimmer);
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

function updateSpinners(time: number): void {
  const frame =
    SPINNER_FRAMES[
      Math.floor(time / SPINNER_ADVANCE_MS) % SPINNER_FRAMES.length
    ];
  document.querySelectorAll<HTMLElement>(".working-spinner").forEach((node) => {
    if (node.textContent !== frame) node.textContent = frame;
  });
}

function updateShimmerNodes(time: number): void {
  document.querySelectorAll<HTMLElement>(".shimmer").forEach((node) => {
    const chars = node.querySelectorAll<HTMLElement>(".shimmer-char");
    if (!chars.length) return;
    const length = chars.length;
    const staticTier = node.dataset.shimmerStatic;
    for (let index = 0; index < length; index += 1) {
      const element = chars[index];
      const tier = staticTier
        ? Number(staticTier)
        : shimmerTier(time, index, length);
      const value = String(tier);
      if (element.dataset.tier !== value) element.dataset.tier = value;
    }
  });
}

/** Freezes every shimmer on one tier (reduced motion) or restores the sweep. */
function setShimmerStatic(tier: string | null): void {
  document.querySelectorAll<HTMLElement>(".shimmer").forEach((node) => {
    if (tier) node.dataset.shimmerStatic = tier;
    else delete node.dataset.shimmerStatic;
  });
}

let animationFrame = 0;
let animationActive = false;

function animationWanted(): boolean {
  // Collapsed sidebars and hidden rows keep their indicators in the DOM; only
  // elements that actually paint should keep the loop alive.
  for (const node of document.querySelectorAll<HTMLElement>(
    ".working-spinner, .shimmer",
  )) {
    if (node.getClientRects().length > 0) return true;
  }
  return false;
}

function animationTick(): void {
  animationFrame = 0;
  const time = performance.now();
  updateSpinners(time);
  updateShimmerNodes(time);
  if (animationWanted()) {
    animationFrame = window.requestAnimationFrame(animationTick);
  } else {
    animationActive = false;
  }
}

/**
 * Runs the animation loop only while a working row is visible (call after each
 * sidebar render). A hidden document or a reduce-motion choice (Off, or System
 * while the platform asks for less motion) cancels the loop and freezes the
 * shimmer on its mid tier instead of leaving the text dim.
 */
export function syncWorkingAnimation(): void {
  if (
    document.visibilityState !== "visible" ||
    reduceMotion() ||
    !animationWanted()
  ) {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    animationActive = false;
    setShimmerStatic(reduceMotion() ? "1" : null);
    updateShimmerNodes(0);
    return;
  }
  setShimmerStatic(null);
  if (animationActive) return;
  animationActive = true;
  animationFrame = window.requestAnimationFrame(animationTick);
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
