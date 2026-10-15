import { trimSelectionHighlight } from "./selection";
import {
  applySidebarState, onSidebarStateChange, sidebarFolderView, sidebarFolderExpanded,
  toggleSidebarFolder, STORE_KEY as SIDEBAR_KEY,
} from "./sidebar";
import { doneIndicator, syncWorkingAnimation, workingIndicator } from "./working-indicator";
import { CompletionTracker } from "./completion-tracker";
import { CompletionNotifications } from "./notifications";
import { Terminal } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { isRecord } from "./guards";
import { insertFilePaths, wireFileDrop } from "./file-drop";
import {
  attachable,
  bindingForRuntime,
  bindingFromStored,
  emptyBinding,
  intentAfterExit,
  intentAfterRuntimeLoss,
  pendingResumes,
  type PaneBinding,
} from "./lifecycle";
import {
  parsePasteResponse,
  parseRuntimesResponse,
  parseRuntimeOne,
  parseServerMessage,
  parseSessionList,
  parseStateResponse,
  type RuntimeInfo,
  type SessionSummaryLike,
} from "./protocol";

// Sidebar preferences share the durable-save path with panes, pins and font size.
onSidebarStateChange(() => {
  renderSidebar();
  queueStateSave();
});

const statusEl = document.getElementById("status") as HTMLElement;
const buildEl = document.getElementById("build") as HTMLElement;
const spaceTabsEl = document.getElementById("space-tabs") as HTMLElement;
const newSpaceEl = document.getElementById("new-space") as HTMLButtonElement;
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
spaces.set(activeSpaceId, layout);
let spaceSeq = 1;
/** True when the current panes came from a stored document (browser or daemon). */
let restoredLocal = false;
let runtimes: RuntimeInfo[] = [];
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
/**
 * Publishing gate. Closed until the daemon's document has been read (or proven
 * absent) and every adopted field is in memory, so a partial or fallback
 * workspace can never overwrite the durable copy. Browser storage keeps caching
 * while closed; only the daemon PUT is held back.
 */
let stateGate: "pending" | "ready" | "blocked" = "pending";
/** Why publishing is blocked; surfaced when a save is attempted while gated. */
let stateGateReason = "";
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

function pinButton(session: SessionSummaryLike | null): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "pin";
  const pinned = session !== null && pinnedSessions.some((entry) => entry.path === session.path);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z"/><path d="M12 15v6"/></svg>';
  button.setAttribute("aria-pressed", String(pinned));
  button.disabled = session === null;
  button.title = session ? `${pinned ? "Unpin" : "Pin"} chat` : "Waiting for session file";
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!session) return;
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
function wireSessionDrag(element: HTMLElement, payload: Record<string, unknown>): void {
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
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!origin || event.pointerId !== origin.pointer) return;
    if (!moved && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return;
    if (!moved) {
      moved = true;
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
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".space-tab, .pane") ?? null;
    if (hit !== target) {
      target?.classList.remove("drop");
      target = hit;
      target?.classList.add("drop");
    }
  });
  const finish = (event: PointerEvent): void => {
    if (!origin || event.pointerId !== origin.pointer) return;
    const destination = target;
    const shouldDrop = moved && event.type === "pointerup";
    suppressClick = moved;
    target?.classList.remove("drop");
    target = null;
    origin = null;
    preview?.remove();
    preview = null;
    element.classList.remove("session-drag-source");
    document.body.classList.remove("session-dragging");
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (shouldDrop && destination) {
      event.preventDefault();
      if (destination.dataset.space) handleSpaceDrop(destination.dataset.space, payload);
      else if (destination.dataset.pane) handlePaneDrop(destination.dataset.pane, payload);
    }
    dragging = false;
    if (renderPending) renderSidebar();
  };
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
  element.addEventListener("lostpointercapture", finish);
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
    if (runtime) pane.bind(bindingForRuntime(runtime, daemonId, displayTitle(runtime)));
  } else if (payload.kind === "session" && typeof payload.path === "string"
      && typeof payload.cwd === "string" && typeof payload.title === "string") {
    void openSession(pane, { path: payload.path, cwd: payload.cwd, title: payload.title });
  }
}

// ---------------------------------------------------------------- daemon API

/**
 * Fetch JSON for a boundary that validates its own shape. Returns null (and shows
 * the failure in the status chip) on transport errors or a non-2xx status.
 */
async function getJson(path: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(path, { cache: "no-store", ...init });
    if (!res.ok) {
      setStatus(`${path} → ${res.status}`, "warn");
      return null;
    }
    return (await res.json()) as unknown;
  } catch {
    setStatus("daemon unreachable", "warn");
    return null;
  }
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
  if (payload.generation) daemonId = payload.generation;
  // A new (or never-seen) generation means the pool this client knew is gone
  // and the daemon may be rebuilding it right now. Watch the pool while it
  // grows so restored sessions no pane claims still get a view.
  if (options.restore !== false && (previousGeneration === null || daemonId !== previousGeneration)) {
    adoptPending = true;
    adoptSeen = 0;
  }
  runtimes = payload.runtimes;
  completionTracker.observe(runtimes, (runtime) => {
    void completionNotifications.notifyCompletion(runtime.id, displayTitle(runtime));
  });
  renderSidebar();
  // One pass per pane clears vanished bindings (keeping a resume claim only when
  // the daemon restarted) and reattaches runtimes that are still alive.
  for (const pane of panes.values()) pane.syncFromRuntimes();
  setStatus(`${runtimes.length} live`, "ok");
  // Reopen panes whose session came back after boot; the boot path passes
  // restore:false so adoption finishes before anything is resumed.
  if (options.restore !== false) {
    void restoreWantedSessions().then(() => {
      if (!adoptPending) return;
      if (runtimes.length > adoptSeen) {
        adoptSeen = runtimes.length;
        adoptUnclaimedRuntimes();
      } else {
        adoptPending = false;
      }
    });
  }
  return true;
}

