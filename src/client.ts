import { trimSelectionHighlight } from "./selection";
import {
  applySidebarState, onSidebarStateChange, sidebarFolderView, sidebarFolderExpanded,
  toggleSidebarFolder, sidebarWorkspaces, sidebarActiveWorkspace, selectSidebarWorkspace,
  archiveSidebarWorkspace, sidebarWorkspaceArchived, normalizeDirectoryPath, STORE_KEY as SIDEBAR_KEY,
} from "./sidebar";
import { showWorkspaceFolder } from "./workspace-picker";
import { doneIndicator, workingIndicator } from "./working-indicator";
import { CompletionTracker } from "./completion-tracker";
import { CompletionNotifications } from "./notifications";
import { Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { loadImageAddon } from "./image-addon";
import { WebglAddon } from "@xterm/addon-webgl";
import { repairWebglCanvasResize } from "./webgl-resize";
import { shouldUseDomFallbackForSoftwareWebgl } from "./webgl-renderer";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { isRecord } from "./guards";
import { isNativeShell } from "./native-shell";
import { insertFilePaths, wireFileDrop, type FileReference } from "./file-drop";
import { initializeHotkeys } from "./hotkeys";
import { syncRuntimeLimit } from "./runtime-limit";
import { splitInputChunks } from "./client-input";
import {
  attachable,
  bindingForRuntime,
  bindingFromStored,
  emptyBinding,
  rebindPaneBinding,
  runtimeForSession,
  type PaneBinding,
} from "./lifecycle";
import { parsePasteResponse, parseRuntimesResponse, parseRuntimeOne, parseServerMessage, parseSessionList, parseStateResponse, type RuntimeInfo, type ServerMessage, type SessionSummaryLike } from "./protocol";

// Sidebar preferences share the durable-save path with panes, pins and font size.
onSidebarStateChange(() => {
  renderSidebar();
  queueStateSave();
});

const statusEl = document.getElementById("status") as HTMLElement;
const buildEl = document.getElementById("build") as HTMLElement;
const spaceTabsEl = document.getElementById("space-tabs") as HTMLElement;
const newSpaceEl = document.getElementById("new-space") as HTMLButtonElement;
const splitLayoutEl = document.getElementById("split-layout") as HTMLButtonElement;
const panesEl = document.getElementById("panes") as HTMLElement;
const sessionListEl = document.getElementById("session-list") as HTMLElement;
const searchEl = document.getElementById("search") as HTMLInputElement;
const newSessionEl = document.getElementById("new-session") as HTMLButtonElement;

// Cell geometry mirrors the Konsole profile these sessions normally run in: Hack
// (Konsole's font is QFontDatabase::systemFont(FixedFont); both running Konsole
// processes have Hack-Regular.ttf mapped) at 10pt = 13.33px. "JetBrainsMono Nerd
// Font Mono" (PUA-only via unicode-range) supplies omp's nerd-preset icons at
// exactly one cell wide. Tune the terminal look here, nowhere else.
//
// Keep text geometry fixed across panes. WebGL custom glyphs join box/block
// characters to cell edges instead of relying on the font's stroke extents.
const CELL_SIZE = 13.33;
const CELL_LINE_HEIGHT = 1;
const CELL_MIN = 8;
const CELL_MAX = 28;
const CELL_KEY = "omp-desktop.cellSize";
const LAYOUT_KEY = "omp-desktop.layout.v1";
/** Workspace document format mirrored to the daemon's durable state file. */
const STATE_VERSION = 2;
/** Keep in sync with src/state.ts so an oversized document fails before the wire. */
const STATE_LIMIT_BYTES = 1024 * 1024;
const MAX_PANES = 4;
/** Divider drag clamp; the stored-layout reader accepts 0.1..0.9, so stay inside it. */
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const FONT_STACK =
  '"Hack", "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", ui-monospace, SFMono-Regular, monospace';

function openTerminalLink(_event: MouseEvent, uri: string): void {
  const url = new URL(uri);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // Give the native new-window policy the destination immediately; xterm's
  // default blank popup is denied before it can assign the destination.
  window.open(url.href, "_blank", "noopener,noreferrer");
}

function storedCellSize(): number {
  const raw = Number(localStorage.getItem(CELL_KEY));
  return Number.isFinite(raw) && raw >= CELL_MIN && raw <= CELL_MAX ? raw : CELL_SIZE;
}
let cellSize = storedCellSize();

/**
 * Persisted per pane: which runtime it shows, plus labels for when that runtime
 * is gone. `PaneBinding` lives in ./lifecycle with the rules that decide when a
 * binding's resume claim survives a daemon restart or a deliberate stop.
 */
type LayoutNode =
  | { kind: "leaf"; pane: string }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };
type StoredLayout = { tree: LayoutNode; panes: Record<string, PaneBinding>; focused: string | null };
type SpaceLayout = { id: string; layout: StoredLayout };
type StoredWorkspace = { spaces: SpaceLayout[]; activeSpaceId: string };

const panes = new Map<string, Pane>();
const spaces = new Map<string, StoredLayout>();
let layout: StoredLayout = { tree: { kind: "leaf", pane: "p1" }, panes: {}, focused: "p1" };
let activeSpaceId = "s1";
/** Temporary presentation only; never replace or persist the split tree. */
let expandedPaneId: string | null = null;
spaces.set(activeSpaceId, layout);
let spaceSeq = 1;
/** True after local restoration or the initial compatible daemon reconciliation. */
let restoredLocal = false;
/** A restored layout owns its empty slots as well as its bound sessions. */
let hasSavedWorkspace = false;
let runtimes: RuntimeInfo[] = [];
let defaultCwd: string | null = null;
let sessions: SessionSummaryLike[] = [];
let daemonUp = false;
/** Generation of the daemon that last answered: changes on every daemon restart. */
let daemonId: string | null = null;
/**
 * Set when a daemon restart (or a first contact with a daemon) may have a pool
 * to hand back: unclaimed runtimes are adopted while the pool grows, and the
 * window closes on the first poll where it did not.
 */
let adoptPending = false;
let adoptSeen = 0;
const completionTracker = new CompletionTracker();
const acknowledgedCompletions = new Map<string, string>();
const completionNotifications = new CompletionNotifications(
  document.getElementById("notifications-toggle") as HTMLButtonElement,
  document.getElementById("notifications-status") as HTMLElement,
  focusRuntime,
);
void completionNotifications.initialize();

const PINS_KEY = "omp-desktop.pins.v1";
function readPins(): SessionSummaryLike[] {
  try {
    return parseSessionList({ sessions: JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]") }) ?? [];
  } catch {
    return [];
  }
}
let pinnedSessions = readPins();

/** Sticky while the durable workspace copy cannot be written; shown by setStatus. */
let stateSaveError: string | null = null;
let stateDelivering = false;
let stateQueued = false;
let stateSaveTimer: number | undefined;
/**
 * Publishing gate. Closed until the daemon's document has been read (or proven
 * absent) and every adopted field is in memory, so a partial or fallback
 * workspace can never overwrite the durable copy. Browser storage keeps caching
 * while closed; only the daemon PUT is held back.
 */
let stateGate: "pending" | "ready" | "blocked" = "pending";
/** Why publishing is blocked; surfaced when a save is attempted while gated. */
let stateGateReason = "";
let stateGateGeneration: string | null = null;
/** Fingerprint of the last document the daemon accepted, to skip no-op PUTs. */
let deliveredState = "";

function savePins(): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pinnedSessions));
  } catch {
    console.warn("omp-desktop: pinned chats cannot be cached in browser storage");
    setStatus("Pinned chats cannot be cached in this browser — saved on the daemon only", "warn");
  }
  queueStateSave();
}
type SidebarRowRecord = {
  element: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  pin: HTMLButtonElement;
  runtime: RuntimeInfo | null;
  session: SessionSummaryLike | null;
  snapshot: SessionSummaryLike | null;
  nameKey: string;
  subKey: string;
  dragPayload: Record<string, unknown>;
};

type SidebarFolderRecord = {
  element: HTMLElement;
  heading: HTMLButtonElement;
  marker: HTMLElement;
  label: HTMLElement;
  contents: HTMLElement;
  more: HTMLButtonElement;
  showAllSessions: boolean;
};

const sidebarRows = new Map<string, SidebarRowRecord>();
const sidebarFolders = new Map<string, SidebarFolderRecord>();
const sidebarHeadings = new Map<string, HTMLElement>();
const collapsedSidebarSections = new Set<string>();
let sidebarFolderSeq = 0;
let sidebarEmpty: HTMLElement | null = null;
let archivedPaths = new Set<string>();

const SESSION_ICONS = {
  edit: '<path d="m16 3 5 5-12 12H4v-5Z"/><path d="m14 5 5 5"/>',
  pin: '<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z"/><path d="M12 15v6"/>',
  unload: '<path d="M5 4v16h14V4"/><path d="M12 3v11m-4-4 4 4 4-4"/>',
  archive: '<path d="M3 3h18v5H3zM5 8v13h14V8M10 12h4"/>',
  save: '<path d="m5 12 4 4L19 6"/>',
  cancel: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function iconButton(label: string, icon: keyof typeof SESSION_ICONS): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${SESSION_ICONS[icon]}</svg>`;
  return button;
}

async function saveSessionTitle(path: string, title: string): Promise<void> {
  const result = await getJson("/api/sessions/title", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, title }),
  });
  if (result === null) return;
  for (const session of [...sessions, ...pinnedSessions]) if (session.path === path) session.title = title;
  for (const pane of panes.values()) {
    if (pane.binding.sessionFile !== path) continue;
    pane.binding.title = title;
    pane.renderHeader();
    pane.renderPlaceholder();
  }
  renderSidebar();
  save();
  await refreshSessions();
}

const sessionMenu = document.createElement("div");
sessionMenu.className = "pane-menu session-menu";
sessionMenu.setAttribute("role", "menu");
sessionMenu.setAttribute("aria-label", "Session actions");
sessionMenu.hidden = true;
document.body.append(sessionMenu);
sessionMenu.addEventListener("mousedown", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
});
function closeSessionMenu(): void {
  sessionMenu.hidden = true;
  sessionMenu.replaceChildren();
}
function showSessionMenu(record: SidebarRowRecord, x: number, y: number): void {
  closePaneMenu();
  closeWorkspaceMenu();
  const session = record.snapshot;
  const runtime = record.runtime;
  const item = (label: string, icon: keyof typeof SESSION_ICONS, action: () => void, disabled = false): void => {
    const button = iconButton(label, icon);
    button.append(document.createTextNode(label));
    button.setAttribute("role", "menuitem");
    button.disabled = disabled;
    button.addEventListener("click", action);
    sessionMenu.append(button);
  };
  item("Edit title", "edit", () => {
    if (!session) return;
    sessionMenu.replaceChildren();
    const input = document.createElement("input");
    input.maxLength = 1024;
    input.value = session.title;
    input.setAttribute("aria-label", "Edit session title");
    const save = iconButton("Save title", "save");
    const cancel = iconButton("Cancel title edit", "cancel");
    const commit = (): void => {
      const title = input.value.trim();
      closeSessionMenu();
      if (title) void saveSessionTitle(session.path, title);
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", closeSessionMenu);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); commit(); }
    });
    sessionMenu.append(input, save, cancel);
    input.focus();
  }, !session);
  const pinned = session && pinnedSessions.some((pin) => pin.path === session.path);
  item(pinned ? "Unpin" : "Pin", "pin", () => { closeSessionMenu(); record.pin.click(); }, !session);
  item("Unload session", "unload", () => {
    closeSessionMenu();
    if (runtime) void killRuntime(runtime.id);
  }, !runtime);
  item("Archive", "archive", () => {
    closeSessionMenu();
    if (!session) return;
    void (async () => {
      const result = await getJson("/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: session.path }),
      });
      if (result === null) return;
      archivedPaths.add(session.path);
      pinnedSessions = pinnedSessions.filter((pin) => pin.path !== session.path);
      savePins();
      renderSidebar();
      await refreshSessions();
    })();
  }, !session);
  sessionMenu.hidden = false;
  const rect = sessionMenu.getBoundingClientRect();
  sessionMenu.style.left = `${Math.max(0, Math.min(x, innerWidth - rect.width))}px`;
  sessionMenu.style.top = `${Math.max(0, Math.min(y, innerHeight - rect.height))}px`;
  sessionMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !sessionMenu.contains(event.target)) closeSessionMenu();
}, true);
sessionMenu.addEventListener("focusout", () => {
  queueMicrotask(() => {
    if (!sessionMenu.contains(document.activeElement)) closeSessionMenu();
  });
});
window.addEventListener("blur", closeSessionMenu);
window.addEventListener("resize", closeSessionMenu);

const workspaceMenu = document.createElement("div");
workspaceMenu.id = "workspace-actions-menu";
workspaceMenu.className = "pane-menu";
workspaceMenu.setAttribute("role", "menu");
workspaceMenu.hidden = true;
document.body.append(workspaceMenu);
let workspaceMenuAnchor: HTMLButtonElement | null = null;

function closeWorkspaceMenu(restoreFocus = false): void {
  workspaceMenu.hidden = true;
  workspaceMenu.replaceChildren();
  workspaceMenuAnchor?.setAttribute("aria-expanded", "false");
  const anchor = workspaceMenuAnchor;
  workspaceMenuAnchor = null;
  if (restoreFocus) anchor?.focus();
}

function showWorkspaceMenu(cwd: string, anchor: HTMLButtonElement): void {
  if (!workspaceMenu.hidden && workspaceMenuAnchor === anchor) {
    closeWorkspaceMenu();
    return;
  }
  closePaneMenu();
  closeSessionMenu();
  closeWorkspaceMenu();
  workspaceMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  workspaceMenu.setAttribute("aria-label", `Workspace actions for ${cwd}`);
  const item = (label: string, action: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", action);
    workspaceMenu.append(button);
  };
  item("Archive workspace", () => {
    closeWorkspaceMenu();
    archiveSidebarWorkspace(cwd);
    document.querySelector<HTMLButtonElement>("#add-workspace")?.focus();
  });
  item("Show folder", () => {
    closeWorkspaceMenu(true);
    void showWorkspaceFolder(cwd).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Could not open folder: ${detail}`, "warn");
    });
  });
  workspaceMenu.hidden = false;
  const rect = workspaceMenu.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const x = Math.max(0, Math.min(anchorRect.right - rect.width, innerWidth - rect.width));
  const y = Math.max(0, Math.min(anchorRect.bottom, innerHeight - rect.height));
  workspaceMenu.style.left = `${x}px`;
  workspaceMenu.style.top = `${y}px`;
  workspaceMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}

workspaceMenu.addEventListener("keydown", (event) => {
  const items = [...workspaceMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeWorkspaceMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Node) || workspaceMenu.contains(event.target)) return;
  if (event.target instanceof Element && event.target.closest("button.workspace-menu") === workspaceMenuAnchor) return;
  closeWorkspaceMenu();
}, true);
workspaceMenu.addEventListener("focusout", () => {
  queueMicrotask(() => {
    if (!workspaceMenu.contains(document.activeElement)) closeWorkspaceMenu();
  });
});
window.addEventListener("blur", () => closeWorkspaceMenu());
window.addEventListener("resize", () => closeWorkspaceMenu());

function pinButton(currentSession: () => SessionSummaryLike | null): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "pin";
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z"/><path d="M12 15v6"/></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const session = currentSession();
    if (!session) return;
    const pinned = pinnedSessions.some((entry) => entry.path === session.path);
    pinnedSessions = pinned
      ? pinnedSessions.filter((entry) => entry.path !== session.path)
      : [...pinnedSessions, session];
    savePins();
    renderSidebar();
  });
  return button;
}
let paneSeq = 0;
let dragging = false;
let renderPending = false;

