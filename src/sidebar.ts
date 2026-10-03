/**
 * Sidebar collapse + resize, self-initialising on import.
 *
 * The controls are static in index.html: #sidebar-collapse (in the search row),
 * #sidebar-resizer (role="separator" between the sidebar and the panes) and
 * #sidebar-expand (the strip shown only while collapsed). State is one record
 * under omp-desktop.sidebar.v1 — the user's width intent in CSS px plus the
 * collapsed flag — so both survive a reload. Width is applied as the --sidebar-w
 * variable that #sidebar's flex-basis reads, so the panes refit through normal
 * flex layout.
 *
 * The width is clamped to MIN_WIDTH..MAX_WIDTH and against the viewport, so a
 * stored width cannot swallow a narrow window. Only user-driven changes
 * overwrite the stored intent; a shrinking window just clamps the display.
 */
const STORE_KEY = "omp-desktop.sidebar.v1";
/** Default width and the fallback in #sidebar's flex-basis; keep the two in sync. */
const DEFAULT_WIDTH = 278;
const MIN_WIDTH = 190;
const MAX_WIDTH = 560;
/** #app room kept for the panes when clamping against the viewport. */
const PANE_RESERVE = 320;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

type SidebarState = { width: number; collapsed: boolean };

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - PANE_RESERVE));
}

function clampWidth(px: number): number {
  const value = Number.isFinite(px) ? px : DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(value, MIN_WIDTH), maxWidth()));
}

function readState(): SidebarState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null) {
      const record = raw as Record<string, unknown>;
      return {
        width: typeof record.width === "number" && Number.isFinite(record.width)
          ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, record.width))
          : DEFAULT_WIDTH,
        collapsed: record.collapsed === true,
      };
    }
  } catch {
    // Corrupt JSON or storage denied (private mode): defaults are fine.
  }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

function init(): void {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  const collapse = document.getElementById("sidebar-collapse");
  const expand = document.getElementById("sidebar-expand");
  if (!sidebar || !resizer || !collapse || !expand) {
    console.warn("sidebar: collapse/resize controls missing from index.html");
    return;
  }
  const status = document.getElementById("status");

  const stored = readState();
  let width = stored.width;
  let collapsed = stored.collapsed;

  function saveState(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ width, collapsed } satisfies SidebarState));
    } catch {
      // Storage denied: the sidebar still works for this page life.
    }
  }

  const render = (): void => {
    // Clamp for display only; the stored width is the user's intent and survives
    // a temporarily narrow window.
    const shown = clampWidth(width);
    sidebar.style.setProperty("--sidebar-w", `${shown}px`);
    resizer.setAttribute("aria-valuenow", String(shown));
    resizer.setAttribute("aria-valuemin", String(MIN_WIDTH));
    resizer.setAttribute("aria-valuemax", String(maxWidth()));
  };

  function setWidth(px: number, persist: boolean): void {
    width = clampWidth(px);
    render();
    if (persist) saveState();
  }

  const applyCollapsed = (): void => {
    sidebar.hidden = collapsed;
    resizer.hidden = collapsed;
    expand.hidden = !collapsed;
    const expanded = String(!collapsed);
    collapse.setAttribute("aria-expanded", expanded);
    expand.setAttribute("aria-expanded", expanded);
  };

  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    applyCollapsed();
    // Hand focus to the control that is still on screen.
    (collapsed ? expand : collapse).focus();
    saveState();
  };

  collapse.addEventListener("click", () => setCollapsed(true));
  expand.addEventListener("click", () => setCollapsed(false));

  // Drag: pointer capture keeps the move/up events on the resizer even when the
  // pointer leaves it, so no window-level listeners are needed.
  let dragStartX = 0;
  let dragStartWidth = 0;

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    dragStartX = event.clientX;
    dragStartWidth = clampWidth(width);
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("sidebar-resizing");
  });

  resizer.addEventListener("pointermove", (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    setWidth(dragStartWidth + (event.clientX - dragStartX), false);
  });

  const endDrag = (event: PointerEvent): void => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove("dragging");
    document.body.classList.remove("sidebar-resizing");
    saveState();
  };
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);

  // Double-click restores the default width; the resizer title says so.
  resizer.addEventListener("dblclick", () => setWidth(DEFAULT_WIDTH, true));

  resizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = clampWidth(width) - step;
        break;
      case "ArrowRight":
        next = clampWidth(width) + step;
        break;
      case "Home":
        next = MIN_WIDTH;
        break;
      case "End":
        next = maxWidth();
        break;
      default:
        return;
    }
    event.preventDefault();
    setWidth(next, true);
  });

  // A window resize can move the clamp ceiling; re-render, do not persist.
  window.addEventListener("resize", render);

  // Collapsed, the status line is off screen, so mirror a failure kind onto the
  // expand strip (colour only; the rule lives in styles.css).
  if (status) {
    const mirrorStatus = (): void => {
      if (status.dataset.kind === "warn") expand.dataset.kind = "warn";
      else delete expand.dataset.kind;
    };
    new MutationObserver(mirrorStatus).observe(status, { attributes: true, attributeFilter: ["data-kind"] });
    mirrorStatus();
  }

  render();
  applyCollapsed();
}

init();