/**
 * POST /api/runtimes with its HTTP status kept: a 400 is the daemon refusing a
 * transcript (gone or not under the session store) and must end a pane's resume
 * claim, while a transport or capacity failure is retried later.
 */
async function requestRuntime(
  request: { cwd?: string; resume?: string },
  notify = true,
): Promise<{ runtime: RuntimeInfo | null; status: number | null }> {
  let res: Response;
  try {
    res = await fetch("/api/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { runtime: null, status: null };
  }
  if (!res.ok) {
    if (notify) setStatus(`/api/runtimes → ${res.status}`, "warn");
    return { runtime: null, status: res.status };
  }
  const runtime = parseRuntimeOne(await res.json().catch(() => null));
  if (!runtime) return { runtime: null, status: res.status };
  runtimes = [...runtimes.filter((candidate) => candidate.id !== runtime.id), runtime];
  renderSidebar();
  return { runtime, status: res.status };
}

async function refreshSessions(): Promise<void> {
  const search = searchEl.value.trim();
  const query = new URLSearchParams({ limit: "60" });
  if (search) query.set("search", search);
  const list = parseSessionList(await getJson(`/api/sessions?${query}`));
  if (!list) return;
  sessions = list;
  renderSidebar();
}

/** Uploads a pasted image; the daemon returns the path it stored it at. */
async function uploadPaste(file: File): Promise<string | null> {
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

/** xterm's measured cell dimensions in device pixels. */
type CellMetrics = { cellW: number; cellH: number };

function xtermMetrics(term: Terminal): CellMetrics | null {
  const device = (
    term as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { device?: { cell?: { width?: number; height?: number } } };
        };
      };
    }
  )._core?._renderService?.dimensions?.device;
  const cellW = device?.cell?.width;
  const cellH = device?.cell?.height;
  if (typeof cellW !== "number" || !(cellW > 0)) return null;
  if (typeof cellH !== "number" || !(cellH > 0)) return null;
  return { cellW, cellH };
}

