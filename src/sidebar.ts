/**
 * Sidebar collapse + resize, self-initialising on import.
 *
 * The controls are static in index.html: #sidebar-collapse (in the search row),
 * #sidebar-resizer (role="separator" between the sidebar and the panes) and
 * #sidebar-expand (the strip shown only while collapsed). State is one record
 * under omp-desktop.sidebar.v1 — width, collapse, view and expanded folders —
 * so preferences survive a reload. Width is applied as the --sidebar-w
 * variable that #sidebar's flex-basis reads, so the panes refit through normal
 * flex layout.
 *
 * The width is clamped to MIN_WIDTH..MAX_WIDTH and against the viewport, so a
 * stored width cannot swallow a narrow window. Only user-driven changes
 * overwrite the stored intent; a shrinking window just clamps the display.
 */
import { syncRuntimeLimit } from "./runtime-limit";

export const STORE_KEY = "omp-desktop.sidebar.v1";
/** Default width and the fallback in #sidebar's flex-basis; keep the two in sync. */
const DEFAULT_WIDTH = 278;
const MIN_WIDTH = 190;
const MAX_WIDTH = 560;
/** #app room kept for the panes when clamping against the viewport. */
const PANE_RESERVE = 320;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

type SidebarState = { width: number; collapsed: boolean; view: "sessions" | "folders"; expandedFolders: string[] };

let view: SidebarState["view"] = "sessions";
let expandedFolders = new Set<string>();
let savePreferences: (() => void) | null = null;

export function sidebarFolderView(): boolean {
  return view === "folders";
}

export function sidebarFolderExpanded(cwd: string): boolean {
  return expandedFolders.has(cwd);
}

export function toggleSidebarFolder(cwd: string): void {
  if (expandedFolders.has(cwd)) expandedFolders.delete(cwd);
  else expandedFolders.add(cwd);
  savePreferences?.();
}

/** Set by init(); null only in the instant before the controls are wired. */
let applyExternalState: ((state: SidebarState) => void) | null = null;

/** Set by the client so a user-driven width/collapse change reaches the durable mirror. */
let notifyStateChange: (() => void) | null = null;

/**
 * Registers the client's hook for user-driven sidebar changes (collapse, resize,
 * keyboard/double-click width). Adoption via applySidebarState notifies too, so
 * one save path covers both.
 */
export function onSidebarStateChange(listener: () => void): void {
  notifyStateChange = listener;
}

/**
 * Adopt a persisted sidebar state, e.g. one the client restored from the
 * daemon's durable workspace after browser storage was lost. Applies live once
 * the controls are wired and persists it to the local cache.
 */
export function applySidebarState(value: unknown): void {
  const state = parseSidebarState(value);
  if (applyExternalState) {
    applyExternalState(state);
    return;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Storage denied: the sidebar still works for this page life.
  }
}

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - PANE_RESERVE));
}

function clampWidth(px: number): number {
  const value = Number.isFinite(px) ? px : DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(value, MIN_WIDTH), maxWidth()));
}

/** Validates an untrusted record (storage blob or durable state) into a usable state. */
function parseSidebarState(value: unknown): SidebarState {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return {
      width: typeof record.width === "number" && Number.isFinite(record.width)
        ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, record.width))
        : DEFAULT_WIDTH,
      collapsed: record.collapsed === true,
      view: record.view === "folders" ? "folders" : "sessions",
      expandedFolders: Array.isArray(record.expandedFolders)
        ? record.expandedFolders.filter((cwd): cwd is string => typeof cwd === "string")
        : [],
    };
  }
  return { width: DEFAULT_WIDTH, collapsed: false, view: "sessions", expandedFolders: [] };
}

function readState(): SidebarState {
  try {
    return parseSidebarState(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"));
  } catch {
    // Corrupt JSON or storage denied (private mode): defaults are fine.
    return parseSidebarState(null);
  }
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
  view = stored.view;
  expandedFolders = new Set(stored.expandedFolders);

  const settings = document.getElementById("sidebar-settings")!;
  const settingsOpen = document.getElementById("sidebar-settings-open")!;
  const settingsBack = document.getElementById("sidebar-settings-back")!;
  const search = document.getElementById("search")!;
  const newSession = document.getElementById("sidebar-new-session")!;
  const list = document.getElementById("session-list")!;
  const viewButtons = document.querySelectorAll<HTMLButtonElement>("[data-sidebar-view]");

  function renderView(): void {
    for (const button of viewButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.sidebarView === view));
    }
  }

  function showSettings(show: boolean): void {
    settings.hidden = !show;
    search.hidden = show;
    settingsOpen.hidden = show;
    collapse?.toggleAttribute("hidden", show);
    newSession.hidden = show;
    list.hidden = show;
    settingsOpen.setAttribute("aria-expanded", String(show));
    (show ? settingsBack : settingsOpen).focus();
    // Opening the static settings pane hides the list, which lets CSS suspend
    // its indicators without a script-side animation loop.
    // The panel shows daemon-owned values (the session limit), so opening it
    // re-reads them instead of trusting what was true when the page loaded.
    if (show) void syncRuntimeLimit();
  }

  settingsOpen.addEventListener("click", () => showSettings(true));
  settingsBack.addEventListener("click", () => showSettings(false));
  settings.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      showSettings(false);
    }
  });
  for (const button of viewButtons) {
    button.addEventListener("click", () => {
      view = button.dataset.sidebarView === "folders" ? "folders" : "sessions";
      renderView();
      saveState();
    });
  }

  function saveState(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ width, collapsed, view, expandedFolders: [...expandedFolders] } satisfies SidebarState));
    } catch {
      // Storage denied: the sidebar still works for this page life.
    }
    // A settled width/collapse change is workspace state: let the client mirror it.
    notifyStateChange?.();
  }
  savePreferences = saveState;

  const render = (): void => {
    // Clamp for display only; the stored width is the user's intent and survives
    // a temporarily narrow window.
    const shown = clampWidth(width);
    if (sidebar.style.getPropertyValue("--sidebar-w") !== `${shown}px`) {
      sidebar.style.setProperty("--sidebar-w", `${shown}px`);
    }
    if (resizer.getAttribute("aria-valuenow") !== String(shown)) resizer.setAttribute("aria-valuenow", String(shown));
    const minimum = String(MIN_WIDTH);
    if (resizer.getAttribute("aria-valuemin") !== minimum) resizer.setAttribute("aria-valuemin", minimum);
    const maximum = String(maxWidth());
    if (resizer.getAttribute("aria-valuemax") !== maximum) resizer.setAttribute("aria-valuemax", maximum);
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

  applyExternalState = (state) => {
    width = clampWidth(state.width);
    collapsed = state.collapsed === true;
    view = state.view;
    expandedFolders = new Set(state.expandedFolders);
    renderView();
    saveState();
    render();
    applyCollapsed();
  };

  render();
  renderView();
  applyCollapsed();
}

init();
