/**
 * Sidebar resize and view, self-initialising on import.
 *
 * The resizer is static in index.html. State is one record under
 * omp-desktop.sidebar.v1 — width, view, registered workspaces and collapsed
 * workspace groups — so preferences survive a reload. Width is applied as
 * --sidebar-w, which #sidebar's flex-basis reads, so the panes refit normally.
 *
 * The width is clamped to MIN_WIDTH..MAX_WIDTH and against the viewport, so a
 * stored width cannot swallow a narrow window. Only user-driven changes
 * overwrite the stored intent; a shrinking window just clamps the display.
 */
import { syncRuntimeLimit } from "./runtime-limit";
import { selectWorkspaceDirectory } from "./workspace-picker";

export const STORE_KEY = "omp-desktop.sidebar.v1";
/** Default width and the fallback in #sidebar's flex-basis; keep the two in sync. */
const DEFAULT_WIDTH = 278;
const MIN_WIDTH = 190;
const MAX_WIDTH = 560;
/** #app room kept for the panes when clamping against the viewport. */
const PANE_RESERVE = 320;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

type SidebarState = {
  width: number;
  view: "sessions" | "workspaces";
  workspaces: string[];
  activeWorkspace: string | null;
  collapsedWorkspaces: string[];
  archivedWorkspaces: string[];
};

let view: SidebarState["view"] = "workspaces";
let workspaces: string[] = [];
let activeWorkspace: string | null = null;
let collapsedWorkspaces = new Set<string>();
let archivedWorkspaces = new Map<string, string>();
// Retain explicit archive/re-add actions (or daemon restoration) if storage is
// denied or full, until a write succeeds. Unrelated saves carry no archive edits.
const pendingArchives = new Map<string, string | null>();
let savePreferences: (() => void) | null = null;
let refreshViewControls: (() => void) | null = null;

export function sidebarFolderView(): boolean {
  return view === "workspaces";
}

export function sidebarFolderExpanded(cwd: string): boolean {
  const path = normalizeDirectoryPath(cwd);
  return path !== null && !collapsedWorkspaces.has(workspacePathKey(path));
}

export function toggleSidebarFolder(cwd: string): void {
  const path = normalizeDirectoryPath(cwd);
  if (path === null) return;
  const key = workspacePathKey(path);
  if (collapsedWorkspaces.has(key)) collapsedWorkspaces.delete(key);
  else collapsedWorkspaces.add(key);
  savePreferences?.();
}

export function sidebarWorkspaces(): readonly string[] {
  return workspaces;
}

export function sidebarWorkspaceArchived(cwd: string): boolean {
  const path = normalizeDirectoryPath(cwd);
  return path !== null && archivedWorkspaces.has(workspacePathKey(path));
}

export function archiveSidebarWorkspace(cwd: string): void {
  const path = normalizeDirectoryPath(cwd);
  if (path === null) return;
  const key = workspacePathKey(path);
  archivedWorkspaces.set(key, path);
  pendingArchives.set(key, path);
  savePreferences?.();
}

export function addSidebarWorkspace(cwd: string): void {
  const path = normalizeDirectoryPath(cwd);
  if (path === null) return;
  const key = workspacePathKey(path);
  const existing = workspaces.find((workspace) => workspacePathKey(workspace) === key);
  if (existing === undefined) workspaces = [...workspaces, path];
  archivedWorkspaces.delete(key);
  pendingArchives.set(key, null);
  activeWorkspace = existing ?? path;
  collapsedWorkspaces.delete(key);
  view = "workspaces";
  refreshViewControls?.();
  savePreferences?.();
}

export function sidebarActiveWorkspace(): string | null {
  return activeWorkspace;
}

export function selectSidebarWorkspace(cwd: string): void {
  const path = normalizeDirectoryPath(cwd);
  if (path === null) return;
  const existing = workspaces.find((workspace) => workspacePathKey(workspace) === workspacePathKey(path));
  const selected = existing ?? path;
  if (activeWorkspace !== null && workspacePathKey(activeWorkspace) === workspacePathKey(selected)) return;
  activeWorkspace = selected;
  savePreferences?.();
}