/** DOM measurement fallback if xterm's internal metrics become unavailable. */
function drawnMetrics(term: Terminal, dpr: number): CellMetrics | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const cols = term.cols;
  const rows = term.rows;
  if (!screen || !cols || !rows) return null;
  const box = screen.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const cellH = Math.max(1, Math.round((box.height / rows) * dpr));
  return { cellW: (box.width / cols) * dpr, cellH };
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
  #placeholder: HTMLElement;
  #titleEl: HTMLElement;
  #stateEl: HTMLElement;
  #observer: ResizeObserver;
  #resizeTimer: number | undefined;
  #selectionEvents = new AbortController();
  #selectionRevision = 0;
  #disposeFileDrop: (() => void) | null = null;

  constructor(id: string, binding: PaneBinding) {
    this.id = id;
    this.binding = binding;
    this.el = document.createElement("section");
    this.el.className = "pane";
    this.el.dataset.pane = id;

    const header = document.createElement("header");
    header.className = "pane-header";
    this.#titleEl = document.createElement("span");
    this.#titleEl.className = "pane-title";
    this.#stateEl = document.createElement("span");
    this.#stateEl.className = "pane-state";
    const spacer = document.createElement("span");
    spacer.className = "pane-spacer";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Close pane (Ctrl+Shift+X)";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closePane(this.id);
    });
    header.append(this.#titleEl, this.#stateEl, spacer, close);

    this.#body = document.createElement("div");
    this.#body.className = "pane-body";
    this.#host = document.createElement("div");
    this.#host.className = "term-host";
    this.#placeholder = document.createElement("div");
    this.#placeholder.className = "pane-placeholder";
    this.#body.append(this.#placeholder, this.#host);

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
    // xterm paints OSC 8 file targets with a dashed underline even though its
    // default link handler cannot open them. Consume those links only; preserve
    // HTTP links and explicit SGR underlining in the transcript.
    this.term.parser.registerOscHandler(8, (data) => {
      const separator = data.indexOf(";");
      return separator >= 0 && data.slice(separator + 1).startsWith("file:");
    });
    this.term.open(this.#host);
    trimSelectionHighlight(this.term);
    const rendererWarning = document.createElement("span");
    rendererWarning.textContent = "DOM";
    rendererWarning.title = "GPU renderer unavailable: box and block glyphs may have seams";
    const showRendererWarning = () => {
      this.el.dataset.renderer = "dom";
      if (!rendererWarning.isConnected) header.insertBefore(rendererWarning, spacer);
    };
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        showRendererWarning();
      });
      this.term.loadAddon(webgl);
      this.el.dataset.renderer = "webgl";
    } catch (error) {
      webgl?.dispose();
      showRendererWarning();
      console.warn("omp-desktop: GPU renderer unavailable", error);
    }
    this.term.loadAddon(new ImageAddon());
    this.term.loadAddon(new WebLinksAddon(openTerminalLink));
    this.term.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "input", data }));
    });
    this.term.onSelectionChange(() => { this.#selectionRevision++; });

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
    this.el.addEventListener("mousedown", () => this.focus());
    this.#observer = new ResizeObserver(() => this.#scheduleFit());
    this.#observer.observe(this.#body);

    wireSessionDrag(header, { kind: "pane", paneId: this.id });
    this.#wireDrop();
    this.#disposeFileDrop = wireFileDrop(this.el, {
      onPaths: (paths) => insertFilePaths(this.ws, paths),
      upload: uploadPaste,
    });
    this.el.addEventListener("paste", (event) => this.#handlePaste(event));
    this.renderPlaceholder();
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
    const file = item?.getAsFile();
    if (!file) return; // plain text: xterm's own paste path handles it
    event.preventDefault();
    setStatus("uploading image…", "idle");
    const path = await uploadPaste(file);
    if (!path) {
      setStatus("image paste failed", "warn");
      return;
    }
    const socket = this.ws;
    if (socket?.readyState !== WebSocket.OPEN) {
      setStatus("image saved, but this pane has no live session", "warn");
      return;
    }
    socket.send(JSON.stringify({ type: "input", data: `${path} ` }));
    setStatus("image path typed", "ok");
    this.term.focus();
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

  focus(): void {
    const owner = spaceForPane(this.id);
    if (owner && owner.id !== activeSpaceId) switchSpace(owner.id);
    if (layout.focused !== this.id) {
      layout.focused = this.id;
      renderSidebar();
      save();
    }
    this.term.focus();
  }

  #scheduleFit(): void {
    window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => this.fitPane(), 80);
  }

  /** Fit only when laid out: fitting a display:none pane computes garbage sizes. */
  fitPane(): void {
    if (!this.visible) return;
    this.#fitGrid();
    this.sendResize();
  }

  /** Restore pixels after this terminal's DOM was detached and reattached. */
  refreshAfterAttach(): void {
    if (!this.visible) return;
    this.fitPane();
    // Resizing only requests a render when the grid changes. A detached
    // renderer can lose its pixels without changing geometry, so repaint the
    // current viewport while preserving xterm's buffer and scroll position.
    this.term.refresh(0, this.term.rows - 1);
  }

  /** Fit whole cells without changing text geometry to fill leftover space. */
  #fitGrid(): void {
    const host = this.#host;
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (!viewport || !host.clientWidth || !host.clientHeight) return;
    if (this.term.options.fontSize !== cellSize) this.term.options.fontSize = cellSize;
    if (this.term.options.lineHeight !== CELL_LINE_HEIGHT) this.term.options.lineHeight = CELL_LINE_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    const metrics = xtermMetrics(this.term) ?? drawnMetrics(this.term, dpr);
    if (!metrics) return;
    const frame = host.getBoundingClientRect();
    const reserve = Math.max(0, viewport.getBoundingClientRect().width - viewport.clientWidth);
    const cols = Math.max(1, Math.floor((frame.width - reserve) * dpr / metrics.cellW));
    const rows = Math.max(1, Math.floor(frame.height * dpr / metrics.cellH));
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  sendResize(force = false): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const size = `${this.term.cols}x${this.term.rows}`;
    if (!force && size === this.#lastSent) return;
    this.#lastSent = size;
    this.ws.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
  }

  bind(binding: PaneBinding): void {
    const changed = this.binding.runtimeId !== binding.runtimeId;
    if (changed || !binding.runtimeId) this.detach();
    this.binding = binding;
    this.renderPlaceholder();
    // Selecting the current session must not replay it or add another stream.
    if (binding.runtimeId && !this.ws) this.attach();
    this.renderHeader();
    save();
    renderSidebar();
  }

  detach(): void {
    this.retry = Number.POSITIVE_INFINITY;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }

  attach(): void {
    const runtimeId = this.binding.runtimeId;
    if (!runtimeId) return;
    // A pane owns one stream. Rebinding must stop its previous subscription
    // before replacing the socket that detach() knows how to close.
    this.detach();
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
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.term.reset();
      // The daemon may not have sniffed the session file yet (or ever, for a
      // session started this instant); keep a known transcript identity instead
      // of overwriting it with null.
      if (runtime.sessionFile) this.binding.sessionFile = runtime.sessionFile;
      // Attached means live under the daemon that answered this open.
      this.binding.autoResume = true;
      this.binding.daemonGeneration = daemonId;
      // Detached spaces keep their terminal stream but must not resize a live
      // PTY to stale geometry while the view is hidden.
      if (this.visible) {
        this.sendResize(true);
        this.fitPane();
      }
      if (layout.focused === this.id && this.visible) this.term.focus();
      save();
    };
    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      if (typeof event.data === "string") {
        this.#handleControl(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) this.term.write(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
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

  #handleControl(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    if (msg.type === "hello") {
      this.binding.title = displayTitle(msg.runtime);
      // Same rule as onopen: an unknown file must not erase the one the pane
      // already holds, or a resume would lose its transcript identity until the
      // next sniff.
      if (msg.runtime.sessionFile) this.binding.sessionFile = msg.runtime.sessionFile;
      this.renderHeader();
      renderSidebar();
      // Persist the sniffed session file: it is the identity auto-resume and the
      // placeholder's manual resume both need.
      save();
    } else if (msg.type === "exit") {
      this.#stateEl.textContent = `exited ${msg.exitCode ?? "?"}`;
      // A process that ended is finished, not restarted; only a daemon-wide
      // shutdown defers the pane's claim to be live to the next daemon start.
      const next = intentAfterExit(this.binding, msg.daemonShutdown);
      if (next !== this.binding.autoResume) {
        this.binding.autoResume = next;
        save();
      }
    }
  }

  runtimeGone(): void {
    this.detach();
    // Drop the id but keep the title/session file: the placeholder then offers
    // "resume this session" instead of a frozen screen with no way back.
    this.binding.runtimeId = null;
    // Keep the resume claim only when the runtime may have died with its daemon;
    // a loss under the same daemon (kill button, another client, omp exiting) is
    // final, and a pane without a transcript has nothing to reopen.
    this.binding.autoResume = intentAfterRuntimeLoss(this.binding, { up: daemonUp, generation: daemonId });
    this.#stateEl.textContent = "exited";
    this.renderHeader();
    this.renderPlaceholder();
    save();
  }

  /** The user stopped this pane's session: never resume it on a later start. */
  clearLiveIntent(): void {
    if (!this.binding.autoResume) return;
    this.binding.autoResume = false;
    save();
  }

  syncFromRuntimes(): void {
    // An unreplied refresh means the daemon is unreachable, not that every
    // runtime is gone: never clear a binding from missing data.
    if (!daemonUp) {
      this.renderPlaceholder();
      return;
    }
    const runtimeId = this.binding.runtimeId;
    if (!runtimeId) {
      this.renderPlaceholder();
      return;
    }
    const runtime = runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      // Gone for good: stopped under this daemon or lost with it. runtimeGone()
      // decides whether the pane keeps its resume claim.
      this.runtimeGone();
      this.renderPlaceholder();
      return;
    }
    if (!attachable(runtime)) {
      // An exited process is final: attaching would start the session again.
      // A reserved runtime (never attached, `alive:false` until the daemon
      // spawns it) is attachable and must not be mistaken for a dead one.
      // A socket that watched the exit keeps the frozen "exited" screen; a
      // fresh page falls back to the placeholder (and its manual resume).
      if (!this.ws) this.runtimeGone();
      this.renderPlaceholder();
      return;
    }
    // The runtime is authoritative about which transcript it is writing. If omp
    // switched sessions in the TUI after this binding was saved, adopt the
    // transcript it is actually on; a matching runtime id is the same process,
    // not a reused name.
    this.#stateEl.textContent = "";
    const title = displayTitle(runtime);
    const adoptFile = runtime.sessionFile && runtime.sessionFile !== this.binding.sessionFile
      ? runtime.sessionFile
      : null;
    if (adoptFile) this.binding.sessionFile = adoptFile;
    if (title !== this.binding.title || adoptFile || this.binding.daemonGeneration !== daemonId || !this.binding.autoResume) {
      this.binding.title = title;
      this.binding.autoResume = true;
      this.binding.daemonGeneration = daemonId;
      this.renderHeader();
      save();
    }
    if (!this.ws && this.retry !== Number.POSITIVE_INFINITY) this.attach();
    this.renderPlaceholder();
  }

  renderHeader(): void {
    this.#titleEl.textContent = this.binding.title ?? "no session";
    this.#titleEl.title = this.binding.sessionFile ?? "";
    if (this.binding.runtimeId) this.#stateEl.textContent = "";
  }

  renderPlaceholder(): void {
    this.#placeholder.replaceChildren();
    if (this.binding.runtimeId) {
      this.#placeholder.style.display = "none";
      this.#host.style.display = "";
      return;
    }
    this.#placeholder.style.display = "flex";
    this.#host.style.display = "none";
    const text = document.createElement("div");
    text.textContent = this.binding.title
      ? `${this.binding.title} — not running`
      : "empty pane — choose a session from the sidebar or start one";
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    const sessionFile = this.binding.sessionFile;
    if (sessionFile) {
      // Pins keep older transcripts reachable, so they carry the fallback cwd too;
      // the daemon resolves the recorded cwd itself when the file has one.
      const known = sessionSummary(sessionFile);
      const resume = document.createElement("button");
      resume.textContent = "resume this session";
      resume.addEventListener("click", () =>
        void openSession(this, {
          path: sessionFile,
          cwd: known?.cwd ?? "",
          title: this.binding.title ?? "session",
        }),
      );
      row.append(resume);
    }
    const start = document.createElement("button");
    start.textContent = "new session here";
    start.addEventListener("click", () => void newSession(this));
    row.append(start);
    this.#placeholder.append(text, row);
  }

  destroy(): void {
    this.#selectionEvents.abort();
    this.#observer.disconnect();
    this.#disposeFileDrop?.();
    this.#disposeFileDrop = null;
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
splitMenuItem.setAttribute("aria-keyshortcuts", "Control+Shift+E");
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
panesEl.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".pane") : null;
  const pane = target?.dataset.pane ? panes.get(target.dataset.pane) : null;
  if (!target || !pane) return;
  event.preventDefault();
  pane.focus();
  const count = leaves().length;
  splitMenuItem.textContent = count >= MAX_PANES
    ? "Split — maximum 4 panes"
    : count === 1 ? "Split side by side" : "Split into 2×2";
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
  const shown = new Set([...panes.values()].map((pane) => pane.binding.runtimeId).filter((id): id is string => id !== null));
  const split = (node: LayoutNode, dir: "row" | "col"): LayoutNode => {
    if (node.kind !== "leaf") return node;
    const candidate = runtimes.find((runtime) => !shown.has(runtime.id));
    if (candidate) shown.add(candidate.id);
    const fresh = newPane(
      candidate ? bindingForRuntime(candidate, daemonId, displayTitle(candidate)) : emptyBinding(),
    );
    layout.focused = fresh.id;
    return { kind: "split", dir, ratio: 0.5, a: node, b: { kind: "leaf", pane: fresh.id } };
  };
  layout.tree = tree.kind === "leaf"
    ? split(tree, "row")
    : { ...tree, a: split(tree.a, "col"), b: split(tree.b, "col") };
  renderLayout();
  save();
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
    return;
  }
  const removed = ids.length === 4 && alreadyClosed ? [alreadyClosed, paneId] : [paneId];
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

