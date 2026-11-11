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
// Retain explicit archive/re-add actions if storage is
// denied or full, until a write succeeds. Unrelated saves introduce no archive edits.
type ArchiveIntent = { path: string | null; committed?: boolean };
const pendingArchives = new Map<string, ArchiveIntent>();
// Captured before controls become interactive, not after an asynchronous boot
// read. A successful fallback save is not a compatible daemon baseline.
let restorePending = true;
// If the initial read was denied, the first readable cache may still be the
// user's valid pre-existing preferences. Distinguish it from our own fallback.
let restoreFallbackWritten = false;
let restoreLocalBaseline: SidebarState | null = null;
function rememberRestoreBaseline(stored: SidebarState | null): void {
  if (restorePending && !restoreFallbackWritten && stored !== null) restoreLocalBaseline = stored;
}
type EditedPreference = "width" | "view" | "workspaces" | "activeWorkspace";
const restoreEdits = new Set<EditedPreference>();
const restoreCollapsed = new Map<string, boolean>();
const restoreArchives = new Map<string, string | null>();
function edited(...fields: EditedPreference[]): void {
  for (const field of fields) restoreEdits.add(field);
}
function archiveIntent(key: string, path: string | null): void {
  pendingArchives.set(key, { path });
  if (restorePending) restoreArchives.set(key, path);
}
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
  restoreCollapsed.set(key, collapsedWorkspaces.has(key));
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
  archiveIntent(key, path);
  savePreferences?.();
}

