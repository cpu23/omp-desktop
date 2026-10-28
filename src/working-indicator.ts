import { isNativeShell } from "./native-shell";
/**
 * CSS-driven working indicators. Their cadence and shape mirror OMP's braille
 * spinner and 30-cell/s shimmer without per-frame JavaScript, geometry reads or
 * DOM writes.
 *
 * Motion preference remains explicit: unset means On in the native shell and
 * System in a browser. System follows prefers-reduced-motion; Off freezes both
 * effects at their existing settled appearance.
 */


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
 * Unset means On in native shells (functional animation, CLI parity) and
 * System in a browser. `isNativeShell()` identifies the shell's capability;
 * the client page is identical in both.
 */
function defaultMotion(): MotionPreference {
  return isNativeShell() ? "animate" : "system";
}

let motionPreference = storedMotion() ?? defaultMotion();


/** Braille spinner + CSS-shimmering session title, tinted by the row's --row-accent. */
export function workingIndicator(title: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "row-working";
  const spinner = document.createElement("span");
  spinner.className = "working-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const shimmer = document.createElement("span");
  shimmer.className = "title shimmer shimmer-accent";
  shimmer.setAttribute("aria-hidden", "true");
  shimmer.textContent = title;
  // Counter-translation keeps the glyphs stationary beneath a moving gradient mask.
  const sweep = document.createElement("span");
  sweep.className = "working-shimmer-sweep";
  const highlight = document.createElement("span");
  highlight.className = "working-shimmer-text";
  highlight.textContent = title;
  sweep.append(highlight);
  shimmer.append(sweep);
  shimmer.style.setProperty("--shimmer-cycle", `${(title.length + 20) / 30}s`);
  wrap.append(spinner, shimmer);
  wrap.setAttribute("aria-label", `${title} — Working`);
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

/**
 * Applies preference/visibility state only when it changes. CSS owns the
 * animation timeline; no timer, per-frame mutation or layout synchronization.
 */
function syncWorkingAnimation(): void {
  const root = document.documentElement;
  if (root.dataset.motion !== motionPreference) root.dataset.motion = motionPreference;
  const visibility = document.visibilityState === "visible" ? "visible" : "hidden";
  if (root.dataset.documentVisibility !== visibility) root.dataset.documentVisibility = visibility;
}

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
syncWorkingAnimation();

// The daemon origin is shared by the shell and any browser tab: keep them in
// step when the choice changes elsewhere.
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== MOTION_KEY) return;
  motionPreference = storedMotion() ?? defaultMotion();
  reflectMotionControl();
  syncWorkingAnimation();
});
document.addEventListener("visibilitychange", syncWorkingAnimation);
