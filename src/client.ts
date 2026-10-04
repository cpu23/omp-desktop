import { trimSelectionHighlight } from "./selection";
import { applySidebarState, onSidebarStateChange, STORE_KEY as SIDEBAR_KEY } from "./sidebar";
import { Terminal } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { isRecord } from "./guards";
import {
  parsePasteResponse,
  parseRuntimeList,
  parseRuntimeOne,
  parseServerMessage,
  parseSessionList,
  parseStateResponse,
  type RuntimeInfo,
  type SessionSummaryLike,
} from "./protocol";

// Sidebar width/collapse is workspace state; the sidebar announces settled
// changes so they take the same durable-save path as panes, pins and font size.
onSidebarStateChange(() => queueStateSave());

const statusEl = document.getElementById("status") as HTMLElement;
const buildEl = document.getElementById("build") as HTMLElement;
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
const STATE_VERSION = 1;
/** Keep in sync with src/state.ts so an oversized document fails before the wire. */
const STATE_LIMIT_BYTES = 1024 * 1024;
const MAX_PANES = 4;
/** Divider drag clamp; the stored-layout reader accepts 0.1..0.9, so stay inside it. */
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const FONT_STACK =
  '"Hack", "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", ui-monospace, SFMono-Regular, monospace';

function storedCellSize(): number {
  const raw = Number(localStorage.getItem(CELL_KEY));
  return Number.isFinite(raw) && raw >= CELL_MIN && raw <= CELL_MAX ? raw : CELL_SIZE;
}
let cellSize = storedCellSize();

/** Persisted per pane: which runtime it shows, plus labels for when that runtime is gone. */
type PaneBinding = { runtimeId: string | null; title: string | null; sessionFile: string | null };
type LayoutNode =
  | { kind: "leaf"; pane: string }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };
type StoredLayout = { tree: LayoutNode; panes: Record<string, PaneBinding>; focused: string | null };

const panes = new Map<string, Pane>();
let layout: StoredLayout = { tree: { kind: "leaf", pane: "p1" }, panes: {}, focused: "p1" };
/** True when the current panes came from a stored document (browser or daemon). */
let restoredLocal = false;
let runtimes: RuntimeInfo[] = [];
let sessions: SessionSummaryLike[] = [];
let daemonUp = false;

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

document.addEventListener("dragstart", () => {
  dragging = true;
});
document.addEventListener("dragend", () => {
  dragging = false;
  if (renderPending) renderSidebar();
});

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