/** Pointer capture keeps session moves inside the page: WebKitGTK's OS drag
 * transport can end custom-MIME HTML drags before delivering a drop. */
function wireSessionDrag(
  element: HTMLElement,
  payload: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  let origin: { x: number; y: number; pointer: number } | null = null;
  let moved = false;
  let suppressClick = false;
  let target: HTMLElement | null = null;
  let preview: HTMLElement | null = null;
  let offsetX = 0;
  let offsetY = 0;
  element.style.touchAction = "none";
  element.addEventListener("pointerdown", (event) => {
    if (origin || dragging || !event.isPrimary || event.button !== 0
        || (event.target as Element).closest("button, a, input")) return;
    event.preventDefault();
    origin = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    moved = false;
    suppressClick = false;
    dragging = true;
    document.body.classList.add("session-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    document.body.addEventListener("lostpointercapture", finish);
  });
  const move = (event: PointerEvent): void => {
    if (!origin || event.pointerId !== origin.pointer) return;
    if (!moved && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return;
    if (!moved) {
      moved = true;
      document.body.setPointerCapture(event.pointerId);
      window.getSelection()?.removeAllRanges();
      for (const pane of panes.values()) pane.term.clearSelection();
      const rect = element.getBoundingClientRect();
      preview = element.cloneNode(true) as HTMLElement;
      preview.removeAttribute("id");
      preview.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
      preview.classList.add("session-drag-preview");
      preview.setAttribute("aria-hidden", "true");
      preview.inert = true;
      const width = Math.min(rect.width, 360);
      preview.style.width = `${width}px`;
      offsetX = Math.min(origin.x - rect.left, width - 12);
      offsetY = origin.y - rect.top;
      document.body.append(preview);
      element.classList.add("session-drag-source");
    }
    preview!.style.transform = `translate3d(${event.clientX - offsetX}px, ${event.clientY - offsetY}px, 0)`;
    event.preventDefault();
    let hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".space-tab, .pane") ?? null;
    const spaceId = hit?.dataset.space;
    if (spaceId && spaceId !== activeSpaceId) {
      switchSpace(spaceId);
      // Switching rebuilds tabs: highlight the replacement, not the detached tab.
      hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".space-tab, .pane") ?? null;
    }
    if (hit !== target) {
      target?.classList.remove("drop");
      target = hit;
      target?.classList.add("drop");
    }
  };
  const finish = (event: PointerEvent): void => {
    if (!origin || event.pointerId !== origin.pointer) return;
    const destination = target;
    const shouldDrop = moved && event.type === "pointerup";
    suppressClick = moved;
    target?.classList.remove("drop");
    target = null;
    origin = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    document.body.removeEventListener("lostpointercapture", finish);
    preview?.remove();
    preview = null;
    element.classList.remove("session-drag-source");
    document.body.classList.remove("session-dragging");
    if (document.body.hasPointerCapture(event.pointerId)) document.body.releasePointerCapture(event.pointerId);
    if (shouldDrop && destination) {
      event.preventDefault();
      const currentPayload = typeof payload === "function" ? payload() : payload;
      if (destination.dataset.space) handleSpaceDrop(destination.dataset.space, currentPayload);
      else if (destination.dataset.pane) handlePaneDrop(destination.dataset.pane, currentPayload);
    }
    dragging = false;
    if (renderPending) renderSidebar();
  };
  element.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function handlePaneDrop(paneId: string, payload: Record<string, unknown>): void {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (payload.kind === "pane" && typeof payload.paneId === "string") swapPanes(payload.paneId, paneId);
  else if (payload.kind === "runtime" && typeof payload.runtimeId === "string") {
    const runtime = runtimes.find((candidate) => candidate.id === payload.runtimeId);
    if (runtime) pane.bind(bindingForRuntime(runtime, displayTitle(runtime)));
  } else if (payload.kind === "session" && typeof payload.path === "string"
      && typeof payload.cwd === "string" && typeof payload.title === "string") {
    void openSession(pane, { path: payload.path, cwd: payload.cwd, title: payload.title });
  }
}

// ---------------------------------------------------------------- daemon API

const jsonReads = new Map<string, Promise<unknown | null>>();

/**
 * Fetch JSON for a boundary that validates its own shape. Identical overlapping
 * reads share one request; failures still return null and surface in the status.
 */
function getJson(path: string, init?: RequestInit): Promise<unknown | null> {
  const shareable = (init?.method ?? "GET").toUpperCase() === "GET";
  const readKey = path === "/api/runtimes" ? path : `${path}\u0000${daemonId ?? ""}`;
  const existing = shareable ? jsonReads.get(readKey) : undefined;
  if (existing) return existing;
  const request = (async (): Promise<unknown | null> => {
    try {
      const res = await fetch(path, { cache: "no-cache", ...init });
      if (!res.ok) {
        setStatus(`${path} → ${res.status}`, "warn");
        return null;
      }
      return (await res.json()) as unknown;
    } catch {
      setStatus("daemon unreachable", "warn");
      return null;
    }
  })();
  if (shareable) {
    jsonReads.set(readKey, request);
    void request.then(() => {
      if (jsonReads.get(readKey) === request) jsonReads.delete(readKey);
    });
  }
  return request;
}

async function refreshRuntimes(options: { restore?: boolean } = {}): Promise<boolean> {
  const payload = parseRuntimesResponse(await getJson("/api/runtimes"));
  if (!payload) {
    daemonUp = false;
    renderSidebar();
    return false;
  }
  const previousGeneration = daemonId;
  daemonUp = true;
  daemonId = payload.generation;
  defaultCwd = payload.defaultCwd;
  const generationChanged = previousGeneration !== daemonId;
  if (generationChanged) {
    stateGate = "pending";
    stateGateGeneration = null;
    stateGateReason = "";
    deliveredState = "";
    stateQueued = false;
  }
  // A new (or never-seen) generation means the pool this client knew is gone
  // and the daemon may be rebuilding it right now. Watch the pool while it
  // grows so restored sessions no pane claims still get a view.
  if (options.restore !== false && (previousGeneration === null || daemonId !== previousGeneration)) {
    adoptPending = true;
    adoptSeen = 0;
  }
  // A new generation (or the first answer) also means a limit saved before a
  // restart is in effect now, so the Settings panel re-reads it here.
  if (previousGeneration === null || daemonId !== previousGeneration) void syncRuntimeLimit();
  runtimes = payload.runtimes;
  completionTracker.observe(runtimes, (runtime) => {
    void completionNotifications.notifyCompletion(runtime.id, displayTitle(runtime));
  });
  renderSidebar();
  // A daemon restart may bring back ledger runtimes; panes only adopt entries
  // already present and never recreate missing sessions.
  for (const pane of panes.values()) pane.syncFromRuntimes();
  setStatus("", "ok");
  if (generationChanged && options.restore !== false) await reconcileWorkspaceState();
  if (options.restore !== false && stateGate === "pending") return true;
  if (options.restore !== false && adoptPending) {
    if (runtimes.length > adoptSeen) {
      adoptSeen = runtimes.length;
      adoptUnclaimedRuntimes();
    } else {
      adoptPending = false;
    }
  }
  return true;
}


async function refreshSessions(): Promise<void> {
  const search = searchEl.value.trim();
  const query = new URLSearchParams({ limit: "60" });
  if (search) query.set("search", search);
  const payload = await getJson(`/api/sessions?${query}`);
  const list = parseSessionList(payload);
  if (isRecord(payload) && Array.isArray(payload.archivedPaths)) {
    archivedPaths = new Set(payload.archivedPaths.filter((path): path is string => typeof path === "string"));
  }
  if (!list) return;
  sessions = list;
  for (const pane of panes.values()) {
    const session = sessions.find((entry) => entry.path === pane.binding.sessionFile);
    if (!session || pane.binding.title === session.title) continue;
    pane.binding.title = session.title;
    pane.renderHeader();
    pane.renderPlaceholder();
  }
  renderSidebar();
}

/** Uploads a pasted image; the daemon returns the path it stored it at. */
async function uploadPaste(file: Blob): Promise<string | null> {
  try {
    const res = await fetch("/api/paste", { method: "POST", headers: { "content-type": file.type }, body: file });
    if (!res.ok) return null;
    return parsePasteResponse(await res.json());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- panes

/** Title/cwd for a transcript path from the loaded list or a pinned snapshot. */
function sessionSummary(path: string): SessionSummaryLike | undefined {
  return sessions.find((session) => session.path === path) ?? pinnedSessions.find((session) => session.path === path);
}

function displayTitle(runtime: RuntimeInfo): string {
  const match = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
  if (match) return match.title;
  if (runtime.title && !/^\d{4}-\d{2}-\d{2}T/.test(runtime.title)) return runtime.title;
  return runtime.cwd.replace(/^\/home\/[^/]+/, "~") || runtime.id;
}

function focusRuntime(runtimeId: string): void {
  const pane = [...panes.values()].find((candidate) => candidate.binding.runtimeId === runtimeId);
  pane?.focus();
}

/** xterm's measured cell dimensions in CSS pixels, matching host geometry. */
type CellMetrics = { cellW: number; cellH: number };

function xtermMetrics(term: Terminal): CellMetrics | null {
  const css = (
    term as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width?: number; height?: number } } };
        };
      };
    }
  )._core?._renderService?.dimensions?.css;
  const cellW = css?.cell?.width;
  const cellH = css?.cell?.height;
  if (typeof cellW !== "number" || !(cellW > 0)) return null;
  if (typeof cellH !== "number" || !(cellH > 0)) return null;
  return { cellW, cellH };
}

/** DOM measurement fallback if xterm's internal metrics become unavailable. */
function drawnMetrics(term: Terminal): CellMetrics | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const cols = term.cols;
  const rows = term.rows;
  if (!screen || !cols || !rows) return null;
  const box = screen.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return { cellW: box.width / cols, cellH: box.height / rows };
}