export function normalizeDirectoryPath(value: string): string | null {
  if (!value || value.includes("\0")) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const path = windows ? value.replace(/\\/g, "/") : value;
  let root: string;
  let remainder: string;
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(path);
  if (drive) {
    root = `${drive[1].toUpperCase()}:/`;
    remainder = path.slice(drive[0].length);
  } else if (path.startsWith("//")) {
    root = "//";
    remainder = path.slice(2);
  } else if (path.startsWith("/")) {
    root = "/";
    remainder = path.slice(1);
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return root + joined;
}

function workspacePathKey(path: string): string {
  return /^[A-Z]:\//.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

function normalizedDirectoryPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const path = normalizeDirectoryPath(candidate);
    if (path === null) continue;
    const key = workspacePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/** Set by init(); null only in the instant before the controls are wired. */
let applyExternalState: ((state: SidebarState) => void) | null = null;

/** Storage-event adoption refreshes the view without republishing the mirror. */
let notifyStateChange: ((persist: boolean) => void) | null = null;

/**
 * Registers the client's hook for user-driven sidebar changes (resize,
 * keyboard/double-click width). Adoption via applySidebarState notifies too, so
 * one save path covers both. Cross-tab storage events pass persist=false.
 */
export function onSidebarStateChange(listener: (persist: boolean) => void): void {
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
    const legacyFolders = normalizedDirectoryPaths(record.expandedFolders);
    const registeredWorkspaces = normalizedDirectoryPaths(record.workspaces);
    const workspaces = record.workspaces === undefined
      ? legacyFolders
      : normalizedDirectoryPaths([...registeredWorkspaces, ...legacyFolders]);
    const active = typeof record.activeWorkspace === "string"
      ? normalizeDirectoryPath(record.activeWorkspace)
      : null;
    return {
      width: typeof record.width === "number" && Number.isFinite(record.width)
        ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, record.width))
        : DEFAULT_WIDTH,
      view: record.view === "sessions" ? "sessions" : "workspaces",
      workspaces,
      activeWorkspace: active,
      collapsedWorkspaces: normalizedDirectoryPaths(record.collapsedWorkspaces),
      archivedWorkspaces: normalizedDirectoryPaths(record.archivedWorkspaces),
    };
  }
  return {
    width: DEFAULT_WIDTH,
    view: "workspaces",
    workspaces: [],
    activeWorkspace: null,
    collapsedWorkspaces: [],
    archivedWorkspaces: [],
  };
}

function readState(): SidebarState | null {
  try {
    const value = localStorage.getItem(STORE_KEY);
    return value === null ? null : parseSidebarState(JSON.parse(value));
  } catch {
    // An unavailable cache must not erase this page's in-memory preferences.
    return null;
  }
}

function reconcileArchives(): void {
  const stored = readState();
  if (stored !== null) {
    archivedWorkspaces = new Map(stored.archivedWorkspaces.map((path) => [workspacePathKey(path), path]));
  }
  for (const [key, path] of pendingArchives) {
    if (path === null) archivedWorkspaces.delete(key);
    else archivedWorkspaces.set(key, path);
  }
  if (activeWorkspace !== null && archivedWorkspaces.has(workspacePathKey(activeWorkspace))) {
    activeWorkspace = workspaces.find((workspace) =>
      !archivedWorkspaces.has(workspacePathKey(workspace)),
    ) ?? null;
  }
}