async function refreshRuntimes(): Promise<boolean> {
  const list = parseRuntimeList(await getJson("/api/runtimes"));
  if (!list) {
    daemonUp = false;
    renderSidebar();
    return false;
  }
  daemonUp = true;
  runtimes = list;
  const live = new Set(runtimes.map((runtime) => runtime.id));
  for (const pane of panes.values()) {
    // A runtime that vanished (killed here, crashed, daemon restarted) leaves the
    // pane's screen as it was, labelled so it is obvious the process is gone.
    if (pane.binding.runtimeId && !live.has(pane.binding.runtimeId)) {
      pane.runtimeGone();
    }
  }
  renderSidebar();
  for (const pane of panes.values()) pane.syncFromRuntimes();
  setStatus(`${runtimes.length} live`, "ok");
  return true;
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

async function createRuntime(request: { cwd?: string; resume?: string }): Promise<RuntimeInfo | null> {
  const runtime = parseRuntimeOne(
    await getJson("/api/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  if (!runtime) return null;
  runtimes = [...runtimes.filter((candidate) => candidate.id !== runtime.id), runtime];
  renderSidebar();
  return runtime;
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

  constructor(id: string, binding: PaneBinding) {
    this.id = id;
    this.binding = binding;
    this.el = document.createElement("section");
    this.el.className = "pane";
    this.el.dataset.pane = id;

    const header = document.createElement("header");
    header.className = "pane-header";
    header.draggable = true;
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

    header.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/omp-payload", JSON.stringify({ kind: "pane", paneId: this.id }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    this.#wireDrop();
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
      const raw = event.dataTransfer?.getData("text/omp-payload");
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.kind !== "string") return;
      if (parsed.kind === "pane" && typeof parsed.paneId === "string") {
        swapPanes(parsed.paneId, this.id);
      } else if (parsed.kind === "runtime" && typeof parsed.runtimeId === "string") {
        const runtime = runtimes.find((candidate) => candidate.id === parsed.runtimeId);
        if (runtime) {
          this.bind({ runtimeId: runtime.id, title: displayTitle(runtime), sessionFile: runtime.sessionFile });
        }
      } else if (
        parsed.kind === "session" &&
        typeof parsed.path === "string" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.title === "string"
      ) {
        void openSession(this, { path: parsed.path, cwd: parsed.cwd, title: parsed.title });
      }
    });
  }

  focus(): void {
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
      this.sendResize(true);
      this.fitPane();
      if (layout.focused === this.id) this.term.focus();
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
      // Persist the sniffed session file: it is what "resume this session" and
      // the restart guard in syncFromRuntimes match on.
      save();
    } else if (msg.type === "exit") {
      this.#stateEl.textContent = `exited ${msg.exitCode ?? "?"}`;
    }
  }

  runtimeGone(): void {
    this.detach();
    // Drop the id but keep the title/session file: the placeholder then offers
    // "resume this session" instead of a frozen screen with no way back.
    this.binding.runtimeId = null;
    this.#stateEl.textContent = "exited";
    this.renderHeader();
    this.renderPlaceholder();
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
    const runtime = runtimeId ? runtimes.find((candidate) => candidate.id === runtimeId) : undefined;
    if (runtime) {
      // Check the persisted transcript identity before reattaching a pane.
      const sameSession =
        !this.binding.sessionFile ||
        !runtime.sessionFile ||
        runtime.sessionFile === this.binding.sessionFile;
      if (sameSession) {
        this.#stateEl.textContent = "";
        const title = displayTitle(runtime);
        // omp emits the session file after the hello: adopt it late, or a reload
        // cannot tell which session this pane was showing.
        const adoptFile = runtime.sessionFile && !this.binding.sessionFile ? runtime.sessionFile : null;
        if (title !== this.binding.title || adoptFile) {
          if (adoptFile) this.binding.sessionFile = adoptFile;
          this.binding.title = title;
          this.renderHeader();
          save();
        }
        if (!this.ws && this.retry !== Number.POSITIVE_INFINITY) this.attach();
      } else if (!this.ws) {
        this.runtimeGone();
      }
    }
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
  const shown = new Set([...panes.values()].map((pane) => pane.binding.runtimeId));
  const split = (node: LayoutNode, dir: "row" | "col"): LayoutNode => {
    if (node.kind !== "leaf") return node;
    const candidate = runtimes.find((runtime) => !shown.has(runtime.id));
    if (candidate) shown.add(candidate.id);
    const fresh = newPane(
      candidate
        ? { runtimeId: candidate.id, title: displayTitle(candidate), sessionFile: candidate.sessionFile }
        : { runtimeId: null, title: null, sessionFile: null },
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
  if (leaves().length <= 1) {
    pane.detach();
    pane.binding = { runtimeId: null, title: null, sessionFile: null };
    pane.renderPlaceholder();
    pane.renderHeader();
    save();
    return;
  }
  // The runtime is not killed: panes are views, the pool owns processes.
  const sibling = removeLeaf(layout.tree, paneId);
  if (!sibling) return;
  layout.tree = gridLayout(sibling.tree);
  panes.delete(paneId);
  delete layout.panes[paneId];
  pane.destroy();
  if (layout.focused === paneId) layout.focused = leaves(sibling.tree)[0] ?? null;
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
  for (const pane of panes.values()) {
    pane.renderHeader();
    pane.renderPlaceholder();
    window.setTimeout(() => pane.fitPane(), 0);
  }
  for (const pane of panes.values()) {
    if (!ids.includes(pane.id)) panes.delete(pane.id);
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
    for (const pane of panes.values()) {
      pane.fitPane();
      pane.sendResize(true);
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

function renderSidebar(): void {
  // Rebuilding rows mid-drag cancels the drag the user is performing.
  if (dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  sessionListEl.replaceChildren();

  const query = searchEl.value.trim().toLowerCase();
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
    row.className = runtime.alive ? "row live" : "row recent";
    row.draggable = true;
    row.title = `${cwd}\n${runtime.sessionFile ?? "(session file not known yet)"}\n${runtime.id}`;
    const ownerId = paneForRuntime.get(runtime.id);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = title;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = ownerId ? ownerId.replace("p", "pane ") : cwd.replace(/^\/home\/[^/]+/, "~");
    const kill = document.createElement("button");
    kill.className = "kill";
    kill.textContent = "✕";
    kill.title = "Stop this session";
    kill.addEventListener("click", (event) => {
      event.stopPropagation();
      void killRuntime(runtime.id);
    });
    const snapshot = runtime.sessionFile
      ? summary ?? {
        id: runtime.id, path: runtime.sessionFile, cwd,
        title, updatedAt: runtime.lastActivity ?? runtime.startedAt ?? new Date().toISOString(),
        costUsd: 0,
      }
      : null;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(pinButton(snapshot), kill);
    row.append(name, sub, actions);
    row.addEventListener("click", () => {
      const pane = focusedPane();
      if (pane) pane.bind({ runtimeId: runtime.id, title: displayTitle(runtime), sessionFile: runtime.sessionFile });
    });
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/omp-payload", JSON.stringify({ kind: "runtime", runtimeId: runtime.id }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    (runtime.sessionFile && pinnedPaths.has(runtime.sessionFile) ? pinnedRows : otherRows).push(row);
  }

  for (const session of recent) {
    const row = document.createElement("div");
    row.className = "row recent";
    row.draggable = true;
    row.title = `${session.cwd}\n${session.path}`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = session.title || session.cwd;
    const sub = document.createElement("span");
    sub.className = "sub";
    const rel = document.createElement("span");
    rel.className = "time";
    rel.textContent = sessionRelative(session.updatedAt);
    const cwdEl = document.createElement("span");
    cwdEl.className = "cwd";
    cwdEl.textContent = session.cwd.split("/").filter(Boolean).pop() ?? "/";
    sub.append(rel, cwdEl);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(pinButton(session));
    row.append(name, sub, actions);
    row.addEventListener("click", () => {
      const pane = focusedPane();
      if (pane) void openSession(pane, session);
    });
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(
        "text/omp-payload",
        JSON.stringify({ kind: "session", path: session.path, cwd: session.cwd, title: session.title }),
      );
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    (pinnedPaths.has(session.path) ? pinnedRows : otherRows).push(row);
  }
  sessionListEl.append(...pinnedRows, ...otherRows);
}

function focusedPane(): Pane | null {
  const id = layout.focused ?? leaves()[0];
  return id ? (panes.get(id) ?? null) : null;
}

async function killRuntime(id: string): Promise<void> {
  await getJson(`/api/runtimes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshRuntimes();
}

async function newSession(pane: Pane): Promise<void> {
  const runtime = await createRuntime({});
  if (!runtime) return;
  pane.bind({ runtimeId: runtime.id, title: displayTitle(runtime), sessionFile: runtime.sessionFile });
  pane.focus();
}

/** Attach a saved session to a pane: reuse its live runtime if one exists, else resume. */
async function openSession(pane: Pane, session: { path: string; cwd: string; title: string }): Promise<void> {
  const live = runtimes.find((runtime) => runtime.sessionFile === session.path);
  if (live) {
    pane.bind({ runtimeId: live.id, title: session.title, sessionFile: live.sessionFile });
    pane.focus();
    return;
  }
  setStatus("resuming…", "idle");
  const runtime = await createRuntime({ resume: session.path, cwd: session.cwd });
  if (!runtime) return;
  runtime.sessionFile = session.path;
  pane.bind({ runtimeId: runtime.id, title: session.title, sessionFile: session.path });
  pane.focus();
}

// ---------------------------------------------------------------- persistence

function save(): void {
  layout.panes = {};
  for (const [id, pane] of panes) layout.panes[id] = pane.binding;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    console.warn("omp-desktop: workspace layout cannot be cached in browser storage");
    setStatus("Browser storage unavailable — workspace is kept on the daemon only", "warn");
  }
  queueStateSave();
}

/** Everything a restart or a cleared browser profile needs to rebuild the workspace. */
function workspaceStateDoc(): unknown {
  return {
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    layout,
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
        layout,
        pins: pinnedSessions,
        cellSize,
        sidebar: localStorage.getItem(SIDEBAR_KEY),
      });
      if (fingerprint === deliveredState) break;
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
      const stored = parseStoredLayout(state.layout);
      if (stored && applyStoredLayout(stored)) {
        restoredLocal = true;
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
    const remoteSidebar = typeof state.sidebar === "string" && state.sidebar.length <= 4096 ? state.sidebar : null;
    if (remoteSidebar && localStorage.getItem(SIDEBAR_KEY) === null) {
      try {
        applySidebarState(JSON.parse(remoteSidebar));
      } catch {
        // A malformed sidebar cache only costs the preferred width; ignore it.
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
    if (!isRecord(entry)) continue;
    storedPanes[id] = {
      runtimeId: typeof entry.runtimeId === "string" ? entry.runtimeId : null,
      title: typeof entry.title === "string" ? entry.title : null,
      sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : null,
    };
  }
  return { tree, panes: storedPanes, focused: typeof value.focused === "string" ? value.focused : null };
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

/** Rebuilds the pane grid from a stored document; false when it has no usable leaf. */
function applyStoredLayout(stored: StoredLayout): boolean {
  const tree = gridLayout(stored.tree);
  const ids = leaves(tree);
  if (!ids.length) return false;
  for (const pane of panes.values()) pane.destroy();
  panes.clear();
  layout = {
    tree,
    panes: stored.panes,
    focused: stored.focused && ids.includes(stored.focused) ? stored.focused : ids[0],
  };
  for (const id of ids) {
    const numeric = Number(id.replace(/\D/g, ""));
    if (Number.isFinite(numeric)) paneSeq = Math.max(paneSeq, numeric);
    newPane(stored.panes[id] ?? { runtimeId: null, title: null, sessionFile: null }, id);
  }
  renderLayout();
  return true;
}

function load(): void {
  let stored: StoredLayout | null = null;
  try {
    stored = parseStoredLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    stored = null;
  }
  if (stored && applyStoredLayout(stored)) {
    restoredLocal = true;
    return;
  }
  const pane = newPane({ runtimeId: null, title: null, sessionFile: null });
  layout = { tree: { kind: "leaf", pane: pane.id }, panes: {}, focused: pane.id };
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
  for (const pane of panes.values()) {
    pane.fitPane();
    pane.sendResize(true);
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
let searchTimer: number | undefined;
searchEl.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refreshSessions(), 200);
});

// ---------------------------------------------------------------- boot

load();
renderLayout();
renderSidebar();
void checkBuild();
window.setInterval(() => void checkBuild(), 10_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void checkBuild();
});

async function boot(): Promise<void> {
  const reachable = await refreshRuntimes();
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
      // Fresh profile or cleared storage next to live sessions: without this the
      // panes render empty while the sidebar lists sessions already running.
      const claimed = new Set([...panes.values()].map((pane) => pane.binding.runtimeId));
      const adopted = [...runtimes].reverse().find((runtime) => !claimed.has(runtime.id));
      const empty = [...panes.values()].find(
        (pane) => !pane.binding.runtimeId && !pane.binding.sessionFile,
      );
      if (adopted && empty) {
        empty.bind({ runtimeId: adopted.id, title: displayTitle(adopted), sessionFile: adopted.sessionFile });
      }
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