/** Keep prompt text from terminal input, not cursor/status reports or escape keys. */
function draftableTerminalInput(data: string): string {
  return data
    .replace(/\x1b\[(?:200|201)~/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n");
}

class Pane {
  readonly id: string;
  readonly el: HTMLElement;
  readonly term: Terminal;
  binding: PaneBinding;
  ws: WebSocket | null = null;
  retry = 0;
  #lastSent = "";
  #body: HTMLElement;
  #host: HTMLElement;
  #titleActions: HTMLElement;
  #placeholder: HTMLElement;
  #orphanReview: HTMLElement;
  #orphanText: HTMLElement;
  #starting: HTMLElement;
  #startupTimer: number | undefined;
  #startupFrame = false;
  #placeholderKey = "";
  #jumpLatest: HTMLButtonElement;
  #titleEl: HTMLInputElement;
  #editingTitle: { path: string; original: string } | null = null;
  #stateEl: HTMLElement;
  #pin: HTMLButtonElement;
  #observer: ResizeObserver;
  #resizeTimer: number | undefined;
  #replaying = false;
  #composer: HTMLElement;
  #draftInput: HTMLTextAreaElement;
  #submitButton: HTMLButtonElement;
  #composerStatus: HTMLElement;
  #historyController: AbortController | null = null;
  #historyKey = "";
  #historyReady = false;
  #historyError: string | null = null;
  #historyLoading = false;
  #submissions = new Map<string, { text: string }>();
  #draftSaveTimer: number | undefined;
  #pendingInputs = new Map<string, { data: string; sessionFile: string | null }>();
  #inputSequence = 0;
  #selectionEvents = new AbortController();
  #selectionRevision = 0;
  #disposeFileDrop: (() => void) | null = null;
  #needsRepaint = false;

  constructor(id: string, binding: PaneBinding) {
    this.id = id;
    this.binding = binding;
    this.el = document.createElement("section");
    this.el.className = "pane";
    this.el.dataset.pane = id;

    const header = document.createElement("header");
    header.className = "pane-header";
    this.#titleEl = document.createElement("input");
    this.#titleEl.maxLength = 1024;
    this.#titleEl.className = "pane-title";
    this.#titleEl.readOnly = true;
    this.#titleEl.setAttribute("aria-label", "Session title");
    this.#titleEl.addEventListener("mousedown", (event) => event.stopPropagation());
    this.#titleEl.addEventListener("input", () => {
      this.#titleEl.style.width = `${Math.max(2, this.#titleEl.value.length + 2)}ch`;
    });
    this.#titleEl.addEventListener("click", () => this.#beginTitleEdit());
    this.#titleEl.addEventListener("blur", (event) => {
      if (event.relatedTarget instanceof Node && this.#titleActions.contains(event.relatedTarget)) return;
      this.#finishTitleEdit(false);
    });
    this.#titleEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!this.#editingTitle && event.key === "Enter") this.#beginTitleEdit();
        else {
          this.#finishTitleEdit(true);
          this.focus();
        }
      }
    });
    this.#titleActions = document.createElement("div");
    this.#titleActions.className = "title-edit-actions";
    this.#titleActions.hidden = true;
    for (const [label, icon, commit] of [
      ["Save title", "save", true], ["Cancel title edit", "cancel", false],
    ] as const) {
      const button = iconButton(label, icon);
      button.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#finishTitleEdit(commit);
        this.focus();
      });
      button.addEventListener("blur", (event) => {
        if (event.relatedTarget === this.#titleEl || event.relatedTarget instanceof Node && this.#titleActions.contains(event.relatedTarget)) return;
        this.#finishTitleEdit(false);
      });
      this.#titleActions.append(button);
    }
    this.#stateEl = document.createElement("span");
    this.#stateEl.className = "pane-state";
    const actions = document.createElement("div");
    actions.className = "pane-actions";
    this.#pin = pinButton(() => this.binding.sessionFile ? sessionSummary(this.binding.sessionFile) ?? null : null);
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Close pane (shortcut editable in Settings)";
    close.className = "pane-close";
    close.setAttribute("aria-label", "Close pane");
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closePane(this.id);
    });
    actions.append(close, this.#pin);
    header.append(this.#titleEl, this.#titleActions, this.#stateEl, actions);

    this.#body = document.createElement("div");
    this.#body.className = "pane-body";
    this.#host = document.createElement("div");
    this.#host.className = "term-host";
    this.#placeholder = document.createElement("div");
    this.#placeholder.className = "pane-placeholder";
    this.#orphanReview = document.createElement("section");
    this.#orphanReview.className = "orphan-draft-review";
    this.#orphanReview.setAttribute("aria-label", "Unattributed recovered input");
    const orphanHeading = document.createElement("strong");
    orphanHeading.textContent = "Recovered input — review before reuse; not automatically resent";
    this.#orphanText = document.createElement("pre");
    const discardOrphan = document.createElement("button");
    discardOrphan.type = "button";
    discardOrphan.textContent = "Discard recovered input";
    discardOrphan.addEventListener("click", () => {
      delete this.binding.orphanDraft;
      this.renderPlaceholder();
      save();
    });
    this.#orphanReview.append(orphanHeading, this.#orphanText, discardOrphan);
    this.#composer = document.createElement("form");
    this.#composer.className = "cold-composer";
    this.#draftInput = document.createElement("textarea");
    this.#draftInput.rows = 2;
    this.#draftInput.placeholder = "Write a message. Submit to load or start this session.";
    this.#draftInput.setAttribute("aria-label", "Message this session");
    this.#submitButton = document.createElement("button");
    this.#submitButton.type = "submit";
    this.#submitButton.textContent = "Send";
    this.#composerStatus = document.createElement("span");
    this.#composerStatus.className = "cold-composer-status";
    this.#composerStatus.setAttribute("role", "status");
    this.#composerStatus.setAttribute("aria-live", "polite");
    this.#composer.append(this.#draftInput, this.#submitButton, this.#composerStatus);
    this.#composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#submitColdDraft();
    });
    this.#draftInput.value = this.#draftFor(this.binding.sessionFile);
    this.#draftInput.addEventListener("input", () => {
      this.#storeCurrentDraft(this.#draftInput.value);
      this.#composerStatus.textContent = "";
      this.#updateComposer();
      window.clearTimeout(this.#draftSaveTimer);
      this.#draftSaveTimer = window.setTimeout(() => save(), 250);
    });
    this.#draftInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.#submitColdDraft();
      }
    });
    this.#body.append(this.#orphanReview, this.#placeholder, this.#host, this.#composer);
    this.#starting = document.createElement("div");
    this.#starting.className = "pane-starting";
    this.#starting.setAttribute("role", "status");
    this.#starting.textContent = "Starting session…";
    this.#starting.hidden = true;
    this.#body.append(this.#starting);
    this.#jumpLatest = document.createElement("button");
    this.#jumpLatest.className = "pane-jump-latest";
    this.#jumpLatest.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 6 6 6-6M6 12l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.#jumpLatest.title = "Jump to latest";
    this.#jumpLatest.setAttribute("aria-label", "Jump to latest");
    this.#jumpLatest.hidden = true;
    this.#jumpLatest.addEventListener("click", () => {
      this.term.scrollToBottom();
      this.#syncJumpLatest();
      this.focus();
    });
    this.#body.append(this.#jumpLatest);

    this.term = new Terminal({
      allowProposedApi: true,
      linkHandler: { activate: openTerminalLink },
      cursorBlink: true,
      scrollback: 20_000,
      fontSize: cellSize,
      lineHeight: CELL_LINE_HEIGHT,
      customGlyphs: true,
      fontFamily: FONT_STACK,
      theme: {
        background: "#000000",
        foreground: "#e8ecf4",
        cursor: "#00b4ff",
        selectionBackground: "#444444",
        selectionInactiveBackground: "#444444",
      },
    });
    // Let the WebView deliver clipboard data instead of sending Ctrl+V (0x16)
    // to omp, which would make the child read the OS clipboard itself.
    this.term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey &&
          (event.key === "c" || event.key === "C") && !this.term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          // Escape cancels work without OMP's repeated-Ctrl+C session exit.
          if (!event.shiftKey) this.#sendInput("\x1b");
        }
        return false;
      }
      return !((event.key === "v" || event.key === "V") && (event.ctrlKey || event.metaKey) && !event.altKey);
    });
    // xterm paints OSC 8 file targets with a dashed underline even though its
    // default link handler cannot open them. Consume those links only; preserve
    // HTTP links and explicit SGR underlining in the transcript.
    this.term.parser.registerOscHandler(8, (data) => {
      const separator = data.indexOf(";");
      return separator >= 0 && data.slice(separator + 1).startsWith("file:");
    });
    this.term.open(this.#host);
    trimSelectionHighlight(this.term);
    this.term.loadAddon(new UnicodeGraphemesAddon());
    const rendererWarning = document.createElement("span");
    rendererWarning.textContent = "DOM";
    rendererWarning.title = "GPU renderer unavailable: box and block glyphs may have seams";
    const showRendererWarning = () => {
      this.el.dataset.renderer = "dom";
      if (!rendererWarning.isConnected) header.insertBefore(rendererWarning, actions);
    };
    if (shouldUseDomFallbackForSoftwareWebgl()) {
      showRendererWarning();
    } else {
      let webgl: WebglAddon | undefined;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          showRendererWarning();
        });
        this.term.loadAddon(webgl);
        repairWebglCanvasResize(webgl);
        this.el.dataset.renderer = "webgl";
      } catch (error) {
        webgl?.dispose();
        showRendererWarning();
        console.warn("omp-desktop: GPU renderer unavailable", error);
      }
    }
    loadImageAddon(this.term);
    // OMP clears the screen before replacing its startup protocol with the TUI.
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (!this.#replaying && params[0] === 2) this.#startupFrame = true;
      return false;
    });
    this.term.onWriteParsed(() => {
      if (this.#startupFrame && !this.#replaying) this.#finishStartup();
    });
    this.term.loadAddon(new WebLinksAddon(openTerminalLink));
    this.term.onData((data) => this.#sendInput(data));
    this.term.onSelectionChange(() => { this.#selectionRevision++; });
    this.term.onScroll(() => this.#syncJumpLatest());
    this.term.onWriteParsed(() => this.#syncJumpLatest());
    this.term.onResize(() => this.#syncJumpLatest());
    this.term.buffer.onBufferChange(() => this.#syncJumpLatest());

    // Copy the completed selection, not every intermediate mousemove. Listening
    // on window also handles a drag released outside the terminal.
    let selecting = false;
    this.#host.addEventListener("mousedown", (event) => {
      if (event.button === 0) selecting = true;
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button !== 0 || !selecting) return;
      selecting = false;
      const text = this.term.getSelection();
      if (!text.trim()) {
        this.term.clearSelection();
        return;
      }
      void this.#copySelection(text);
    }, { signal: this.#selectionEvents.signal });
    window.addEventListener("blur", () => { selecting = false; }, { signal: this.#selectionEvents.signal });
    this.el.append(header, this.#body);
    this.el.addEventListener("mousedown", (event) =>
      this.focus(event.target instanceof Node && this.#host.contains(event.target)),
    );
    this.#observer = new ResizeObserver(() => this.#scheduleFit());
    this.#observer.observe(this.#body);

    wireSessionDrag(header, { kind: "pane", paneId: this.id });
    this.#wireDrop();
    this.#disposeFileDrop = wireFileDrop(this.el, {
      onPaths: (paths) => insertFilePaths((data, files) => this.#sendOrStageInput(data, files), paths, !this.binding.runtimeId),
      upload: uploadPaste,
    });
    // xterm stops paste propagation at its textarea. Capture image files before
    // that text-only handler can consume the event or emit an empty paste.
    this.el.addEventListener("paste", (event) => this.#handlePaste(event), { capture: true });
    this.renderPlaceholder();
  }

  get #submitting(): boolean {
    const identity = this.#draftIdentity(this.binding.sessionFile);
    return identity !== null && this.#submissions.has(identity);
  }

  #draftIdentity(sessionFile: string | null, cwd = this.binding.cwd): string | null {
    return sessionFile ?? (cwd ? `new:${cwd}` : null);
  }

  #draftFor(sessionFile: string | null, cwd = this.binding.cwd): string {
    const key = this.#draftIdentity(sessionFile, cwd);
    const draft = key ? this.binding.drafts?.[key] : this.binding.orphanDraft;
    return typeof draft === "string" ? draft : "";
  }

  #storeDraft(identity: string, text: string): void {
    const drafts = this.binding.drafts ?? (this.binding.drafts = {});
    if (text) drafts[identity] = text;
    else {
      delete drafts[identity];
      delete this.binding.draftFiles?.[identity];
      if (this.binding.draftFiles && Object.keys(this.binding.draftFiles).length === 0) delete this.binding.draftFiles;
    }
    if (Object.keys(drafts).length === 0) delete this.binding.drafts;
  }

  #storeCurrentDraft(text: string): void {
    const identity = this.#draftIdentity(this.binding.sessionFile);
    if (identity) this.#storeDraft(identity, text);
    else if (text) this.binding.orphanDraft = text;
    else delete this.binding.orphanDraft;
  }

  #updateComposer(): void {
    const cold = !this.binding.runtimeId && Boolean(this.binding.sessionFile || this.binding.cwd);
    this.#composer.hidden = !cold;
    this.#draftInput.placeholder = this.binding.sessionFile
      ? "Write a message. Submit to load this saved session."
      : "Write a message. Submit to start this session.";
    this.#draftInput.disabled = this.#submitting;
    this.#submitButton.disabled = this.#submitting || !this.#draftInput.value.trim();
  }

  #sendOrStageInput(data: string, files?: readonly FileReference[]): boolean {
    if (this.binding.runtimeId) return this.#sendInput(data);
    if (!this.binding.sessionFile && !this.binding.cwd) {
      const cwd = sidebarActiveWorkspace() ?? defaultCwd;
      if (!cwd) return false;
      const next = { ...this.binding, cwd };
      delete next.keepEmpty;
      this.bind(next);
    }
    if ((!this.binding.sessionFile && !this.binding.cwd) || this.#submitting) return false;
    const value = this.#draftInput.value;
    const focused = document.activeElement === this.#draftInput;
    const start = focused ? this.#draftInput.selectionStart : value.length;
    const end = focused ? this.#draftInput.selectionEnd : value.length;
    const before = value.slice(0, start);
    const separator = before && !/\s$/.test(before) && !/^\s/.test(data) ? " " : "";
    this.#draftInput.setRangeText(`${separator}${data}`, start, end, "end");
    if (files?.length) {
      const identity = this.#draftIdentity(this.binding.sessionFile);
      if (identity) {
        const byDraft = this.binding.draftFiles ?? (this.binding.draftFiles = {});
        const refs = byDraft[identity] ?? (byDraft[identity] = []);
        for (const file of files) refs.push(file);
      }
    }
    this.#draftInput.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  #sendInput(data: string): boolean {
    const socket = this.ws;
    if (socket?.readyState !== WebSocket.OPEN || !this.binding.runtimeId) return false;
    try {
      for (const chunk of splitInputChunks(data)) {
        const id = `i${++this.#inputSequence}`;
        this.#pendingInputs.set(id, { data: chunk, sessionFile: this.binding.sessionFile });
        socket.send(JSON.stringify({ type: "input", id, data: chunk }));
      }
      return true;
    } catch {
      return false;
    }
  }

  #preservePendingInput(sessionFile: string | null): void {
    if (!sessionFile) return;
    const chunks: string[] = [];
    for (const [id, input] of this.#pendingInputs) {
      if (input.sessionFile !== sessionFile) continue;
      chunks.push(input.data);
      this.#pendingInputs.delete(id);
    }
    const recovered = draftableTerminalInput(chunks.join(""));
    if (!recovered) return;
    this.#storeDraft(sessionFile, `${this.#draftFor(sessionFile)}${recovered}`);
    this.#draftInput.value = this.#draftFor(sessionFile);
    save();
  }

  #preservePendingInputs(): void {
    const sessionFiles = new Set(
      [...this.#pendingInputs.values()]
        .map((input) => input.sessionFile)
        .filter((path): path is string => path !== null),
    );
    for (const sessionFile of sessionFiles) this.#preservePendingInput(sessionFile);
    const unknown: string[] = [];
    for (const [id, input] of this.#pendingInputs) {
      if (input.sessionFile !== null) continue;
      unknown.push(input.data);
      this.#pendingInputs.delete(id);
    }
    const recovered = draftableTerminalInput(unknown.join(""));
    if (recovered) {
      const identity = this.#draftIdentity(this.binding.sessionFile);
      if (identity) this.#storeDraft(identity, `${this.#draftFor(this.binding.sessionFile)}${recovered}`);
      else this.binding.orphanDraft = `${this.binding.orphanDraft ?? ""}${recovered}`;
      save();
    }
  }

  /** Keep close-raced terminal input visible in the surviving pane, never resend it. */
  preservePendingForClose(): void {
    const recovered = draftableTerminalInput(
      [...this.#pendingInputs.values()].map((input) => input.data).join(""),
    );
    this.#pendingInputs.clear();
    if (recovered) this.binding.orphanDraft = `${this.binding.orphanDraft ?? ""}${recovered}`;
  }

  #associateUnknownInputs(sessionFile: string): void {
    for (const input of this.#pendingInputs.values()) {
      if (!input.sessionFile) input.sessionFile = sessionFile;
    }
  }

  async #submitColdDraft(): Promise<void> {
    const path = this.binding.sessionFile;
    const cwd = path ? sessionSummary(path)?.cwd ?? this.binding.cwd : this.binding.cwd;
    const text = this.#draftInput.value;
    if ((!path && !cwd) || this.binding.runtimeId || this.#submitting || !text.trim()) return;
    const binding = this.binding;
    const generation = daemonId;
    const identity = this.#draftIdentity(path, cwd);
    if (!identity) return;
    const paths = new Set<string>();
    for (const file of this.binding.draftFiles?.[identity] ?? []) {
      if (text.includes(file.text)) paths.add(file.path);
    }
    const submission = { text };
    const isCurrent = () =>
      panes.get(this.id) === this && this.#draftIdentity(this.binding.sessionFile) === identity &&
      !this.binding.runtimeId && daemonId === generation;
    this.#submissions.set(identity, submission);
    if (this.#historyLoading) this.#cancelColdHistory();
    this.#composerStatus.textContent = "Sending request…";
    this.#updateComposer();
    try {
      const res = await fetch("/api/sessions/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(path ? { path } : {}),
          ...(cwd ? { cwd } : {}),
          text,
          ...(paths.size ? { files: [...paths] } : {}),
          cols: this.term.cols,
          rows: this.term.rows,
        }),
      });
      if (!res.ok) {
        const message = (await res.text().catch(() => "")).trim() ||
          `The session request failed (HTTP ${res.status}).`;
        if (isCurrent()) this.#composerStatus.textContent = message;
        return;
      }
      const runtime = parseRuntimeOne(await res.json().catch(() => null));
      if (!runtime) {
        if (isCurrent()) this.#composerStatus.textContent = "The daemon returned an invalid session response.";
        return;
      }
      if (path && runtime.sessionFile && runtime.sessionFile !== path) {
        if (isCurrent()) this.#composerStatus.textContent = "The daemon attached a different saved session.";
        return;
      }
      if (this.binding.drafts?.[identity] === text) this.#storeDraft(identity, "");
      const current = isCurrent();
      if (current && this.#draftInput.value === text) this.#draftInput.value = "";
      save();
      if (daemonId === generation) {
        runtimes = [...runtimes.filter((candidate) => candidate.id !== runtime.id), runtime];
        renderSidebar();
      }
      if (!current) return;
      if (path) runtime.sessionFile = path;
      this.#composerStatus.textContent = "";
      const next = bindingForRuntime(runtime, binding.title ?? displayTitle(runtime));
      next.cwd = runtime.cwd || cwd;
      next.drafts = this.binding.drafts;
      this.bind(next);
    } catch {
      if (isCurrent()) this.#composerStatus.textContent = "The daemon could not be reached; your draft is still here.";
    } finally {
      if (this.#submissions.get(identity) === submission) this.#submissions.delete(identity);
      this.#updateComposer();
      if (isCurrent() && !this.binding.runtimeId) this.renderPlaceholder();
    }
  }

  #ensureColdHistory(): void {
    const sessionFile = this.binding.sessionFile;
    if (!sessionFile || this.binding.runtimeId || !this.visible || this.#submitting) return;
    const cols = Math.max(1, this.term.cols);
    const rows = Math.max(1, this.term.rows);
    const key = `${daemonId ?? ""}\u0000${sessionFile}\u0000${cols}x${rows}`;
    if (this.#historyKey === key) return;
    this.#historyController?.abort();
    const controller = new AbortController();
    this.#historyController = controller;
    this.#historyKey = key;
    this.#historyReady = false;
    this.#historyError = null;
    this.#historyLoading = true;
    this.#replaying = true;
    this.term.reset();
    // Piped renderer output has LF endings, without a PTY's CR translation.
    this.term.options.convertEol = true;
    this.#placeholderKey = "";
    this.renderPlaceholder();
    const query = new URLSearchParams({ path: sessionFile, cols: String(cols), rows: String(rows) });
    void this.#readColdHistory(sessionFile, key, controller, query);
  }

  async #readColdHistory(
    sessionFile: string,
    key: string,
    controller: AbortController,
    query: URLSearchParams,
  ): Promise<void> {
    const current = () =>
      this.#historyController === controller &&
      this.#historyKey === key &&
      this.binding.sessionFile === sessionFile &&
      this.binding.runtimeId === null &&
      panes.get(this.id) === this;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await fetch(`/api/sessions/history?${query}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Saved history is unavailable (HTTP ${response.status}).`);
      if (!response.body) throw new Error("The daemon returned no saved history.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!current()) return;
        const output = decoder.decode(value, { stream: true });
        if (output) {
          const parsed = Promise.withResolvers<void>();
          this.term.write(output, parsed.resolve);
          await parsed.promise;
        }
      }
      const finalOutput = decoder.decode();
      if (finalOutput) {
        const parsed = Promise.withResolvers<void>();
        this.term.write(finalOutput, parsed.resolve);
        await parsed.promise;
      }
      if (!current()) return;
      this.#historyLoading = false;
      this.#historyReady = true;
      this.#historyError = null;
      this.#replaying = false;
      this.#fitGrid();
      this.term.scrollToBottom();
      this.#placeholderKey = "";
      this.renderPlaceholder();
      this.#ensureColdHistory();
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      this.term.reset();
      this.#historyLoading = false;
      this.#historyReady = false;
      this.#historyError = error instanceof Error ? error.message : "Saved history is unavailable.";
      this.#replaying = false;
      this.#placeholderKey = "";
      this.renderPlaceholder();
    } finally {
      await reader?.cancel().catch(() => undefined);
      if (this.#historyController === controller && controller.signal.aborted) {
        this.#historyLoading = false;
        this.#replaying = false;
      }
    }
  }

  #cancelColdHistory(): void {
    this.#historyController?.abort();
    this.#historyController = null;
    this.#historyKey = "";
    this.#historyReady = false;
    this.#historyError = null;
    this.#historyLoading = false;
    this.#replaying = false;
  }

  #retryColdHistory(): void {
    this.#historyKey = "";
    this.#ensureColdHistory();
  }

  #syncJumpLatest(): void {
    const buffer = this.term.buffer.active;
    const hidden = (!this.binding.runtimeId && !this.binding.sessionFile) ||
      buffer.type !== "normal" || buffer.baseY - buffer.viewportY < this.term.rows;
    if (this.#jumpLatest.hidden !== hidden) this.#jumpLatest.hidden = hidden;
  }

  get visible(): boolean {
    return this.#body.offsetWidth > 0 && this.#body.offsetHeight > 0;
  }

  async #copySelection(text: string): Promise<void> {
    const revision = this.#selectionRevision;
    try {
      await navigator.clipboard.writeText(text);
      // A slower permission prompt must not clear a newer drag selection.
      if (revision === this.#selectionRevision) this.term.clearSelection();
    } catch {
      setStatus("Clipboard access blocked — use Ctrl+Shift+C to copy", "warn");
    }
  }

  /** Clipboard images: the browser holds the bytes, omp reads text, so the daemon
   *  stores the file and the pane types its path — what image-paste terminals do. */
  async #handlePaste(event: ClipboardEvent): Promise<void> {
    const item = Array.from(event.clipboardData?.items ?? []).find(
      (entry) => entry.kind === "file" && entry.type.startsWith("image/"),
    );
    let file: Blob | null = item?.getAsFile() ?? null;
    // WebKitGTK can deliver an empty image paste event even though its async
    // Clipboard API has image/png. Ordinary text stays on xterm's paste path.
    const readNativeClipboard = !file && event.clipboardData?.types.length === 0 &&
      isNativeShell() && typeof navigator.clipboard?.read === "function";
    if (!file && !readNativeClipboard) return;
    event.preventDefault();
    event.stopPropagation();
    if (!file) {
      setStatus("reading clipboard image…", "idle");
      try {
        const items = await navigator.clipboard.read();
        for (const entry of items) {
          const type = entry.types.find((type) => type.startsWith("image/"));
          if (type) {
            file = await entry.getType(type);
            break;
          }
        }
        if (!file) {
          const text = items.find((entry) => entry.types.includes("text/plain"));
          if (text) this.term.paste(await (await text.getType("text/plain")).text());
          setStatus(text ? "text pasted" : "clipboard has no image or text", text ? "ok" : "warn");
          return;
        }
      } catch {
        setStatus("clipboard image access failed — try copying the image again", "warn");
        return;
      }
    }
    setStatus("uploading image…", "idle");
    const path = await uploadPaste(file);
    if (!path) {
      setStatus("image paste failed", "warn");
      return;
    }
    if (!this.#sendOrStageInput(`${path} `, [{ path, text: path }])) {
      setStatus("image saved, but could not add its path to this pane", "warn");
      return;
    }
    if (this.binding.runtimeId) {
      setStatus("image path typed", "ok");
      this.term.focus();
    } else {
      setStatus("image path added to the draft", "ok");
      this.#draftInput.focus();
    }
  }

  #wireDrop(): void {
    this.el.addEventListener("dragover", (event) => {
      event.preventDefault();
      this.el.classList.add("drop");
    });
    this.el.addEventListener("dragleave", () => this.el.classList.remove("drop"));
    this.el.addEventListener("drop", (event) => {
      event.preventDefault();
      this.el.classList.remove("drop");
    });
  }

  focus(terminal = false): void {
    const owner = spaceForPane(this.id);
    if (owner && owner.id !== activeSpaceId) switchSpace(owner.id);
    const acknowledged = acknowledgeCompletion(this.binding.runtimeId);
    if (layout.focused !== this.id || acknowledged) {
      layout.focused = this.id;
      renderSidebar();
      save();
    }
    if (expandedPaneId && expandedPaneId !== this.id) {
      expandedPaneId = this.id;
      renderLayout(true);
    }
    if (!terminal && !this.binding.runtimeId && (this.binding.sessionFile || this.binding.cwd)) {
      this.#draftInput.focus();
    } else {
      this.term.focus();
    }
  }

  #scheduleFit(): void {
    window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => this.fitPane(), 80);
  }

  /** Fit only when laid out: fitting a display:none pane computes garbage sizes. */
  fitPane(): void {
    if (!this.visible || this.#replaying) return;
    this.#fitGrid();
    this.sendResize();
    if (!this.binding.runtimeId && this.binding.sessionFile) this.#ensureColdHistory();
  }

  /** Marks a pane tree move that may discard the renderer's pixels. */
  markNeedsRepaint(): void {
    this.#needsRepaint = true;
  }

  /** Refit after attachment; repaint only when the pane tree was moved. */
  refreshAfterAttach(): void {
    if (!this.visible || this.#replaying) return;
    this.#fitGrid();
    // Another view of this runtime may have changed the PTY's geometry while
    // this space was hidden. Reassert it even if our own grid did not change.
    this.sendResize(true);
    if (!this.binding.runtimeId && this.binding.sessionFile) this.#ensureColdHistory();
    if (this.#needsRepaint) {
      // The DOM/GPU renderer can lose its pixels when the pane tree is moved,
      // but a live replay on an attached pane already paints its own writes.
      this.term.refresh(0, this.term.rows - 1);
      this.#needsRepaint = false;
    }
  }

  /** Fit whole cells without changing text geometry to fill leftover space. */
  #fitGrid(): void {
    const host = this.#host;
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (!viewport || !host.clientWidth || !host.clientHeight) return;
    if (this.term.options.fontSize !== cellSize) this.term.options.fontSize = cellSize;
    if (this.term.options.lineHeight !== CELL_LINE_HEIGHT) this.term.options.lineHeight = CELL_LINE_HEIGHT;
    const metrics = xtermMetrics(this.term) ?? drawnMetrics(this.term);
    if (!metrics) return;
    const frame = host.getBoundingClientRect();
    const reserve = Math.max(0, viewport.getBoundingClientRect().width - viewport.clientWidth);
    const cols = Math.max(1, Math.floor((frame.width - reserve) / metrics.cellW));
    const rows = Math.max(1, Math.floor(frame.height / metrics.cellH));
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  sendResize(force = false): void {
    if (this.#replaying || this.ws?.readyState !== WebSocket.OPEN) return;
    const size = `${this.term.cols}x${this.term.rows}`;
    if (!force && size === this.#lastSent) return;
    this.#lastSent = size;
    this.ws.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
  }

  bind(binding: PaneBinding, mergePreviousRecovery = true): void {
    this.#finishTitleEdit(false);
    const previous = this.binding;
    const identityChanged = previous.sessionFile !== binding.sessionFile ||
      (!binding.sessionFile && previous.cwd !== binding.cwd);
    const runtimeChanged = previous.runtimeId !== binding.runtimeId;
    if (runtimeChanged && previous.runtimeId) this.#preservePendingInputs();
    if (mergePreviousRecovery) binding = rebindPaneBinding(previous, binding);
    if (runtimeChanged || !binding.runtimeId) this.detach();
    if (identityChanged || (binding.runtimeId && !previous.runtimeId)) this.#cancelColdHistory();
    this.binding = binding;
    if (identityChanged || runtimeChanged) this.#draftInput.value = this.#draftFor(binding.sessionFile);
    this.#composerStatus.textContent = "";
    acknowledgeCompletion(binding.runtimeId);
    if (!binding.runtimeId && !binding.sessionFile) this.term.reset();
    this.renderPlaceholder();
    if (binding.runtimeId && !this.ws) this.attach();
    this.renderHeader();
    save();
    renderSidebar();
  }

  #finishStartup(): void {
    const wasStarting = !this.#starting.hidden;
    window.clearTimeout(this.#startupTimer);
    this.#startupTimer = undefined;
    this.#startupFrame = false;
    this.#starting.hidden = true;
    this.#body.removeAttribute("aria-busy");
    this.#host.inert = false;
    if (wasStarting && this.ws?.readyState === WebSocket.OPEN && layout.focused === this.id && this.visible) {
      this.term.focus();
    }
  }

  detach(): void {
    this.retry = Number.POSITIVE_INFINITY;
    const socket = this.ws;
    this.ws = null;
    this.#replaying = false;
    this.#finishStartup();
    socket?.close();
  }

  attach(): void {
    const runtimeId = this.binding.runtimeId;
    if (!runtimeId) return;
    // A pane owns one stream. Rebinding must stop its previous subscription
    // before replacing the socket that detach() knows how to close.
    this.detach();
    this.term.options.convertEol = false;
    const runtime = runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      this.runtimeGone();
      return;
    }
    this.retry = 0;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/term?runtime=${encodeURIComponent(runtimeId)}`);
    socket.binaryType = "arraybuffer";
    this.ws = socket;
    this.#replaying = true;
    this.#starting.hidden = false;
    this.#body.setAttribute("aria-busy", "true");
    this.#host.inert = true;
    // Failed/non-OMP startups must not leave diagnostic output covered forever.
    this.#startupTimer = window.setTimeout(() => this.#finishStartup(), 10_000);
    let starting = true;
    let replayBytes = 0;
    const finishReplay = () => {
      if (this.ws !== socket) return;
      this.#replaying = false;
      this.refreshAfterAttach();
      if (!starting || this.#startupFrame) this.#finishStartup();
    };
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.term.reset();
      if (runtime.sessionFile) {
        this.binding.sessionFile = runtime.sessionFile;
        this.#associateUnknownInputs(runtime.sessionFile);
      }
      if (layout.focused === this.id && this.visible) this.term.focus();
      save();
    };
    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      if (typeof event.data === "string") {
        const message = parseServerMessage(event.data);
        if (message?.type === "hello") {
          const startedAt = message.runtime.startedAt;
          // Established sessions need only finish replay; newly started ones
          // may still be negotiating the terminal fallback behind the cover.
          starting = !startedAt || Date.now() - Date.parse(startedAt) < 3000;
          // TUI replay contains absolute cursor moves and may disable wrapping.
          // Parse it at the producer's size before fitting the restored pane.
          if (this.term.cols !== message.runtime.cols || this.term.rows !== message.runtime.rows) {
            this.term.resize(message.runtime.cols, message.runtime.rows);
          }
          replayBytes = message.replayBytes;
          if (replayBytes === 0) finishReplay();
        }
        this.#handleControl(message);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (this.#replaying) {
          replayBytes -= bytes.byteLength;
          this.term.write(bytes, replayBytes <= 0 ? finishReplay : undefined);
        } else {
          this.term.write(bytes);
        }
      }
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.#finishStartup();
      this.ws = null;
      if (this.retry < 5) {
        this.retry += 1;
        window.setTimeout(() => {
          if (this.binding.runtimeId === runtimeId && !this.ws) this.attach();
        }, 1000 * this.retry);
      } else {
        this.runtimeGone();
      }
    };
  }

  #handleControl(msg: ServerMessage | null): void {
    if (!msg) return;
    if (msg.type === "inputAck") {
      this.#pendingInputs.delete(msg.id);
      return;
    }
    if (msg.type === "hello") {
      this.binding.title = displayTitle(msg.runtime);
      if (msg.runtime.sessionFile) {
        this.binding.sessionFile = msg.runtime.sessionFile;
        this.#associateUnknownInputs(msg.runtime.sessionFile);
      }
      this.renderHeader();
      renderSidebar();
      save();
    } else if (msg.type === "exit") {
      this.#finishStartup();
      this.runtimeGone();
    }
  }

  runtimeGone(): void {
    this.#preservePendingInputs();
    this.detach();
    this.binding.runtimeId = null;
    this.#stateEl.textContent = this.binding.sessionFile ? "saved" : "exited";
    this.#draftInput.value = this.#draftFor(this.binding.sessionFile);
    this.renderHeader();
    this.renderPlaceholder();
    save();
  }

  syncFromRuntimes(): void {
    if (this.#submitting && !this.binding.runtimeId) return;
    if (!daemonUp) {
      this.renderPlaceholder();
      return;
    }
    const current = this.binding.runtimeId
      ? runtimes.find((candidate) => candidate.id === this.binding.runtimeId) ?? null
      : null;
    const runtime = current && attachable(current)
      ? current
      : runtimeForSession(this.binding.sessionFile, runtimes);
    if (!runtime) {
      if (this.binding.runtimeId) this.runtimeGone();
      else this.renderPlaceholder();
      return;
    }
    if (runtime.id !== this.binding.runtimeId) {
      this.bind(bindingForRuntime(runtime, displayTitle(runtime)));
      return;
    }
    const title = displayTitle(runtime);
    const sessionFile = runtime.sessionFile ?? this.binding.sessionFile;
    if (title !== this.binding.title || sessionFile !== this.binding.sessionFile || runtime.cwd !== this.binding.cwd) {
      const next = bindingForRuntime(runtime, title);
      next.sessionFile = sessionFile;
      next.drafts = this.binding.drafts;
      this.bind(next);
    }
    if (!this.ws && this.retry !== Number.POSITIVE_INFINITY) this.attach();
    this.renderPlaceholder();
  }
  #beginTitleEdit(): void {
    if (this.#editingTitle || !this.binding.sessionFile) return;
    this.#editingTitle = {
      path: this.binding.sessionFile,
      original: this.#titleEl.value,
    };
    this.#titleEl.readOnly = false;
    this.#titleActions.hidden = false;
    this.#titleEl.focus();
  }

  #finishTitleEdit(commit: boolean): void {
    const editing = this.#editingTitle;
    if (!editing) return;
    const title = this.#titleEl.value.trim();
    this.#editingTitle = null;
    this.#titleEl.readOnly = true;
    this.#titleActions.hidden = true;
    this.renderHeader();
    if (commit && title && title !== editing.original) {
      void saveSessionTitle(editing.path, title);
    }
  }



  renderHeader(): void {
    const sessionFile = this.binding.sessionFile ?? "";
    const session = sessionFile ? sessionSummary(sessionFile) ?? null : null;
    const title = this.binding.title ?? (this.binding.cwd ? "New session" : "no session");
    syncPinButton(this.#pin, session);
    if (!this.#editingTitle && this.#titleEl.value !== title) this.#titleEl.value = title;
    this.#titleEl.style.width = `${Math.max(2, this.#titleEl.value.length + 2)}ch`;
    this.#titleEl.disabled = !sessionFile;
    this.#titleEl.title = sessionFile ? "Click to edit title · Enter to save · Click away to cancel" : "Waiting for session file";
    if (this.binding.runtimeId && this.#stateEl.textContent !== "") this.#stateEl.textContent = "";
  }

  renderPlaceholder(): void {
    const orphanDraft = this.binding.orphanDraft ?? "";
    this.#orphanReview.hidden = !orphanDraft;
    this.#orphanText.textContent = orphanDraft;
    const bound = Boolean(this.binding.runtimeId);
    const sessionFile = this.binding.sessionFile;
    const coldSaved = !bound && Boolean(sessionFile);
    const coldNew = !bound && !sessionFile && Boolean(this.binding.cwd);
    const cold = coldSaved || coldNew;
    const hostDisplay = bound || cold ? "" : "none";
    if (this.#host.style.display !== hostDisplay) this.#host.style.display = hostDisplay;
    this.#updateComposer();
    if (coldSaved) {
      if (this.visible && !this.#replaying) this.#fitGrid();
      this.#ensureColdHistory();
    }
    const historyReady = coldSaved && this.#historyReady;
    const placeholderDisplay = bound || coldNew || historyReady ? "none" : "flex";
    if (this.#placeholder.style.display !== placeholderDisplay) this.#placeholder.style.display = placeholderDisplay;
    this.#placeholder.classList.toggle("pane-placeholder-cold", coldSaved && !historyReady);
    this.#syncJumpLatest();
    if (bound) {
      this.#placeholderKey = "bound";
      return;
    }
    if (coldNew) {
      this.#placeholderKey = "new-session";
      this.#stateEl.textContent = "draft";
      return;
    }
    if (historyReady) {
      this.#placeholderKey = "history-ready";
      this.#stateEl.textContent = "saved";
      return;
    }
    const title = this.binding.title;
    const key = JSON.stringify([
      title,
      this.binding.orphanDraft ?? "",
      this.#historyLoading,
      this.#historyError,
      sessionFile,
    ]);
    if (this.#placeholderKey === key) return;
    this.#placeholderKey = key;
    this.#placeholder.replaceChildren();
    const text = document.createElement("div");
    text.textContent = coldSaved
      ? this.#historyError ?? "Loading saved history…"
      : title
        ? `${title} — not running`
        : this.binding.orphanDraft
          ? "Unconfirmed terminal input was retained, but this runtime has no saved transcript."
          : "empty pane — choose a session from the sidebar or start one";
    this.#placeholder.append(text);
    if (this.#historyError && coldSaved) {
      const retry = document.createElement("button");
      retry.textContent = "retry history read";
      retry.addEventListener("click", () => this.#retryColdHistory());
      this.#placeholder.append(retry);
    }
    if (!coldSaved) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";
      const start = document.createElement("button");
      start.textContent = "new session here";
      start.addEventListener("click", () => newSession(this));
      row.append(start);
      this.#placeholder.append(row);
    }
  }

  destroy(): void {
    this.#selectionEvents.abort();
    this.#observer.disconnect();
    this.#disposeFileDrop?.();
    this.#disposeFileDrop = null;
    window.clearTimeout(this.#resizeTimer);
    window.clearTimeout(this.#draftSaveTimer);
    this.#cancelColdHistory();
    this.detach();
    this.term.dispose();
    this.el.remove();
  }
}

const paneMenu = document.createElement("div");
paneMenu.className = "pane-menu";
paneMenu.setAttribute("role", "menu");
paneMenu.setAttribute("aria-label", "Pane layout");
paneMenu.hidden = true;
paneMenu.tabIndex = -1;
const splitMenuItem = document.createElement("button");
splitMenuItem.setAttribute("role", "menuitem");
paneMenu.append(splitMenuItem);
document.body.append(paneMenu);

function closePaneMenu(restoreFocus = false): void {
  if (paneMenu.hidden) return;
  paneMenu.hidden = true;
  if (restoreFocus) focusedPane()?.focus();
}

splitMenuItem.addEventListener("click", () => {
  closePaneMenu();
  splitLayout();
  focusedPane()?.focus();
});
splitLayoutEl.addEventListener("click", () => {
  splitLayout();
  focusedPane()?.focus();
});
panesEl.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".pane") : null;
  const pane = target?.dataset.pane ? panes.get(target.dataset.pane) : null;
  if (!target || !pane) return;
  event.preventDefault();
  pane.focus();
  const count = leaves().length;
  splitMenuItem.textContent = "Split";
  splitMenuItem.disabled = count >= MAX_PANES;
  paneMenu.hidden = false;
  const rect = paneMenu.getBoundingClientRect();
  const anchor = target.getBoundingClientRect();
  const x = event.clientX || anchor.left;
  const y = event.clientY || anchor.top;
  paneMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
  paneMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
  (splitMenuItem.disabled ? paneMenu : splitMenuItem).focus();
});
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !paneMenu.contains(event.target)) closePaneMenu();
}, true);
paneMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    closePaneMenu(true);
  }
});
window.addEventListener("blur", () => closePaneMenu());
window.addEventListener("resize", () => closePaneMenu());

// ---------------------------------------------------------------- layout tree

function leaves(node: LayoutNode = layout.tree, out: string[] = []): string[] {
  if (node.kind === "leaf") out.push(node.pane);
  else {
    leaves(node.a, out);
    leaves(node.b, out);
  }
  return out;
}

/** `restoredId` keeps a stored layout's tree and pane map agreeing; collisions fall back to a fresh id. */
function newPane(binding: PaneBinding, restoredId?: string): Pane {
  let id = restoredId ?? `p${++paneSeq}`;
  while (panes.has(id)) id = `p${++paneSeq}`;
  const pane = new Pane(id, binding);
  panes.set(id, pane);
  layout.panes[id] = binding;
  return pane;
}

/** Preserve valid grid ratios; migrate arbitrary old trees without losing bindings. */
function gridLayout(tree: LayoutNode): LayoutNode {
  const all = leaves(tree);
  const ids = [...new Set(all)].slice(0, MAX_PANES);
  const columnValid = (node: LayoutNode): boolean =>
    node.kind === "leaf" || (node.dir === "col" && node.a.kind === "leaf" && node.b.kind === "leaf");
  if (ids.length === all.length &&
      (tree.kind === "leaf" || (tree.dir === "row" && columnValid(tree.a) && columnValid(tree.b)))) return tree;
  const leaf = (id: string): LayoutNode => ({ kind: "leaf", pane: id });
  const column = (entries: string[]): LayoutNode => entries.length === 1
    ? leaf(entries[0])
    : { kind: "split", dir: "col", ratio: 0.5, a: leaf(entries[0]), b: leaf(entries[1]) };
  if (ids.length === 1) return leaf(ids[0]);
  const middle = Math.ceil(ids.length / 2);
  return { kind: "split", dir: "row", ratio: 0.5, a: column(ids.slice(0, middle)), b: column(ids.slice(middle)) };
}

function splitLayout(): void {
  const tree = layout.tree;
  if (leaves(tree).length >= MAX_PANES) return;
  const freshPanes: Pane[] = [];
  const split = (node: LayoutNode, dir: "row" | "col"): LayoutNode => {
    if (node.kind !== "leaf") return node;
    const fresh = newPane(emptyBinding());
    freshPanes.push(fresh);
    layout.focused = fresh.id;
    return { kind: "split", dir, ratio: 0.5, a: node, b: { kind: "leaf", pane: fresh.id } };
  };
  layout.tree = tree.kind === "leaf"
    ? split(tree, "row")
    : { ...tree, a: split(tree.a, "col"), b: split(tree.b, "col") };
  renderLayout();
  save();
  for (const pane of freshPanes) void newSession(pane, false);
}

function closePane(paneId: string): void {
  const pane = panes.get(paneId);
  if (!pane) return;
  const ids = leaves();
  // Closing a view never kills its runtime. In a four-pane grid, keep the
  // first closed quadrant in place; the second close removes both slots.
  const alreadyClosed = ids.find((id) => panes.get(id)?.binding.keepEmpty);
  if (ids.length === 4 && pane.binding.keepEmpty) return;
  if (ids.length <= 1 || (ids.length === 4 && !alreadyClosed)) {
    pane.bind({ ...emptyBinding(), keepEmpty: true });
    if (expandedPaneId) renderLayout();
    return;
  }
  const removed = ids.length === 4 && alreadyClosed ? [alreadyClosed, paneId] : [paneId];
  const survivorId = ids.find((id) => !removed.includes(id));
  const survivor = survivorId ? panes.get(survivorId) : null;
  if (survivor) {
    for (const id of removed) {
      const closing = panes.get(id);
      if (!closing) continue;
      closing.preservePendingForClose();
      survivor.bind(rebindPaneBinding(closing.binding, survivor.binding));
    }
  }
  for (const id of removed) {
    const remaining = removeLeaf(layout.tree, id);
    if (!remaining) return;
    layout.tree = remaining.tree;
    panes.get(id)?.destroy();
    panes.delete(id);
    delete layout.panes[id];
  }
  layout.tree = gridLayout(layout.tree);
  if (layout.focused && removed.includes(layout.focused)) layout.focused = leaves()[0] ?? null;
  renderLayout();
  save();
}

function removeLeaf(node: LayoutNode, paneId: string): { tree: LayoutNode } | null {
  if (node.kind === "leaf") return node.pane === paneId ? null : { tree: node };
  if (node.a.kind === "leaf" && node.a.pane === paneId) return { tree: node.b };
  if (node.b.kind === "leaf" && node.b.pane === paneId) return { tree: node.a };
  const left = removeLeaf(node.a, paneId);
  if (left === null) return { tree: node.b };
  const right = removeLeaf(node.b, paneId);
  if (right === null) return { tree: left.tree };
  return { tree: { ...node, a: left.tree, b: right.tree } };
}

function spaceForPane(paneId: string): SpaceLayout | null {
  for (const [id, stored] of spaces) {
    if (leaves(stored.tree).includes(paneId)) return { id, layout: stored };
  }
  return null;
}

function replacePaneId(node: LayoutNode, from: string, to: string): LayoutNode {
  if (node.kind === "leaf") return node.pane === from ? { ...node, pane: to } : node;
  return {
    ...node,
    a: replacePaneId(node.a, from, to),
    b: replacePaneId(node.b, from, to),
  };
}

/** Keep tab reordering in-page, like session dragging, for WebKitGTK. */
function wireSpaceReorder(): void {
  let origin: { id: string; x: number; pointer: number; tab: HTMLElement } | null = null;
  let moved = false;
  let destination: { group: HTMLElement; id: string; after: boolean } | null = null;
  let suppressClick = false;
  const clearDestination = (): void => {
    destination?.group.classList.remove("space-insert-before", "space-insert-after");
    destination = null;
  };
  spaceTabsEl.addEventListener("pointerdown", (event) => {
    const tab = (event.target as Element).closest<HTMLElement>(".space-tab");
    if (!tab?.dataset.space || origin || dragging || !event.isPrimary || event.button !== 0) return;
    origin = { id: tab.dataset.space, x: event.clientX, pointer: event.pointerId, tab };
    moved = false;
    suppressClick = false;
    tab.setPointerCapture(event.pointerId);
  });
  spaceTabsEl.addEventListener("pointermove", (event) => {
    if (!origin || event.pointerId !== origin.pointer) return;
    if (!moved && Math.abs(event.clientX - origin.x) < 8) return;
    moved = true;
    dragging = true;
    origin.tab.classList.add("space-reorder-source");
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    clearDestination();
    const group = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".space-tab-group");
    const id = group?.querySelector<HTMLElement>(".space-tab")?.dataset.space;
    if (!group || !spaceTabsEl.contains(group) || !id || id === origin.id) return;
    const rect = group.getBoundingClientRect();
    const after = event.clientX >= rect.left + rect.width / 2;
    destination = { group, id, after };
    group.classList.add(after ? "space-insert-after" : "space-insert-before");
  });
  const finish = (event: PointerEvent): void => {
    if (!origin || event.pointerId !== origin.pointer) return;
    const source = origin;
    const target = destination;
    const shouldDrop = moved && event.type === "pointerup" && target;
    suppressClick = moved;
    origin = null;
    source.tab.classList.remove("space-reorder-source");
    clearDestination();
    if (source.tab.hasPointerCapture(event.pointerId)) source.tab.releasePointerCapture(event.pointerId);
    if (shouldDrop && spaces.has(source.id) && spaces.has(target.id)) {
      const entries = [...spaces].filter(([id]) => id !== source.id);
      const index = entries.findIndex(([id]) => id === target.id) + Number(target.after);
      entries.splice(index, 0, [source.id, spaces.get(source.id)!]);
      spaces.clear();
      for (const [id, stored] of entries) spaces.set(id, stored);
      renderSpaceTabs();
      save();
    }
    dragging = false;
    if (renderPending) renderSidebar();
  };
  spaceTabsEl.addEventListener("pointerup", finish);
  spaceTabsEl.addEventListener("pointercancel", finish);
  spaceTabsEl.addEventListener("lostpointercapture", finish);
  spaceTabsEl.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

wireSpaceReorder();

function renderSpaceTabs(): void {
  spaceTabsEl.replaceChildren();
  let index = 0;
  for (const id of spaces.keys()) {
    const group = document.createElement("div");
    group.className = "space-tab-group";
    const tab = document.createElement("button");
    tab.className = "space-tab";
    tab.dataset.space = id;
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.textContent = `Space ${++index}`;
    tab.setAttribute("aria-selected", String(id === activeSpaceId));
    tab.tabIndex = id === activeSpaceId ? 0 : -1;
    tab.title = "Drag to reorder spaces";
    tab.addEventListener("click", () => switchSpace(id));
    const close = document.createElement("button");
    close.className = "space-close";
    close.type = "button";
    close.textContent = "×";
    close.title = `Close Space ${index} (sessions keep running)`;
    close.setAttribute("aria-label", `Close Space ${index}`);
    close.addEventListener("click", () => closeSpace(id));
    group.append(tab, close);
    spaceTabsEl.append(group);
  }
}

function closeSpace(id: string): void {
  const stored = spaces.get(id);
  if (!stored) return;
  const order = [...spaces.keys()];
  const index = order.indexOf(id);
  const closingPanes = leaves(stored.tree).map((paneId) => panes.get(paneId)).filter((pane): pane is Pane => pane !== undefined);
  closePaneMenu();

  const closingLastSpace = spaces.size === 1;
  let recoveryTarget: Pane | null = null;
  for (const pane of closingPanes) pane.preservePendingForClose();
  if (closingLastSpace) {
    // Capture ACK-raced bytes before createSpace saves any workspace snapshot.
    createSpace();
    recoveryTarget = focusedPane();
    if (recoveryTarget) {
      recoveryTarget.binding.keepEmpty = true;
      const coldDraftSource = closingPanes.find((pane) => {
        const binding = pane.binding;
        if (binding.runtimeId) return false;
        const identity = binding.sessionFile ?? (binding.cwd ? `new:${binding.cwd}` : null);
        if (!identity) return false;
        return Boolean(binding.drafts?.[identity] || binding.draftFiles?.[identity]?.length);
      });
      if (coldDraftSource) {
        recoveryTarget.binding.cwd = coldDraftSource.binding.cwd;
        recoveryTarget.binding.sessionFile = coldDraftSource.binding.sessionFile;
        recoveryTarget.binding.title = coldDraftSource.binding.title;
      }
    }
  } else {
    const destinationId = activeSpaceId === id
      ? order.filter((spaceId) => spaceId !== id)[Math.min(index, spaces.size - 2)]
      : activeSpaceId;
    const destination = destinationId ? spaces.get(destinationId) : undefined;
    const targetPaneId = destination?.focused && leaves(destination.tree).includes(destination.focused)
      ? destination.focused
      : destination ? leaves(destination.tree)[0] : undefined;
    recoveryTarget = targetPaneId ? panes.get(targetPaneId) ?? null : null;
  }

  for (const closing of closingPanes) {
    if (recoveryTarget && closing !== recoveryTarget) {
      recoveryTarget.bind(rebindPaneBinding(closing.binding, recoveryTarget.binding));
    }
  }
  for (const closing of closingPanes) {
    closing.destroy();
    panes.delete(closing.id);
  }
  spaces.delete(id);
  if (activeSpaceId === id) {
    const remaining = [...spaces.keys()];
    activeSpaceId = remaining[Math.min(index, remaining.length - 1)];
    layout = spaces.get(activeSpaceId)!;
    renderLayout();
    focusedPane()?.term.focus();
  }
  renderSpaceTabs();
  renderSidebar();
  save();
}

function switchSpace(id: string): void {
  const target = spaces.get(id);
  if (!target || id === activeSpaceId) return;
  closePaneMenu();
  activeSpaceId = id;
  layout = target;
  renderLayout();
  renderSpaceTabs();
  save();
  focusedPane()?.term.focus();
}

function createSpace(): void {
  let id = `s${++spaceSeq}`;
  while (spaces.has(id)) id = `s${++spaceSeq}`;
  const fresh: StoredLayout = {
    tree: { kind: "leaf", pane: `empty-${id}` },
    panes: {},
    focused: null,
  };
  spaces.set(id, fresh);
  activeSpaceId = id;
  layout = fresh;
  const pane = newPane(emptyBinding());
  layout.tree = { kind: "leaf", pane: pane.id };
  layout.focused = pane.id;
  renderLayout();
  renderSpaceTabs();
  save();
}

function movePaneToSpace(paneId: string, targetSpaceId: string): void {
  const source = spaceForPane(paneId);
  const target = spaces.get(targetSpaceId);
  if (!source || !target) return;
  if (source.id === targetSpaceId) {
    switchSpace(targetSpaceId);
    panes.get(paneId)?.focus();
    return;
  }
  const targetPaneId = target.focused && leaves(target.tree).includes(target.focused)
    ? target.focused
    : leaves(target.tree)[0];
  if (!targetPaneId || paneId === targetPaneId) return;

  // Exchange tree slots instead of rebinding either pane: both terminal views
  // and their live streams move intact, and neither space loses a slot.
  source.layout.tree = replacePaneId(source.layout.tree, paneId, targetPaneId);
  target.tree = replacePaneId(target.tree, targetPaneId, paneId);
  if (source.layout.focused === paneId) source.layout.focused = targetPaneId;
  if (target.focused === targetPaneId) target.focused = paneId;
  if (targetSpaceId === activeSpaceId) {
    renderLayout();
    renderSpaceTabs();
    save();
  } else {
    switchSpace(targetSpaceId);
  }
  panes.get(paneId)?.focus();
}

function handleSpaceDrop(spaceId: string, payload: Record<string, unknown>): void {
  if (payload.kind === "pane" && typeof payload.paneId === "string") {
    movePaneToSpace(payload.paneId, spaceId);
    return;
  }
  if (payload.kind === "runtime" && typeof payload.runtimeId === "string") {
    const runtime = runtimes.find((candidate) => candidate.id === payload.runtimeId);
    if (!runtime) return;
    const existing = [...panes.values()].find((pane) => pane.binding.runtimeId === runtime.id);
    if (existing) {
      if (spaceForPane(existing.id)?.id !== spaceId) movePaneToSpace(existing.id, spaceId);
      else {
        switchSpace(spaceId);
        existing.focus();
      }
      return;
    }
    switchSpace(spaceId);
    const pane = focusedPane();
    if (pane) {
      pane.bind(bindingForRuntime(runtime, displayTitle(runtime)));
      pane.focus();
    }
    return;
  }
  if (
    payload.kind === "session" &&
    typeof payload.path === "string" &&
    typeof payload.cwd === "string" &&
    typeof payload.title === "string"
  ) {
    const session = { path: payload.path, cwd: payload.cwd, title: payload.title };
    const existing = [...panes.values()].find((pane) => pane.binding.sessionFile === session.path);
    if (existing) {
      if (spaceForPane(existing.id)?.id !== spaceId) movePaneToSpace(existing.id, spaceId);
      else {
        switchSpace(spaceId);
        existing.focus();
      }
      void openSession(existing, session);
      return;
    }
    switchSpace(spaceId);
    const pane = focusedPane();
    if (pane) void openSession(pane, session);
  }
}

function swapPanes(aId: string, bId: string): void {
  if (aId === bId) return;
  const a = panes.get(aId);
  const b = panes.get(bId);
  if (!a || !b) return;
  const binding = a.binding;
  a.bind(b.binding, false);
  b.bind(binding, false);
}

function togglePaneFocus(): void {
  const pane = focusedPane();
  if (!pane || leaves().length < 2) return;
  expandedPaneId = expandedPaneId ? null : pane.id;
  renderLayout(true);
  pane.focus();
}

function renderLayout(preservePaneFocus = false): void {
  closePaneMenu();
  const count = leaves().length;
  splitLayoutEl.disabled = count >= MAX_PANES;
  splitLayoutEl.title = count >= MAX_PANES ? "Maximum 4 panes" : count === 1 ? "Split into 2×1" : "Split into 2×2";
  splitLayoutEl.setAttribute("aria-label", splitLayoutEl.title);
  splitLayoutEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18${count === 1 ? "" : "M3 12h18"}"/></svg>`;
  if (!preservePaneFocus) expandedPaneId = null;
  const tree: LayoutNode = expandedPaneId ? { kind: "leaf", pane: expandedPaneId } : layout.tree;
  const ids = leaves(tree);
  for (const pane of panes.values()) pane.markNeedsRepaint();
  panesEl.replaceChildren(buildNode(tree));
  for (const id of ids) {
    const pane = panes.get(id);
    if (!pane) continue;
    pane.renderHeader();
    pane.renderPlaceholder();
    window.requestAnimationFrame(() => pane.refreshAfterAttach());
  }
}

function buildNode(node: LayoutNode): HTMLElement {
  if (node.kind === "leaf") {
    const pane = panes.get(node.pane);
    if (!pane) {
      const placeholder = document.createElement("section");
      placeholder.className = "pane";
      return placeholder;
    }
    pane.el.style.flex = "1 1 0";
    return pane.el;
  }
  const split = document.createElement("div");
  split.className = `split split-${node.dir}`;
  const a = buildNode(node.a);
  const b = buildNode(node.b);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
  const divider = document.createElement("div");
  divider.className = `divider divider-split-${node.dir}`;
  divider.title = "Drag to resize";
  divider.addEventListener("pointerdown", (event) => startResize(event, node, split, a, b, divider));
  split.append(a, divider, b);
  return split;
}

/** Drag a divider: flexes update live, the ratio persists on release. Panes refit
 *  through their own ResizeObserver, so the terminals reflow during the drag. */
function startResize(
  event: PointerEvent,
  node: Extract<LayoutNode, { kind: "split" }>,
  split: HTMLElement,
  a: HTMLElement,
  b: HTMLElement,
  divider: HTMLElement,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = split.getBoundingClientRect();
  const horizontal = node.dir === "row";
  const total = horizontal ? rect.width : rect.height;
  if (total <= 0) return;
  const origin = horizontal ? event.clientX : event.clientY;
  const startRatio = node.ratio;
  divider.setPointerCapture(event.pointerId);
  divider.classList.add("dragging");
  const apply = (ratio: number) => {
    const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
    a.style.flex = `${clamped} 1 0`;
    b.style.flex = `${1 - clamped} 1 0`;
    return clamped;
  };
  const onMove = (move: PointerEvent) => {
    node.ratio = apply(startRatio + ((horizontal ? move.clientX : move.clientY) - origin) / total);
  };
  const onEnd = () => {
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onEnd);
    divider.removeEventListener("pointercancel", onEnd);
    divider.classList.remove("dragging");
    const finalRatio = apply(node.ratio);
    if (finalRatio === startRatio) return;
    node.ratio = finalRatio;
    save();
    // The observer's debounced fit can land mid-drag, so force every pane onto its
    // final geometry once the pointer is up rather than trusting the last callback.
    for (const id of leaves()) {
      const pane = panes.get(id);
      pane?.fitPane();
      pane?.sendResize(true);
    }
  };
  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onEnd);
  divider.addEventListener("pointercancel", onEnd);
}