function renderSpaceTabs(): void {
  spaceTabsEl.replaceChildren();
  let index = 0;
  for (const id of spaces.keys()) {
    const tab = document.createElement("button");
    tab.className = "space-tab";
    tab.dataset.space = id;
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.textContent = `Space ${++index}`;
    tab.setAttribute("aria-selected", String(id === activeSpaceId));
    tab.tabIndex = id === activeSpaceId ? 0 : -1;
    tab.addEventListener("click", () => switchSpace(id));
    spaceTabsEl.append(tab);
  }
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
      pane.bind(bindingForRuntime(runtime, daemonId, displayTitle(runtime)));
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
  a.bind(b.binding);
  b.bind(binding);
}

function renderLayout(): void {
  closePaneMenu();
  const tree = layout.tree;
  const ids = leaves(tree);
  panesEl.replaceChildren(buildNode(tree));
  for (const id of ids) {
    const pane = panes.get(id);
    if (!pane) continue;
    pane.renderHeader();
    pane.renderPlaceholder();
    window.setTimeout(() => pane.refreshAfterAttach(), 0);
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
    node.ratio = apply(node.ratio);
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

function sessionRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

/** Mobile's fallback for a session whose accent the extension cannot resolve. */
const ACCENT_FALLBACK = "#808080";
const ACCENT_HEX = /^#[0-9a-f]{6}$/i;

function runtimeAccent(runtime: RuntimeInfo): string {
  const accent = runtime.presentation?.accent;
  return typeof accent === "string" && ACCENT_HEX.test(accent) ? accent : ACCENT_FALLBACK;
}

/**
 * Working/Done come only from the extension's authoritative state
 * (`presentation`): PTY byte traffic says bytes moved, not that omp is
 * answering, so a missing presentation shows no indicator at all. Working wins
 * while the next turn runs; a finished turn keeps its Done badge until then.
 */
function runtimeIndicator(runtime: RuntimeInfo): HTMLElement | null {
  const presentation = runtime.presentation;
  if (!daemonUp || !runtime.alive || !presentation) return null;
  if (presentation.agentActive) return workingIndicator();
  return presentation.completion ? doneIndicator() : null;
}

/** Row heading: title plus the authoritative working/done badge, mobile-style. */
function rowName(title: string, status: HTMLElement | null): HTMLElement {
  const name = document.createElement("span");
  name.className = "name";
  const label = document.createElement("span");
  label.className = "title";
  label.textContent = title;
  name.append(label);
  if (status) name.append(status);
  return name;
}

function renderSidebar(): void {
  // Rebuilding rows mid-drag cancels the drag the user is performing.
  if (dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  sessionListEl.replaceChildren();

  const query = searchEl.value.trim().toLowerCase();
  const folderView = sidebarFolderView();
  const folders = new Map<string, HTMLElement[]>();
  const sessionByPath = new Map<string, SessionSummaryLike>();
  for (const session of sessions) {
    if (!sessionByPath.has(session.path)) sessionByPath.set(session.path, session);
  }
  const liveFiles = new Set<string>();
  for (const runtime of runtimes) {
    if (runtime.sessionFile) liveFiles.add(runtime.sessionFile);
  }
  // Pinned snapshots keep older chats reachable beyond the recent-session limit.
  // Transcript paths identify pins across stop/resume and daemon restarts.
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
  const pinnedRows: HTMLElement[] = [];
  const otherRows: HTMLElement[] = [];
  const liveRuntimes = query
    ? runtimes.filter((runtime) => {
      const summary = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
      return `${displayTitle(runtime)} ${summary?.cwd ?? runtime.cwd}`.toLowerCase().includes(query);
    })
    : runtimes;
  const candidates = new Map(pinnedSessions.map((session) => [session.path, session]));
  for (const session of sessions) candidates.set(session.path, session);
  const recent = [...candidates.values()].filter((session) =>
    !liveFiles.has(session.path) &&
    (!query || sessionByPath.has(session.path) ||
      `${session.title} ${session.cwd}`.toLowerCase().includes(query)),
  );

  if (!liveRuntimes.length && !recent.length) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = daemonUp ? (query ? "no matches" : "no sessions") : "daemon unreachable";
    sessionListEl.append(empty);
  }

  // Which pane shows a runtime, for the row subtitle; first matching pane wins.
  const paneForRuntime = new Map<string, string>();
  for (const pane of panes.values()) {
    const runtimeId = pane.binding.runtimeId;
    if (runtimeId && !paneForRuntime.has(runtimeId)) paneForRuntime.set(runtimeId, pane.id);
  }

  for (const runtime of liveRuntimes) {
    const title = displayTitle(runtime);
    // The transcript's recorded directory is the session's project; runtime.cwd
    // is only the process launch dir (equal for a resumed session, not for one
    // omp relocated out of a disallowed launch dir).
    const summary = runtime.sessionFile ? sessionSummary(runtime.sessionFile) : undefined;
    const cwd = summary?.cwd ?? runtime.cwd;
    const row = document.createElement("div");
    row.className = runtime.alive ? "row live loaded" : "row recent loaded";
    row.dataset.cwd = cwd;
    // The live edge and the working shimmer both read this one session colour;
    // without a validated accent they fall back to mobile's grey.
    row.style.setProperty("--row-accent", runtimeAccent(runtime));
    row.title = `${cwd}\n${runtime.sessionFile ?? "(session file not known yet)"}\n${runtime.id}`;
    const ownerId = paneForRuntime.get(runtime.id);
    const name = rowName(title, runtimeIndicator(runtime));
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = ownerId ? ownerId.replace("p", "pane ") : folderView ? "" : cwd.replace(/^\/home\/[^/]+/, "~");
    sub.hidden = !sub.textContent;
    const kill = document.createElement("button");
    kill.className = "kill";
    kill.textContent = "✕";
    kill.title = "Stop this session";
    kill.addEventListener("click", (event) => {
      event.stopPropagation();
      void killRuntime(runtime.id);
    });
    // A live session with no index row (new, or outside the loaded window) may
    // carry an existing pin snapshot, but never a synthesized time: runtime
    // activity is PTY byte traffic, not conversation, and "now" would relabel
    // an old chat as freshly used. No snapshot disables the pin button until
    // the next session-index refresh carries the row.
    const snapshot = runtime.sessionFile
      ? summary ?? pinnedSessions.find((entry) => entry.path === runtime.sessionFile) ?? null
      : null;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(pinButton(snapshot), kill);
    row.append(name, sub, actions);
    row.addEventListener("click", () => {
      const pane = focusedPane();
      if (pane) pane.bind(bindingForRuntime(runtime, daemonId, displayTitle(runtime)));
    });
    wireSessionDrag(row, { kind: "runtime", runtimeId: runtime.id });
    (runtime.sessionFile && pinnedPaths.has(runtime.sessionFile) ? pinnedRows : otherRows).push(row);
  }

  for (const session of recent) {
    const row = document.createElement("div");
    row.className = "row recent";
    row.dataset.cwd = session.cwd;
    row.title = `${session.cwd}\n${session.path}`;
    const name = rowName(session.title || session.cwd, null);
    const sub = document.createElement("span");
    sub.className = "sub";
    const rel = document.createElement("span");
    rel.className = "time";
    rel.textContent = sessionRelative(session.updatedAt);
    const cwdEl = document.createElement("span");
    cwdEl.className = "cwd";
    cwdEl.textContent = session.cwd.split("/").filter(Boolean).pop() ?? "/";
    sub.append(rel);
    if (!folderView) sub.append(cwdEl);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(pinButton(session));
    row.append(name, sub, actions);
    row.addEventListener("click", () => {
      const pane = focusedPane();
      if (pane) void openSession(pane, session);
    });
    wireSessionDrag(row, { kind: "session", path: session.path, cwd: session.cwd, title: session.title });
    (pinnedPaths.has(session.path) ? pinnedRows : otherRows).push(row);
  }
  if (folderView) {
    for (const row of [...pinnedRows, ...otherRows]) {
      const cwd = row.dataset.cwd!;
      const rows = folders.get(cwd) ?? [];
      folders.set(cwd, rows);
      rows.push(row);
    }
    for (const [cwd, rows] of folders) {
      const folder = document.createElement("div");
      folder.className = "sidebar-folder";
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "folder-heading";
      heading.dataset.cwd = cwd;
      heading.title = cwd;
      const expanded = sidebarFolderExpanded(cwd);
      heading.setAttribute("aria-expanded", String(expanded));
      const marker = document.createElement("span");
      marker.className = "folder-marker";
      marker.textContent = expanded ? "▾" : "▸";
      marker.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "folder-label";
      label.textContent = cwd.replace(/^\/home\/[^/]+/, "~") || "(unknown folder)";
      heading.append(marker, label);
      const contents = document.createElement("div");
      contents.className = "folder-sessions";
      contents.id = `sidebar-folder-${sessionListEl.childElementCount}`;
      heading.setAttribute("aria-controls", contents.id);
      contents.hidden = !expanded;
      contents.append(...rows);
      heading.addEventListener("click", () => {
        toggleSidebarFolder(cwd);
        for (const button of sessionListEl.querySelectorAll<HTMLButtonElement>(".folder-heading")) {
          if (button.dataset.cwd === cwd) button.focus();
        }
      });
      folder.append(heading, contents);
      sessionListEl.append(folder);
    }
  } else {
    sessionListEl.append(...pinnedRows, ...otherRows);
  }
  // New rows bring new spinner/shimmer nodes: the loop is only alive while one
  // of them paints.
  syncWorkingAnimation();
}

function focusedPane(): Pane | null {
  const id = layout.focused ?? leaves()[0];
  return id ? (panes.get(id) ?? null) : null;
}

async function killRuntime(id: string): Promise<void> {
  // An explicit stop: the pane keeps its transcript identity but must not be
  // resumed by a later app start, even if the daemon restarts afterwards.
  for (const pane of panes.values()) {
    if (pane.binding.runtimeId === id) pane.clearLiveIntent();
  }
  await getJson(`/api/runtimes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshRuntimes();
}

async function newSession(pane: Pane): Promise<void> {
  const { runtime } = await requestRuntime({});
  if (!runtime) return;
  pane.bind(bindingForRuntime(runtime, daemonId, displayTitle(runtime)));
  pane.focus();
}

/** Attach a saved session to a pane: reuse an attachable runtime for it if one exists, else resume. */
async function openSession(pane: Pane, session: { path: string; cwd: string; title: string }): Promise<void> {
  const live = runtimes.find((runtime) => attachable(runtime) && runtime.sessionFile === session.path);
  if (live) {
    pane.bind(bindingForRuntime(live, daemonId, session.title));
    pane.focus();
    return;
  }
  setStatus("resuming…", "idle");
  const { runtime } = await requestRuntime({ resume: session.path, cwd: session.cwd });
  if (!runtime) return;
  // Keep the requested transcript as the runtime's identity until omp sniffs
  // its own: a second click must adopt this runtime, not spawn a sibling.
  if (!runtime.sessionFile) runtime.sessionFile = session.path;
  pane.bind(bindingForRuntime(runtime, daemonId, session.title));
  pane.focus();
}

// ---------------------------------------------------------------- restoration

/** When each transcript was last asked to reopen, to space retries of transient failures. */
const resumeAttempts = new Map<string, number>();
/** Transient failures (capacity, transport) are retried no sooner than this. */
const RESUME_RETRY_MS = 15_000;
let restoring = false;

/**
 * Reopen every transcript a pane claims live but no runtime is writing. Panes
 * keep that claim across a daemon restart (the only way their runtime can be
 * lost without a stop), so this runs once the boot document is in memory and on
 * every later refresh: a daemon that went away and came back puts formerly live
 * sessions back on a live process instead of a "not running" placeholder.
 * Transcripts another pane (or another client) already has live are adopted,
 * never duplicated.
 *
 * This is pane reattachment and legacy workspace migration. The daemon restores
 * its complete durable pool before serving runtime requests, including sessions
 * with no pane or client open; its transcript-level dedupe also covers this path.
 */
async function restoreWantedSessions(): Promise<void> {
  if (!daemonUp || restoring) return;
  const wanted = pendingResumes([...panes.values()].map((pane) => pane.binding), runtimes);
  if (wanted.length === 0) return;
  restoring = true;
  try {
    for (const { sessionFile, live } of wanted) {
      const group = (): Pane[] =>
        [...panes.values()].filter((pane) =>
          pane.binding.autoResume && pane.binding.runtimeId === null && pane.binding.sessionFile === sessionFile,
        );
      if (group().length === 0) continue;
      if (live) {
        for (const pane of group()) pane.bind(bindingForRuntime(live, daemonId, displayTitle(live)));
        continue;
      }
      const last = resumeAttempts.get(sessionFile) ?? 0;
      if (Date.now() - last < RESUME_RETRY_MS) continue;
      resumeAttempts.set(sessionFile, Date.now());
      const summary = sessionSummary(sessionFile);
      setStatus(`resuming ${summary?.title ?? sessionFile}…`, "idle");
      const { runtime, status } = await requestRuntime({ resume: sessionFile, cwd: summary?.cwd ?? "" }, false);
      if (runtime) {
        resumeAttempts.delete(sessionFile);
        if (!runtime.sessionFile) runtime.sessionFile = sessionFile;
        for (const pane of group()) {
          pane.bind(bindingForRuntime(runtime, daemonId, summary?.title ?? displayTitle(runtime)));
        }
      } else if (status === 400) {
        // The daemon refuses the transcript itself (gone, or not under the
        // session store): stop claiming it is live. The placeholder keeps a
        // manual resume in case the file comes back.
        resumeAttempts.delete(sessionFile);
        for (const pane of group()) pane.clearLiveIntent();
      }
    }
  } finally {
    restoring = false;
  }
}

/**
 * Give live runtimes no pane claims a view, so a pool restored by the daemon
 * reappears as the grid it was instead of only as sidebar entries — including
 * sessions whose pane document was lost (an emptied binding has no transcript
 * left to resume, but the daemon's ledger still has the session). Runtimes
 * whose transcript is claimed by any pane are left for that pane, even while
 * its resume is still in flight; panes with a session (or a runtime), and
 * explicitly closed placeholders, are never overwritten.
 */
function adoptUnclaimedRuntimes(): void {
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
      !pane.binding.runtimeId && !pane.binding.sessionFile && !pane.binding.keepEmpty);
    if (!empty) return;
    empty.bind(bindingForRuntime(runtime, daemonId, displayTitle(runtime)));
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

function workspaceStateDoc(): unknown {
  return {
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    layout: workspaceLayoutDocument(),
    pins: pinnedSessions,
    cellSize,
    sidebar: localStorage.getItem(SIDEBAR_KEY),
  };
}

/**
 * Mirror the workspace to the daemon's state file (durable) while browser storage
 * stays the fast cache. Serialized: a save during a PUT queues one follow-up, so
 * the document that lands on disk is the last one, not an earlier one. A failure
 * stays visible in the status chip until the next state change persists it.
 */
function queueStateSave(): void {
  if (stateDelivering) {
    stateQueued = true;
    return;
  }
  void deliverState();
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
  try {
    do {
      stateQueued = false;
      const fingerprint = JSON.stringify({
        layout: workspaceLayoutDocument(),
        pins: pinnedSessions,
        cellSize,
        sidebar: localStorage.getItem(SIDEBAR_KEY),
      });
      if (fingerprint === deliveredState && !stateSaveError) break;
      const body = JSON.stringify(workspaceStateDoc());
      const bodyBytes = new TextEncoder().encode(body).length;
      if (bodyBytes > STATE_LIMIT_BYTES) {
        stateSaveError = `workspace state is too large to save (${Math.ceil(bodyBytes / 1024)} KiB)`;
        setStatus(stateSaveError, "warn");
        break;
      }
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(detail || `HTTP ${res.status}`);
      }
      deliveredState = fingerprint;
      if (stateSaveError) {
        stateSaveError = null;
        setStatus("workspace state saved", "ok");
      }
    } while (stateQueued);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `workspace state not saved: ${detail}`;
    if (stateSaveError !== message) {
      stateSaveError = message;
      console.warn("omp-desktop:", message, error);
      setStatus(message, "warn");
    }
  } finally {
    stateDelivering = false;
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
  const payload = parseStateResponse(await getJson("/api/state"));
  if (payload === null) {
    // Unreadable copy: publishing stays closed so fallback state cannot replace it.
    stateGate = "blocked";
    stateGateReason = "the daemon's saved workspace could not be read";
    return;
  }
  if (payload.kind === "unsupported") {
    // A newer document must not be overwritten by this build either.
    stateGate = "blocked";
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
    return;
  }
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
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

// Ctrl/Cmd +/-/0 zooms the cell (browser zoom is suppressed). Persisted so a size
// dialed in against the real terminal survives reloads.
function setCellSize(size: number): void {
  cellSize = Math.min(CELL_MAX, Math.max(CELL_MIN, size));
  try {
    localStorage.setItem(CELL_KEY, String(cellSize));
  } catch {
    console.warn("omp-desktop: font size cannot be cached in browser storage");
  }
  for (const id of leaves()) {
    const pane = panes.get(id);
    pane?.fitPane();
    pane?.sendResize(true);
  }
  queueStateSave();
}

window.addEventListener("keydown", (event) => {
  const key = event.key;
  if (event.ctrlKey || event.metaKey) {
    if (key === "=" || key === "+") setCellSize(cellSize + 1);
    else if (key === "-" || key === "_") setCellSize(cellSize - 1);
    else if (key === "0") setCellSize(CELL_SIZE);
    else if (event.shiftKey && (key === "E" || key === "e")) splitLayout();
    else if (event.shiftKey && (key === "X" || key === "x")) closePane(layout.focused ?? "");
    else return;
    event.preventDefault();
    return;
  }
  if (event.altKey && /^[1-4]$/.test(key)) {
    const id = leaves()[Number(key) - 1];
    if (id) {
      panes.get(id)?.focus();
      event.preventDefault();
    }
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
void checkBuild();
window.setInterval(() => void checkBuild(), 10_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void checkBuild();
});

async function boot(): Promise<void> {
  // Adoption may rebuild the panes from the daemon's document, so restoration
  // waits for it instead of racing the first refresh.
  const reachable = await refreshRuntimes({ restore: false });
  await refreshSessions();
  if (reachable) {
    await reconcileWorkspaceState();
    const bound = [...panes.values()].some((pane) => pane.binding.runtimeId);
    // First run only when nothing was ever stored, and only after the daemon's
    // copy was read (or proven absent). A restored workspace whose runtimes are
    // gone must keep its session files: replacing the focused pane with a fresh
    // session is exactly how a reboot used to lose the workspace.
    const stored = [...panes.values()].some(
      (pane) => pane.binding.runtimeId || pane.binding.sessionFile || pane.binding.title,
    );
    if (!bound && runtimes.length === 0 && !stored && stateGate === "ready") {
      const pane = focusedPane();
      if (pane) await newSession(pane);
    } else {
      for (const pane of panes.values()) pane.syncFromRuntimes();
      // Panes that were live when the workspace was saved and lost their runtime
      // with a daemon restart reopen their transcripts here.
      await restoreWantedSessions();
      // Fresh profile or cleared storage next to a restored pool: bind every
      // runtime no pane claims to an empty pane (a reserved runtime starts on
      // the attach this adopts), and keep watching while the daemon restores
      // the rest of its pool after this boot.
      adoptPending = true;
      adoptSeen = runtimes.length;
      adoptUnclaimedRuntimes();
    }
  } else {
    // Nothing was read, so nothing may be published: this browser's fallback
    // must never replace a daemon copy it could not see.
    stateGate = "blocked";
    stateGateReason = "daemon unreachable at startup";
    setStatus("daemon unreachable", "warn");
  }
  const pane = focusedPane();
  pane?.focus();
  window.setInterval(() => void refreshRuntimes(), 2500);
  window.setInterval(() => void refreshSessions(), 30_000);
}
void boot();