function init(): void {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  if (!sidebar || !resizer) {
    console.warn("sidebar: resize controls missing from index.html");
    return;
  }

  const stored = readState() ?? parseSidebarState(null);
  let width = stored.width;

  view = stored.view;
  workspaces = stored.workspaces;
  activeWorkspace = stored.activeWorkspace;
  collapsedWorkspaces = new Set(stored.collapsedWorkspaces.map(workspacePathKey));
  archivedWorkspaces = new Map(stored.archivedWorkspaces.map((path) => [workspacePathKey(path), path]));
  const settings = document.getElementById("sidebar-settings")!;
  const settingsOpen = document.getElementById("sidebar-settings-open")!;
  const settingsBack = document.getElementById("sidebar-settings-back")!;
  const search = document.getElementById("search") as HTMLInputElement;
  const searchRow = document.getElementById("search-row")!;
  const searchOpen = document.getElementById("search-open")!;
  const searchClose = document.getElementById("search-close")!;
  function closeSearch(): void {
    searchRow.hidden = true;
    searchOpen.setAttribute("aria-expanded", "false");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    searchOpen.focus();
  }
  searchOpen.addEventListener("click", () => {
    searchRow.hidden = false;
    searchOpen.setAttribute("aria-expanded", "true");
    search.focus();
  });
  searchClose.addEventListener("click", closeSearch);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
  });
  const newSession = document.getElementById("new-session")!;
  const sidebarTitle = document.getElementById("sidebar-title")!;
  const addWorkspace = document.getElementById("add-workspace") as HTMLButtonElement;
  const pickerStatus = document.getElementById("workspace-picker-status")!;
  const list = document.getElementById("session-list")!;
  const viewButtons = document.querySelectorAll<HTMLButtonElement>("[data-sidebar-view]");
  let settingsVisible = false;

  function renderView(): void {
    for (const button of viewButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.sidebarView === view));
    }
    const title = view === "workspaces" ? "Workspaces" : "Sessions";
    if (sidebarTitle.textContent !== title) sidebarTitle.textContent = title;
  }
  refreshViewControls = renderView;

  function showSettings(show: boolean): void {
    settingsVisible = show;
    settings.hidden = !show;
    if (show && !searchRow.hidden) closeSearch();
    searchOpen.hidden = show;
    sidebarTitle.hidden = show;
    addWorkspace.hidden = show;
    pickerStatus.hidden = show || !pickerStatus.textContent;
    settingsOpen.hidden = show;

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
      view = button.dataset.sidebarView === "sessions" ? "sessions" : "workspaces";
      renderView();
      saveState();
    });
  }

  addWorkspace.addEventListener("click", async () => {
    addWorkspace.disabled = true;
    pickerStatus.textContent = "";
    pickerStatus.hidden = true;
    try {
      const cwd = await selectWorkspaceDirectory();
      if (cwd !== null) addSidebarWorkspace(cwd);
    } catch (error) {
      pickerStatus.textContent = error instanceof Error && error.message
        ? error.message
        : "Could not choose a workspace directory.";
      pickerStatus.hidden = settingsVisible;
    } finally {
      addWorkspace.disabled = false;
    }
  });

  function saveState(): void {
    // Storage events can still be queued in a stale tab. Read the current list
    // before writing and apply only this tab's explicit archive/re-add actions.
    reconcileArchives();
    writeState();
  }

  function writeState(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        width,
        view,
        workspaces,
        activeWorkspace,
        collapsedWorkspaces: [...collapsedWorkspaces],
        archivedWorkspaces: [...archivedWorkspaces.values()],
      } satisfies SidebarState));
      pendingArchives.clear();
    } catch {
      // Storage denied: the sidebar still works for this page life.
    }
    // User-driven sidebar changes are workspace state: let the client mirror them.
    notifyStateChange?.(true);
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

  window.addEventListener("storage", (event) => {
    if (event.key !== STORE_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    // Read current storage rather than an event snapshot that may predate a
    // local action. Adoption never writes back or queues a daemon save.
    reconcileArchives();
    notifyStateChange?.(false);
  });

  applyExternalState = (state) => {
    width = clampWidth(state.width);
    view = state.view;
    workspaces = state.workspaces;
    activeWorkspace = state.activeWorkspace;
    collapsedWorkspaces = new Set(state.collapsedWorkspaces.map(workspacePathKey));
    pendingArchives.clear();
    for (const key of archivedWorkspaces.keys()) pendingArchives.set(key, null);
    archivedWorkspaces = new Map(state.archivedWorkspaces.map((path) => [workspacePathKey(path), path]));
    for (const [key, path] of archivedWorkspaces) pendingArchives.set(key, path);
    renderView();
    writeState();
    render();
  };

  render();
  renderView();
}

init();