// ---------------------------------------------------------------- sidebar


/** Mobile's fallback for a session whose accent the extension cannot resolve. */
const ACCENT_FALLBACK = "#808080";
const ACCENT_HEX = /^#[0-9a-f]{6}$/i;

function runtimeAccent(runtime: RuntimeInfo): string {
  const accent = runtime.presentation?.accent;
  return typeof accent === "string" && ACCENT_HEX.test(accent) ? accent : ACCENT_FALLBACK;
}
/** Acknowledge this turn only; a later completion remains unread. */
function acknowledgeCompletion(runtimeId: string | null): boolean {
  if (!runtimeId) return false;
  const identity = runtimes.find((runtime) => runtime.id === runtimeId)?.presentation?.completion?.identity;
  if (!identity || acknowledgedCompletions.get(runtimeId) === identity) return false;
  acknowledgedCompletions.set(runtimeId, identity);
  return true;
}


/** Update pin state in place so either surface retains keyboard focus. */
function syncPinButton(button: HTMLButtonElement, session: SessionSummaryLike | null): void {
  const pinned = session !== null && pinnedSessions.some((entry) => entry.path === session.path);
  const title = session ? `${pinned ? "Unpin" : "Pin"} chat` : "Waiting for session file";
  if (button.disabled !== (session === null)) button.disabled = session === null;
  if (button.getAttribute("aria-pressed") !== String(pinned)) {
    button.setAttribute("aria-pressed", String(pinned));
  }
  if (button.title !== title) button.title = title;
  if (button.getAttribute("aria-label") !== title) button.setAttribute("aria-label", title);
}