export function addSidebarWorkspace(cwd: string): void {
  const path = normalizeDirectoryPath(cwd);
  if (path === null) return;
  const key = workspacePathKey(path);
  const existing = workspaces.find((workspace) => workspacePathKey(workspace) === key);
  if (existing === undefined) workspaces = [...workspaces, path];
  archivedWorkspaces.delete(key);
  archiveIntent(key, null);
  activeWorkspace = existing ?? path;
  collapsedWorkspaces.delete(key);
  view = "workspaces";
  restoreCollapsed.set(key, false);
  edited("workspaces", "activeWorkspace", "view");
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
  edited("activeWorkspace");
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
let applyExternalState: ((state: SidebarState | null, isCurrent: () => boolean) => Promise<boolean>) | null = null;

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

/** Commit a compatible initial baseline, retaining edits made during async boot. */
export async function applySidebarState(value: unknown, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  const state = typeof value === "object" && value !== null && !Array.isArray(value)
    ? parseSidebarState(value) : null;
  return applyExternalState ? applyExternalState(state, isCurrent) : false;
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

function parseSidebarCache(value: string | null): SidebarState | null {
  try {
    const parsed: unknown = value === null ? null : JSON.parse(value);
    // Keep the existing field parser tolerant of older records and individual
    // invalid fields, but a JSON scalar/array is not a preferences record.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parseSidebarState(parsed)
      : null;
  } catch {
    return null;
  }
}

export function readSidebarState(): SidebarState | null {
  try {
    return parseSidebarCache(localStorage.getItem(STORE_KEY));
  } catch {
    // An unavailable cache must not erase this page's in-memory preferences.
    return null;
  }
}

function reconcileArchives(stored = readSidebarState(), intents = pendingArchives): void {
  if (stored !== null) {
    archivedWorkspaces = new Map(stored.archivedWorkspaces.map((path) => [workspacePathKey(path), path]));
  }
  for (const [key, intent] of intents) {
    if (intent.committed) continue;
    const { path } = intent;
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

  const cached = readSidebarState();
  restorePending = cached === null;
  const stored = cached ?? parseSidebarState(null);
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
      edited("view");
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

  const persistenceWarning = "Sidebar changes are only kept in this window: safe browser storage is unavailable. Use a browser with Web Locks on localhost or HTTPS.";
  function persistenceUnavailable(): false {
    pickerStatus.textContent = persistenceWarning;
    pickerStatus.hidden = settingsVisible;
    return false;
  }

  async function saveState(): Promise<boolean> {
    // Snapshot intent identities when queued: a later re-add must not be
    // consumed by an earlier request ahead of another tab's archive. Shared
    // identities also stop a queued resize from replaying an already saved edit.
    const intents = new Map(pendingArchives);
    const fallbackArchives = new Map(archivedWorkspaces);
    // Reflect edits immediately, including when storage or locking is denied.
    // Pending intents remain until the entire locked transaction succeeds.
    notifyStateChange?.(false);
    try {
      if (!navigator.locks?.request) return persistenceUnavailable();
      return await navigator.locks.request(STORE_KEY, () => {
        // Storage events may still be queued. The lock must cover the read,
        // merge AND write, including unrelated preference saves and restoration.
        // A denied read must abort even if writes happen to be allowed: without
        // the shared snapshot we cannot safely merge other tabs' archives.
        const stored = parseSidebarCache(localStorage.getItem(STORE_KEY));
        rememberRestoreBaseline(stored);
        if (stored === null) archivedWorkspaces = new Map(fallbackArchives);
        const liveActive = activeWorkspace;
        try {
          reconcileArchives(stored, intents);
          localStorage.setItem(STORE_KEY, JSON.stringify({
            width,
            view,
            workspaces,
            activeWorkspace,
            collapsedWorkspaces: [...collapsedWorkspaces],
            archivedWorkspaces: [...archivedWorkspaces.values()],
          } satisfies SidebarState));
          if (restorePending) restoreFallbackWritten = true;
        } finally {
          // An older queued archive must not deselect a newer explicit re-add.
          activeWorkspace = liveActive;
        }
        for (const [key, intent] of intents) {
          intent.committed = true;
          if (pendingArchives.get(key) === intent) pendingArchives.delete(key);
        }
        // Keep newer queued edits visible while their own turn is pending.
        reconcileArchives();
        if (pickerStatus.textContent === persistenceWarning) {
          pickerStatus.textContent = "";
          pickerStatus.hidden = true;
        }
        // Publish only after the cache contains the committed archive list.
        notifyStateChange?.(true);
        return true;
      });
    } catch {
      // No unlocked fallback: it would silently reintroduce cross-tab data loss.
      reconcileArchives();
      notifyStateChange?.(false);
      return persistenceUnavailable();
    }
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
    edited("width");
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

  applyExternalState = async (state, isCurrent) => {
    if (!isCurrent()) return false;
    try {
      if (!navigator.locks?.request) return persistenceUnavailable();
      return await navigator.locks.request(STORE_KEY, () => {
        // Generation/attempt cancellation precedes EVERY side effect, including
        // live adoption. Never call saveState here: it would reacquire this lock.
        if (!isCurrent()) return false;
        const cached = parseSidebarCache(localStorage.getItem(STORE_KEY));
        rememberRestoreBaseline(cached);
        if (!restorePending && cached !== null) return true;
        const live: SidebarState = {
          width, view, workspaces, activeWorkspace,
          collapsedWorkspaces: [...collapsedWorkspaces],
          archivedWorkspaces: [...archivedWorkspaces.values()],
        };
        const baseline = restoreLocalBaseline ?? state;
        const next = { ...(baseline ?? live) };
        for (const field of restoreEdits) {
          // Each explicitly edited preference wins; untouched preferences can
          // still come from the daemon. Workspace additions retain remote rows.
          Object.assign(next, { [field]: live[field] });
        }
        if (restoreEdits.has("workspaces") && baseline) {
          next.workspaces = normalizedDirectoryPaths([...baseline.workspaces, ...workspaces]);
        }
        const collapsed = new Set(next.collapsedWorkspaces.map(workspacePathKey));
        for (const [key, isCollapsed] of restoreCollapsed) {
          if (isCollapsed) collapsed.add(key); else collapsed.delete(key);
        }
        next.collapsedWorkspaces = [...collapsed];
        const archives = new Map(next.archivedWorkspaces.map((path) => [workspacePathKey(path), path]));
        for (const path of cached?.archivedWorkspaces ?? []) archives.set(workspacePathKey(path), path);
        // Already cached actions still override the initial remote baseline;
        // pending actions include newer edits made while this request queued.
        for (const [key, path] of restoreArchives) {
          if (path === null) archives.delete(key); else archives.set(key, path);
        }
        for (const [key, intent] of pendingArchives) {
          if (intent.path === null) archives.delete(key); else archives.set(key, intent.path);
        }
        next.archivedWorkspaces = [...archives.values()];
        if (next.activeWorkspace !== null && archives.has(workspacePathKey(next.activeWorkspace))) {
          next.activeWorkspace = next.workspaces.find((path) => !archives.has(workspacePathKey(path))) ?? null;
        }
        // Stage first: a denied read/write leaves both the baseline and live
        // preferences untouched, and retains all edit intent for a later retry.
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
        width = next.width;
        view = next.view;
        workspaces = next.workspaces;
        activeWorkspace = next.activeWorkspace;
        collapsedWorkspaces = new Set(next.collapsedWorkspaces.map(workspacePathKey));
        archivedWorkspaces = archives;
        restorePending = false;
        restoreLocalBaseline = null;
        restoreEdits.clear();
        restoreCollapsed.clear();
        restoreArchives.clear();
        if (pickerStatus.textContent === persistenceWarning) {
          pickerStatus.textContent = "";
          pickerStatus.hidden = true;
        }
        renderView();
        render();
        notifyStateChange?.(true);
        return true;
      });
    } catch {
      if (!isCurrent()) return false;
      return persistenceUnavailable();
    }
  };

  render();
  renderView();
}

init();