function createSidebarRow(kind: "runtime" | "session"): SidebarRowRecord {
  const element = document.createElement("div");
  const name = document.createElement("span");
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  name.className = "name";
  const sub = document.createElement("span");
  sub.className = "sub";
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const record: SidebarRowRecord = {
    element,
    name,
    sub,
    pin: null!,
    runtime: null,
    session: null,
    snapshot: null,
    nameKey: "",
    subKey: "",
    dragPayload: kind === "runtime"
      ? { kind: "runtime", runtimeId: "" }
      : { kind: "session", path: "", cwd: "", title: "" },
  };
  record.pin = pinButton(() => record.snapshot);
  if (kind === "runtime") {
    const kill = document.createElement("button");
    kill.className = "kill";
    kill.textContent = "✕";
    kill.title = "Stop this session";
    kill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (record.runtime) void killRuntime(record.runtime.id);
    });
    actions.append(kill, record.pin);
  } else {
    actions.append(record.pin);
  }
  element.append(name, sub, actions);
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showSessionMenu(record, event.clientX, event.clientY);
  });
  element.addEventListener("click", () => {
    const pane = focusedPane();
    if (!pane) return;
    const cwd = record.element.dataset.cwd;
    if (cwd) selectSidebarWorkspace(cwd);
    if (record.runtime) {
      pane.bind(bindingForRuntime(record.runtime, displayTitle(record.runtime)));
    } else if (record.session) {
      void openSession(pane, record.session);
    }
  });
  element.addEventListener("keydown", (event) => {
    if (event.target !== element || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    element.click();
  });
  wireSessionDrag(element, () => record.dragPayload);
  return record;
}

function updateSidebarRowName(
  record: SidebarRowRecord,
  title: string,
  indicator: "working" | "done" | "none",
): void {
  const key = `${indicator}\u0000${title}`;
  if (record.nameKey === key) return;
  record.nameKey = key;
  record.name.replaceChildren();
  if (indicator === "working") {
    record.name.append(workingIndicator(title));
    return;
  }
  const label = document.createElement("span");
  label.className = "title";
  label.textContent = title;
  record.name.append(label);
  if (indicator === "done") record.name.append(doneIndicator());
}

function updateSidebarRowSub(record: SidebarRowRecord, key: string, text: string): void {
  if (record.subKey === key) return;
  record.subKey = key;
  record.sub.textContent = text;
  record.sub.hidden = !text;
}

function updateRuntimeSidebarRow(
  record: SidebarRowRecord,
  runtime: RuntimeInfo,
  title: string,
  cwd: string,
  snapshot: SessionSummaryLike | null,
  workspaceView: boolean,
): void {
  if (workspaceView && (title === cwd || title === cwd.replace(/^\/home\/[^/]+/, "~") || title === runtime.id)) {
    title = "New session";
  }
  record.runtime = runtime;
  record.session = null;
  record.snapshot = snapshot;
  const className = runtime.alive ? "row live" : "row recent";
  if (record.element.className !== className) record.element.className = className;
  record.element.dataset.runtimeId = runtime.id;
  record.element.dataset.sessionFile = runtime.sessionFile ?? "";
  const workspace = normalizeDirectoryPath(cwd) ?? cwd;
  if (record.element.dataset.cwd !== workspace) record.element.dataset.cwd = workspace;
  const state = !daemonUp ? "Connection unavailable" : !attachable(runtime) ? "Saved · loads on request"
    : runtime.presentation?.agentActive ? "Working" : runtime.alive ? "Running" : "Starting";
  record.element.dataset.state = state;
  const rowTitle = `${title}\n${state}\n${cwd}\n${runtime.sessionFile ?? "(session file not known yet)"}`;
  if (record.element.title !== rowTitle) record.element.title = rowTitle;
  const accent = runtimeAccent(runtime);
  if (record.element.style.getPropertyValue("--row-accent") !== accent) {
    record.element.style.setProperty("--row-accent", accent);
  }
  const presentation = runtime.presentation;
  const indicator = daemonUp && runtime.alive && presentation
    ? presentation.agentActive
      ? "working"
      : presentation.completion &&
          acknowledgedCompletions.get(runtime.id) !== presentation.completion.identity
        ? "done"
        : "none"
    : "none";
  updateSidebarRowName(record, title, indicator);
  const sub = workspaceView ? "" : cwd.replace(/^\/home\/[^/]+/, "~") || "/";
  updateSidebarRowSub(record, `runtime\u0000${sub}`, sub);
  record.dragPayload.runtimeId = runtime.id;
  syncPinButton(record.pin, record.snapshot);
}

function updateRecentSidebarRow(
  record: SidebarRowRecord,
  session: SessionSummaryLike,
  workspaceView: boolean,
): void {
  record.runtime = null;
  record.session = session;
  record.snapshot = session;
  if (record.element.className !== "row recent") record.element.className = "row recent";
  delete record.element.dataset.runtimeId;
  record.element.dataset.sessionFile = session.path;
  const workspace = normalizeDirectoryPath(session.cwd) ?? session.cwd;
  if (record.element.dataset.cwd !== workspace) record.element.dataset.cwd = workspace;
  record.element.dataset.state = "Saved";
  const rowTitle = `${session.title}\nSaved · loads on request\n${session.cwd}\n${session.path}`;
  if (record.element.title !== rowTitle) record.element.title = rowTitle;
  const title = workspaceView && (!session.title || session.title === session.cwd) ? "New session" : session.title || session.cwd;
  updateSidebarRowName(record, title, "none");
  const cwd = workspaceView ? "" : session.cwd.replace(/^\/home\/[^/]+/, "~") || "/";
  updateSidebarRowSub(record, `session\u0000${cwd}`, cwd);
  record.dragPayload.path = session.path;
  record.dragPayload.cwd = session.cwd;
  record.dragPayload.title = session.title;
  syncPinButton(record.pin, record.snapshot);
}

function reconcileChildren(container: HTMLElement, desired: HTMLElement[]): void {
  const wanted = new Set(desired);
  for (const child of Array.from(container.children)) {
    if (!wanted.has(child as HTMLElement)) child.remove();
  }
  for (let index = 0; index < desired.length; index++) {
    const element = desired[index];
    const current = container.children[index] ?? null;
    if (current !== element) container.insertBefore(element, current);
  }
}

const WORKSPACE_SESSION_LIMIT = 6;

function folderRecord(cwd: string): SidebarFolderRecord {
  const existing = sidebarFolders.get(cwd);
  if (existing) return existing;
  const element = document.createElement("div");
  element.className = "sidebar-folder";
  const heading = document.createElement("button");
  heading.type = "button";
  heading.className = "folder-heading";
  heading.dataset.cwd = cwd;
  heading.title = cwd;
  const marker = document.createElement("span");
  marker.className = "folder-marker";
  marker.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "folder-label";
  heading.append(marker, label);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "workspace-new-session";
  const name = cwd.split("/").filter(Boolean).pop() ?? cwd;
  add.title = `New session in ${name}`;
  add.setAttribute("aria-label", add.title);
  add.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  add.addEventListener("click", () => {
    selectSidebarWorkspace(cwd);
    const pane = focusedPane();
    if (pane) void newSession(pane, true, cwd);
  });
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "workspace-menu";
  menuButton.title = `Workspace actions for ${name}`;
  menuButton.setAttribute("aria-label", menuButton.title);
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-controls", workspaceMenu.id);
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
  menuButton.addEventListener("click", () => showWorkspaceMenu(cwd, menuButton));
  menuButton.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    showWorkspaceMenu(cwd, menuButton);
  });
  const header = document.createElement("div");
  header.className = "workspace-heading";
  header.append(heading, add, menuButton);
  const contents = document.createElement("div");
  contents.className = "folder-sessions";
  contents.id = `sidebar-folder-${++sidebarFolderSeq}`;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "workspace-show-more";
  more.addEventListener("click", () => {
    record.showAllSessions = true;
    renderSidebar();
    (contents.children[WORKSPACE_SESSION_LIMIT] as HTMLElement | undefined)?.focus();
  });
  heading.setAttribute("aria-controls", contents.id);
  heading.addEventListener("click", () => {
    selectSidebarWorkspace(cwd);
    toggleSidebarFolder(cwd);
    heading.focus();
  });
  element.append(header, contents);
  const record = { element, heading, marker, label, contents, more, showAllSessions: false };
  sidebarFolders.set(cwd, record);
  return record;
}

function updateFolder(record: SidebarFolderRecord, cwd: string): void {
  const expanded = sidebarFolderExpanded(cwd);
  const marker = expanded
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8V5h6l2 2h10v3M3 10h19l-3 10H2L3 10Z"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3V7Z"/></svg>';
  if (record.marker.innerHTML !== marker) record.marker.innerHTML = marker;
  record.heading.classList.toggle("active", cwd === sidebarActiveWorkspace());
  const label = cwd.split("/").filter(Boolean).pop() ?? (cwd || "Ungrouped");
  if (record.label.textContent !== label) record.label.textContent = label;
  if (record.heading.getAttribute("aria-expanded") !== String(expanded)) {
    record.heading.setAttribute("aria-expanded", String(expanded));
  }
  if (record.contents.hidden === expanded) record.contents.hidden = !expanded;
}

function renderSidebar(): void {
  // Defer reconciliation while a row is being dragged so the active pointer
  // source and its payload remain attached until the drop completes.
  if (dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  for (const pane of panes.values()) pane.renderHeader();

  const query = searchEl.value.trim().toLowerCase();
  const folderView = sidebarFolderView();
  const sessionByPath = new Map<string, SessionSummaryLike>();
  for (const session of sessions) {
    if (!sessionByPath.has(session.path)) sessionByPath.set(session.path, session);
  }
  const liveFiles = new Set<string>();
  for (const runtime of runtimes) {
    if (attachable(runtime) && runtime.sessionFile) liveFiles.add(runtime.sessionFile);
  }
  let pinsChanged = false;
  pinnedSessions = pinnedSessions.map((pin) => {
    const fresh = sessionByPath.get(pin.path);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(pin)) {
      pinsChanged = true;
      return fresh;
    }
    return pin;
  });
  if (pinsChanged) savePins();
  const pinnedPaths = new Set(pinnedSessions.map((session) => session.path));
  const liveRuntimes = query
    ? runtimes.filter((runtime) => {
      const summary = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
      return `${displayTitle(runtime)} ${summary?.cwd ?? runtime.cwd}`.toLowerCase().includes(query);
    })
    : runtimes;
  // Exited transcripts belong to the same saved-session list, not a stale runtime row.
  const visibleRuntimes = liveRuntimes.filter((runtime) => {
    const summary = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
    const cwd = summary?.cwd ?? runtime.cwd;
    return (attachable(runtime) || !runtime.sessionFile) &&
      (!runtime.sessionFile || !archivedPaths.has(runtime.sessionFile)) &&
      !sidebarWorkspaceArchived(cwd);
  });
  const candidates = new Map(pinnedSessions.map((session) => [session.path, session]));
  for (const session of sessions) candidates.set(session.path, session);
  const recent = [...candidates.values()].filter((session) =>
    !liveFiles.has(session.path) &&
    !archivedPaths.has(session.path) &&
    !sidebarWorkspaceArchived(session.cwd) &&
    (!query || sessionByPath.has(session.path) || `${session.title} ${session.cwd}`.toLowerCase().includes(query)),
  ).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.path.localeCompare(b.path));

  const loadedRows: SidebarRowRecord[] = [];
  const pinnedRows: SidebarRowRecord[] = [];
  const otherRows: SidebarRowRecord[] = [];
  const activeKeys = new Set<string>();
  for (const runtime of visibleRuntimes) {
    const title = displayTitle(runtime);
    // The transcript directory is the project; runtime.cwd may only be its
    // process launch directory after omp relocates out of a disallowed path.
    const summary = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
    const cwd = summary?.cwd ?? runtime.cwd;
    const key = `runtime:${runtime.id}`;
    activeKeys.add(key);
    const record = sidebarRows.get(key) ?? createSidebarRow("runtime");
    sidebarRows.set(key, record);
    const snapshot = runtime.sessionFile
      ? summary ?? pinnedSessions.find((entry) => entry.path === runtime.sessionFile) ?? null
      : null;
    updateRuntimeSidebarRow(record, runtime, title, cwd, snapshot, folderView);
    loadedRows.push(record);
  }
  for (const session of recent) {
    const key = `session:${session.path}`;
    activeKeys.add(key);
    const record = sidebarRows.get(key) ?? createSidebarRow("session");
    sidebarRows.set(key, record);
    updateRecentSidebarRow(record, session, folderView);
    (pinnedPaths.has(session.path) ? pinnedRows : otherRows).push(record);
  }
  for (const [key, record] of sidebarRows) {
    if (activeKeys.has(key)) continue;
    record.element.remove();
    sidebarRows.delete(key);
  }

  // Runtime residency is an implementation detail: keep pinned chats first,
  // then order running and saved chats together by conversation activity.
  const rows = [...loadedRows, ...pinnedRows, ...otherRows].sort((a, b) => {
    const aPath = a.runtime?.sessionFile ?? a.session?.path ?? "";
    const bPath = b.runtime?.sessionFile ?? b.session?.path ?? "";
    const pinOrder = Number(pinnedPaths.has(bPath)) - Number(pinnedPaths.has(aPath));
    if (pinOrder) return pinOrder;
    const aActivity = Date.parse(a.snapshot?.updatedAt ?? a.runtime?.startedAt ?? "") || 0;
    const bActivity = Date.parse(b.snapshot?.updatedAt ?? b.runtime?.startedAt ?? "") || 0;
    return bActivity - aActivity || aPath.localeCompare(bPath);
  });
  const visibleWorkspaces = sidebarWorkspaces().filter((cwd) => !sidebarWorkspaceArchived(cwd));
  const desiredTopLevel: HTMLElement[] = [];
  if (rows.length === 0 && (!folderView || visibleWorkspaces.length === 0 || query !== "")) {
    if (!sidebarEmpty) {
      sidebarEmpty = document.createElement("div");
      sidebarEmpty.className = "side-empty";
    }
    const text = daemonUp ? (query ? "no matches" : "no sessions") : "daemon unreachable";
    if (sidebarEmpty.textContent !== text) sidebarEmpty.textContent = text;
    desiredTopLevel.push(sidebarEmpty);
  }

  const rowsByFolder = new Map<string, SidebarRowRecord[]>();
  for (const cwd of visibleWorkspaces) rowsByFolder.set(cwd, []);
  for (const row of rows) {
    const cwd = row.element.dataset.cwd ?? "";
    const folderRows = rowsByFolder.get(cwd) ?? [];
    folderRows.push(row);
    rowsByFolder.set(cwd, folderRows);
  }
  if (folderView) {
    for (const [cwd, folderRows] of rowsByFolder) {
      if (query && folderRows.length === 0 && !cwd.toLowerCase().includes(query)) continue;
      const folder = folderRecord(cwd);
      updateFolder(folder, cwd);
      const limited = !query && !folder.showAllSessions && folderRows.length > WORKSPACE_SESSION_LIMIT;
      const visibleRows = limited ? folderRows.slice(0, WORKSPACE_SESSION_LIMIT) : folderRows;
      const children = visibleRows.map((row) => row.element);
      if (limited) {
        const remaining = folderRows.length - WORKSPACE_SESSION_LIMIT;
        folder.more.textContent = `Show more (${remaining})`;
        folder.more.setAttribute("aria-label", `Show ${remaining} more sessions in ${cwd}`);
        children.push(folder.more);
      }
      reconcileChildren(folder.contents, children);
      desiredTopLevel.push(folder.element);
    }
  } else {
    const pinned = rows.filter((row) => pinnedPaths.has(row.runtime?.sessionFile ?? row.session?.path ?? ""));
    const unpinned = rows.filter((row) => !pinnedPaths.has(row.runtime?.sessionFile ?? row.session?.path ?? ""));
    for (const [label, sectionRows] of [
      ["Pinned", pinned],
      ["Sessions", unpinned],
    ] as const) {
      if (sectionRows.length === 0) continue;
      let heading = sidebarHeadings.get(label);
      if (!heading) {
        heading = document.createElement("button");
        heading.className = "session-section-heading";
        heading.setAttribute("type", "button");
        heading.addEventListener("click", () => {
          if (collapsedSidebarSections.has(label)) collapsedSidebarSections.delete(label);
          else collapsedSidebarSections.add(label);
          renderSidebar();
        });
        sidebarHeadings.set(label, heading);
      }
      const expanded = !collapsedSidebarSections.has(label);
      const text = `${expanded ? "▾" : "▸"} ${label} · ${sectionRows.length}`;
      if (heading.textContent !== text) heading.textContent = text;
      heading.setAttribute("aria-expanded", String(expanded));
      desiredTopLevel.push(heading);
      if (expanded) desiredTopLevel.push(...sectionRows.map((row) => row.element));
    }
  }
  for (const [cwd, folder] of sidebarFolders) {
    if (rowsByFolder.has(cwd)) continue;
    folder.element.remove();
    sidebarFolders.delete(cwd);
  }
  reconcileChildren(sessionListEl, desiredTopLevel);
  if (workspaceMenuAnchor && !workspaceMenuAnchor.isConnected) closeWorkspaceMenu();
}

function focusedPane(): Pane | null {
  const id = layout.focused ?? leaves()[0];
  return id ? (panes.get(id) ?? null) : null;
}

async function killRuntime(id: string): Promise<void> {
  await getJson(`/api/runtimes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshRuntimes();
}

function newSession(pane: Pane, focus = true, cwd = sidebarActiveWorkspace() ?? defaultCwd): void {
  pane.bind({
    runtimeId: null,
    title: null,
    sessionFile: null,
    ...(cwd ? { cwd } : {}),
  });
  if (focus) pane.focus();
}

/** Bind a saved session read-only unless an attachable runtime already owns it. */
function openSession(pane: Pane, session: { path: string; cwd: string; title: string }): void {
  const live = runtimeForSession(session.path, runtimes);
  if (live) pane.bind(bindingForRuntime(live, session.title));
  else pane.bind({ runtimeId: null, title: session.title, sessionFile: session.path, cwd: session.cwd });
  pane.focus();
}

// ---------------------------------------------------------------- runtime adoption

/**
 * Give live runtimes no pane claims a view, so an already-running daemon pool
 * reappears as the grid it was instead of only as sidebar entries. Runtimes
 * whose transcript is claimed by any pane are left for that pane; panes with a
 * session (or a runtime), and explicitly closed placeholders, are never overwritten.
 */
function adoptUnclaimedRuntimes(): void {
  // Detached live sessions belong in the sidebar, not in a restored empty slot.
  // Pool adoption is only a fallback for a client without a saved workspace.
  if (hasSavedWorkspace) return;
  const claimedRuntimes = new Set<string>();
  const claimedSessions = new Set<string>();
  for (const pane of panes.values()) {
    if (pane.binding.runtimeId) claimedRuntimes.add(pane.binding.runtimeId);
    if (pane.binding.sessionFile) claimedSessions.add(pane.binding.sessionFile);
  }
  for (const runtime of runtimes) {
    if (!attachable(runtime) || claimedRuntimes.has(runtime.id)) continue;
    if (runtime.sessionFile && claimedSessions.has(runtime.sessionFile)) continue;
    const empty = [...panes.values()].find((pane) =>
      !pane.binding.runtimeId && !pane.binding.sessionFile && !pane.binding.cwd &&
      !pane.binding.orphanDraft && !pane.binding.keepEmpty);
    if (!empty) return;
    empty.bind(bindingForRuntime(runtime, displayTitle(runtime)));
  }
}

// ---------------------------------------------------------------- persistence

function workspaceLayoutDocument(): StoredWorkspace {
  const savedSpaces: SpaceLayout[] = [];
  for (const [id, stored] of spaces) {
    const bindings: Record<string, PaneBinding> = {};
    for (const paneId of leaves(stored.tree)) {
      const pane = panes.get(paneId);
      if (pane) bindings[paneId] = pane.binding;
    }
    stored.panes = bindings;
    savedSpaces.push({ id, layout: stored });
  }
  return { spaces: savedSpaces, activeSpaceId };
}

function save(): void {
  const document = workspaceLayoutDocument();
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(document));
  } catch {
    console.warn("omp-desktop: workspace layout cannot be cached in browser storage");
    setStatus("Browser storage unavailable — workspace is kept on the daemon only", "warn");
  }
  queueStateSave();
}

function queueStateSave(): void {
  if (stateDelivering) {
    stateQueued = true;
    return;
  }
  if (stateSaveTimer !== undefined) return;
  stateSaveTimer = window.setTimeout(() => {
    stateSaveTimer = undefined;
    void deliverState();
  }, 0);
}

async function deliverState(): Promise<void> {
  if (stateGate !== "ready") {
    // The local cache already holds the change; publishing waits for a compatible
    // read so a partial or fallback document cannot replace the daemon's copy.
    if (stateGate === "blocked") {
      const message = `workspace state not saved: ${stateGateReason}`;
      if (stateSaveError !== message) {
        stateSaveError = message;
        console.warn("omp-desktop:", message);
        setStatus(message, "warn");
      }
    }
    return;
  }
  if (stateDelivering) {
    stateQueued = true;
    return;
  }
  stateDelivering = true;
  let deliveryFailed = false;
  let deliveryGeneration: string | null = null;
  try {
    do {
      stateQueued = false;
      const generation = daemonId;
      if (!generation || stateGateGeneration !== generation) {
        stateGate = "pending";
        stateGateGeneration = null;
        break;
      }
      deliveryGeneration = generation;
      const layoutDocument = workspaceLayoutDocument();
      const sidebar = localStorage.getItem(SIDEBAR_KEY);
      const fingerprint = JSON.stringify({
        layout: layoutDocument,
        pins: pinnedSessions,
        cellSize,
        sidebar,
      });
      if (fingerprint === deliveredState && !stateSaveError) break;
      const body = JSON.stringify({
        version: STATE_VERSION,
        savedAt: new Date().toISOString(),
        layout: layoutDocument,
        pins: pinnedSessions,
        cellSize,
        sidebar,
      });
      const bodyBytes = new TextEncoder().encode(body).length;
      if (bodyBytes > STATE_LIMIT_BYTES) {
        stateSaveError = `workspace state is too large to save (${Math.ceil(bodyBytes / 1024)} KiB)`;
        setStatus(stateSaveError, "warn");
        break;
      }
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json", "X-OMP-Generation": generation },
        body,
      });
      if (daemonId !== generation || stateGateGeneration !== generation) break;
      if (res.status === 409) {
        stateGate = "pending";
        stateGateGeneration = null;
        stateQueued = false;
        void refreshRuntimes().then((reachable) =>
          reachable && stateGate !== "ready" ? reconcileWorkspaceState() : undefined,
        );
        break;
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        if (daemonId !== generation || stateGateGeneration !== generation) break;
        throw new Error(detail || `HTTP ${res.status}`);
      }
      deliveredState = fingerprint;
      if (stateSaveError) {
        stateSaveError = null;
        setStatus("workspace state saved", "ok");
      }
    } while (stateQueued);
  } catch (error) {
    if (deliveryGeneration !== daemonId || stateGateGeneration !== deliveryGeneration) return;
    deliveryFailed = true;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `workspace state not saved: ${detail}`;
    if (stateSaveError !== message) {
      stateSaveError = message;
      console.warn("omp-desktop:", message, error);
      setStatus(message, "warn");
    }
  } finally {
    stateDelivering = false;
    if (stateQueued && !deliveryFailed && stateGate === "ready" && stateGateGeneration === daemonId) {
      stateQueued = false;
      queueStateSave();
    }
  }
}


/** Union of two pin lists by transcript path; the fresher snapshot wins, local on ties. */
function mergePins(local: SessionSummaryLike[], remote: SessionSummaryLike[]): SessionSummaryLike[] {
  const byPath = new Map<string, SessionSummaryLike>();
  for (const pin of [...remote, ...local]) {
    const existing = byPath.get(pin.path);
    if (!existing || !(Date.parse(existing.updatedAt) > Date.parse(pin.updatedAt))) byPath.set(pin.path, pin);
  }
  return [...byPath.values()];
}

/**
 * Adopts the daemon's durable workspace when this browser has none (cleared
 * storage, different port), merges pins both ways, then republishes the result.
 * The publishing gate opens only after this read succeeded (or proved the file
 * absent) and every adopted field is in memory, so a partial or fallback
 * document can never overwrite the durable copy.
 */
async function reconcileWorkspaceState(): Promise<void> {
  const generation = daemonId;
  if (!generation) {
    stateGate = "blocked";
    stateGateGeneration = null;
    stateGateReason = "daemon generation is unavailable";
    return;
  }
  const payload = parseStateResponse(await getJson("/api/state"));
  if (daemonId !== generation) return;
  if (payload === null) {
    // Unreadable copy: publishing stays closed so fallback state cannot replace it.
    stateGate = "blocked";
    stateGateGeneration = null;
    stateGateReason = "the daemon's saved workspace could not be read";
    return;
  }
  if (payload.kind === "unsupported") {
    // A newer document must not be overwritten by this build either.
    stateGate = "blocked";
    stateGateGeneration = null;
    stateGateReason = `the state file is version ${String(payload.version)} — update the app to read it`;
    setStatus(`workspace state file is version ${String(payload.version)} — update the app to read it`, "warn");
    return;
  }
  if (payload.kind === "none") {
    if (payload.corrupt) console.warn("omp-desktop: workspace state file is not valid JSON; replacing it");
  } else {
    const state = payload.state;
    if (!restoredLocal) {
      const stored = parseStoredWorkspace(state.layout);
      if (stored && applyStoredWorkspace(stored)) {
        // Repopulate the browser cache from the adopted document, so a later
        // reload (even with the daemon down) still has the workspace. The publish
        // this queues is held by the gate until adoption finishes.
        save();
        // Adopted bindings may name runtimes this daemon still has.
        for (const pane of panes.values()) pane.syncFromRuntimes();
      }
    }
    const mergedPins = mergePins(pinnedSessions, parseSessionList({ sessions: state.pins }) ?? []);
    if (JSON.stringify(mergedPins) !== JSON.stringify(pinnedSessions)) {
      pinnedSessions = mergedPins;
      savePins();
    }
    const remoteCellSize = typeof state.cellSize === "number" && Number.isFinite(state.cellSize) ? state.cellSize : null;
    if (remoteCellSize !== null && localStorage.getItem(CELL_KEY) === null) setCellSize(remoteCellSize);
    const remoteSidebar = typeof state.sidebar === "string" && state.sidebar.length <= STATE_LIMIT_BYTES ? state.sidebar : null;
    if (remoteSidebar && localStorage.getItem(SIDEBAR_KEY) === null) {
      try {
        applySidebarState(JSON.parse(remoteSidebar));
      } catch {
        // Malformed sidebar preferences are ignored.
      }
    }
  }
  // Compatible read and every adopted field in memory: the next publish carries
  // the whole workspace, never a partial one.
  restoredLocal = true;
  stateGateGeneration = generation;
  stateGate = "ready";
  queueStateSave();
}

/** localStorage is still a boundary: a hand-edited or older blob must not crash boot. */
function parseStoredLayout(value: unknown): StoredLayout | null {
  if (!isRecord(value) || !isRecord(value.panes)) return null;
  const tree = parseTree(value.tree, 0);
  if (!tree) return null;
  const storedPanes: Record<string, PaneBinding> = {};
  for (const [id, entry] of Object.entries(value.panes)) {
    const binding = bindingFromStored(entry);
    if (binding) storedPanes[id] = binding;
  }
  return { tree, panes: storedPanes, focused: typeof value.focused === "string" ? value.focused : null };
}

function parseStoredWorkspace(value: unknown): StoredWorkspace | null {
  if (isRecord(value) && Array.isArray(value.spaces)) {
    const parsed: SpaceLayout[] = [];
    const seen = new Set<string>();
    for (const entry of value.spaces) {
      if (!isRecord(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
      const stored = parseStoredLayout(entry.layout);
      if (!stored) continue;
      seen.add(entry.id);
      parsed.push({ id: entry.id, layout: stored });
    }
    if (!parsed.length) return null;
    const activeSpaceId = typeof value.activeSpaceId === "string" && seen.has(value.activeSpaceId)
      ? value.activeSpaceId
      : parsed[0].id;
    return { spaces: parsed, activeSpaceId };
  }
  // Documents written before browser spaces stored one layout directly.
  const legacy = parseStoredLayout(value);
  return legacy ? { spaces: [{ id: "s1", layout: legacy }], activeSpaceId: "s1" } : null;
}

function parseTree(value: unknown, depth: number): LayoutNode | null {
  if (!isRecord(value) || depth > 8) return null;
  if (value.kind === "leaf") return typeof value.pane === "string" ? { kind: "leaf", pane: value.pane } : null;
  if (value.kind === "split") {
    const a = parseTree(value.a, depth + 1);
    const b = parseTree(value.b, depth + 1);
    if (!a || !b) return null;
    const ratio = typeof value.ratio === "number" && value.ratio > 0.1 && value.ratio < 0.9 ? value.ratio : 0.5;
    return { kind: "split", dir: value.dir === "col" ? "col" : "row", ratio, a, b };
  }
  return null;
}

/** Rebuild every space while keeping pane IDs unique in the shared Pane map. */
function applyStoredWorkspace(stored: StoredWorkspace): boolean {
  if (!stored.spaces.length) return false;
  for (const pane of panes.values()) pane.destroy();
  panes.clear();
  spaces.clear();
  paneSeq = 0;
  spaceSeq = 0;
  for (const entry of stored.spaces) {
    let id = entry.id;
    while (spaces.has(id)) id = `s${++spaceSeq}`;
    const tree = gridLayout(entry.layout.tree);
    const ids = leaves(tree);
    if (!ids.length) continue;
    const rebuilt: StoredLayout = { tree, panes: {}, focused: null };
    spaces.set(id, rebuilt);
    const remapped = new Map<string, string>();
    for (const oldId of ids) {
      let paneId = oldId;
      while (panes.has(paneId)) paneId = `${oldId}-space-${++paneSeq}`;
      if (paneId !== oldId) {
        rebuilt.tree = replacePaneId(rebuilt.tree, oldId, paneId);
      }
      remapped.set(oldId, paneId);
      const numeric = Number(oldId.replace(/\D/g, ""));
      if (Number.isFinite(numeric)) paneSeq = Math.max(paneSeq, numeric);
      const binding = entry.layout.panes[oldId] ?? emptyBinding();
      rebuilt.panes[paneId] = binding;
      panes.set(paneId, new Pane(paneId, binding));
    }
    rebuilt.focused = entry.layout.focused
      ? remapped.get(entry.layout.focused) ?? leaves(rebuilt.tree)[0]
      : leaves(rebuilt.tree)[0];
  }
  if (!spaces.size) return false;
  hasSavedWorkspace = true;
  activeSpaceId = spaces.has(stored.activeSpaceId) ? stored.activeSpaceId : spaces.keys().next().value!;
  layout = spaces.get(activeSpaceId)!;
  renderLayout();
  renderSpaceTabs();
  return true;
}

function load(): void {
  let stored: StoredWorkspace | null = null;
  try {
    stored = parseStoredWorkspace(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    stored = null;
  }
  if (stored && applyStoredWorkspace(stored)) {
    restoredLocal = true;
    return;
  }
  const pane = newPane(emptyBinding());
  layout = { tree: { kind: "leaf", pane: pane.id }, panes: {}, focused: pane.id };
  spaces.set(activeSpaceId, layout);
}


// ---------------------------------------------------------------- chrome

// The daemon serves the bundle with no-store and publishes its hash here; a tab
// holding an older bundle reloads itself, so stale code cannot masquerade as
// "nothing changed" after a daemon restart.
let loadedBuild = "";
async function checkBuild(): Promise<void> {
  const payload = await getJson("/api/build");
  if (!isRecord(payload) || typeof payload.build !== "string") return;
  const build = payload.build;
  if (!loadedBuild) {
    loadedBuild = build;
    buildEl.textContent = build;
    return;
  }
  if (build !== loadedBuild) location.reload();
}

function setStatus(text: string, kind: "ok" | "warn" | "idle"): void {
  // A failed durable save stays visible (it risks losing the workspace) until a
  // save succeeds, instead of being overwritten by routine refreshes.
  if (stateSaveError) {
    statusEl.textContent = stateSaveError;
    statusEl.dataset.kind = "warn";
    statusEl.title = stateSaveError;
    return;
  }
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
  // The chip is one sidebar line and truncates. Warnings carry the daemon's own
  // explanation (a full pool, a refused session), so keep the whole text as the
  // tooltip instead of losing the part that says what to do.
  statusEl.title = kind === "warn" ? text : "";
}

// Never fit against fallback metrics: a pre-font fit leaves the bottom rows
// clipped once the real cell height lands.
const ICON_PROBE = "\u{F1157}";
const fontsReady = Promise.all([
  document.fonts.load(`${cellSize}px "Hack"`, "MWil0123"),
  document.fonts.load(`700 ${cellSize}px "Hack"`, "MWil0123"),
  // PUA-only face: Latin probes do not load the icon font.
  document.fonts.load(`${cellSize}px "JetBrainsMono Nerd Font Mono"`, ICON_PROBE),
]);
document.fonts.addEventListener("loadingdone", () => {
  for (const pane of panes.values()) pane.fitPane();
});
void fontsReady.then(() => {
  for (const pane of panes.values()) pane.fitPane();
  // A silent fallback to a non-mono face is what makes icons clip and drift, so
  // surface it instead of rendering a mystery.
  if (!document.fonts.check(`${cellSize}px "JetBrainsMono Nerd Font Mono"`, ICON_PROBE)) {
    setStatus("icon font missing", "warn");
    console.warn("omp-desktop: icon font did not load; omp's nerd icons will fall back to a non-mono face");
  }
});

// Shared font size is persisted; its Ctrl/Cmd defaults are editable in Settings.
function setCellSize(size: number): void {
  const next = Math.min(CELL_MAX, Math.max(CELL_MIN, size));
  if (next === cellSize) return;
  cellSize = next;
  try {
    localStorage.setItem(CELL_KEY, String(cellSize));
  } catch {
    console.warn("omp-desktop: font size cannot be cached in browser storage");
  }
  for (const id of leaves()) panes.get(id)?.fitPane();
  queueStateSave();
}

initializeHotkeys((action) => {
  if (action === "fontIncrease") setCellSize(cellSize + 1);
  else if (action === "fontDecrease") setCellSize(cellSize - 1);
  else if (action === "fontReset") setCellSize(CELL_SIZE);
  else if (action === "splitLayout") splitLayout();
  else if (action === "closePane") closePane(layout.focused ?? "");
  else if (action === "togglePaneFocus") togglePaneFocus();
  else if (action.startsWith("selectSpace")) {
    const spaceId = [...spaces.keys()][Number(action.slice("selectSpace".length)) - 1];
    if (spaceId) switchSpace(spaceId);
  }
});

newSessionEl.addEventListener("click", () => {
  const pane = focusedPane();
  if (pane) void newSession(pane);
});
newSpaceEl.addEventListener("click", createSpace);
let searchTimer: number | undefined;
searchEl.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refreshSessions(), 200);
});

// ---------------------------------------------------------------- boot

load();
renderLayout();
renderSpaceTabs();
renderSidebar();
let pollingReady = false;
let pollTimers: number[] = [];

function stopPolling(): void {
  for (const timer of pollTimers) window.clearInterval(timer);
  pollTimers = [];
}

function startPolling(): void {
  stopPolling();
  if (!pollingReady || document.hidden) return;
  pollTimers = [
    window.setInterval(() => void refreshRuntimes(), 2500),
    window.setInterval(() => void refreshSessions(), 30_000),
    window.setInterval(() => void checkBuild(), 10_000),
  ];
}

if (!document.hidden) void checkBuild();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  void checkBuild();
  if (pollingReady) {
    void refreshRuntimes();
    void refreshSessions();
    startPolling();
  }
});

async function boot(): Promise<void> {
  // Runtime and session-index reads do not depend on each other. Apply the
  // daemon workspace only after both are adopted so restore decisions use the
  // complete boot snapshot and the current daemon generation.
  const [reachable] = await Promise.all([
    refreshRuntimes({ restore: false }),
    refreshSessions(),
  ]);
  if (reachable) {
    await reconcileWorkspaceState();
    for (const pane of panes.values()) pane.syncFromRuntimes();
    // Adopt only runtimes already present in the daemon ledger. Starting a
    // session remains an explicit action from the pane or workspace controls.
    adoptPending = true;
    adoptSeen = runtimes.length;
    adoptUnclaimedRuntimes();
  } else {
    // Nothing was read, so nothing may be published: this browser's fallback
    // must never replace a daemon copy it could not see.
    stateGate = "blocked";
    stateGateReason = "daemon unreachable at startup";
    setStatus("daemon unreachable", "warn");
  }
  const pane = focusedPane();
  if (pane && defaultCwd && !pane.binding.runtimeId && !pane.binding.sessionFile &&
      !pane.binding.cwd && !pane.binding.keepEmpty) {
    pane.bind({ ...pane.binding, cwd: defaultCwd });
  }
  pane?.focus();
  pollingReady = true;
  startPolling();
}
void boot();
