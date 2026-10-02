import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import type { ServerMessage } from "./protocol";

const statusEl = document.getElementById("status") as HTMLElement;
const sessionEl = document.getElementById("session") as HTMLElement;
const buildEl = document.getElementById("build");
const host = document.getElementById("term") as HTMLElement;

// Cell geometry mirrors the Konsole profile these sessions normally run in: Hack
// (Konsole's font is QFontDatabase::systemFont(FixedFont); both running Konsole
// processes have Hack-Regular.ttf mapped) at 10pt = 13.33px, plus Konsole
// LineSpacing=3, which its TerminalFont adds as pixels on top of the font height.
// "JetBrainsMono Nerd Font Mono" (PUA-only via unicode-range) supplies omp's
// nerd-preset icons at exactly one cell wide. Tune the terminal look here, nowhere
// else.
const CELL_SIZE = 13.33;
const CELL_LINE_HEIGHT = 1.4;
const CELL_MIN = 8;
const CELL_MAX = 28;
const CELL_KEY = "omp-desktop.cellSize";
const FONT_STACK =
  '"Hack", "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", ui-monospace, SFMono-Regular, monospace';

function storedCellSize(): number {
  const raw = Number(localStorage.getItem(CELL_KEY));
  return Number.isFinite(raw) && raw >= CELL_MIN && raw <= CELL_MAX ? raw : CELL_SIZE;
}
let cellSize = storedCellSize();

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  scrollback: 20_000,
  fontSize: cellSize,
  lineHeight: CELL_LINE_HEIGHT,
  fontFamily: FONT_STACK,
  theme: {
    background: "#101014",
    foreground: "#e8e8ec",
    cursor: "#7dd3fc",
    selectionBackground: "#3b4252",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new ImageAddon());
term.open(host);
host.addEventListener("mousedown", () => term.focus());

// Never fit against fallback metrics: a pre-font fit leaves the bottom rows
// clipped once the real cell height lands.
const fontsReady = Promise.all(
  ["Hack", "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono"].map((family) =>
    document.fonts.load(`${cellSize}px "${family}"`),
  ),
);
document.fonts.addEventListener("loadingdone", () => {
  fit.fit();
  sendResize();
});
void fontsReady.then(() => {
  fit.fit();
  sendResize(true);
  term.focus();
  // A silent fallback to a non-mono face is what makes icons clip and drift, so
  // surface it instead of rendering a mystery.
  if (!document.fonts.check(`${cellSize}px "JetBrainsMono Nerd Font Mono"`, "\u{F1157}")) {
    setStatus("icon font missing", "warn");
    console.warn("omp-desktop: icon font did not load; omp's nerd icons will fall back to a non-mono face");
  }
});

// Ctrl/Cmd +/-/0 zooms the cell (browser zoom is suppressed). Persisted so a size
// dialed in against the real terminal survives reloads.
function setCellSize(size: number): void {
  cellSize = Math.min(CELL_MAX, Math.max(CELL_MIN, size));
  localStorage.setItem(CELL_KEY, String(cellSize));
  term.options.fontSize = cellSize;
  fit.fit();
  sendResize();
}

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key;
  if (key === "=" || key === "+") setCellSize(cellSize + 1);
  else if (key === "-" || key === "_") setCellSize(cellSize - 1);
  else if (key === "0") setCellSize(CELL_SIZE);
  else return;
  event.preventDefault();
});

let ws: WebSocket | null = null;

// The daemon serves the bundle with no-store and publishes its hash here; a tab
// holding an older bundle reloads itself, so stale code cannot masquerade as
// "nothing changed" after a daemon restart.
let loadedBuild = "";
async function checkBuild(): Promise<void> {
  try {
    const res = await fetch("/api/build", { cache: "no-store" });
    const { build } = (await res.json()) as { build: string };
    if (!loadedBuild) {
      loadedBuild = build;
      if (buildEl) buildEl.textContent = build;
      return;
    }
    if (build !== loadedBuild) location.reload();
  } catch {
    // daemon restarting: the websocket reconnect path reports that
  }
}
window.setInterval(() => void checkBuild(), 10_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void checkBuild();
});
void checkBuild();

function setStatus(text: string, kind: "ok" | "warn" | "idle"): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function sendResize(force = false): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (!force && term.cols === lastCols && term.rows === lastRows) return;
  lastCols = term.cols;
  lastRows = term.rows;
  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}
let lastCols = -1;
let lastRows = -1;

function handleControl(raw: string): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    return;
  }
  if (msg.type === "hello") {
    sessionEl.textContent = msg.runtime.pid ? `main · pid ${msg.runtime.pid}` : "main";
    return;
  }
  if (msg.type === "exit") {
    setStatus(`session exited (${msg.exitCode ?? "?"})`, "warn");
  }
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws/term`);
  socket.binaryType = "arraybuffer";
  ws = socket;
  setStatus("connecting…", "idle");
  socket.onopen = () => {
    setStatus("attached", "ok");
    sendResize(true);
    term.focus();
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleControl(event.data);
      return;
    }
    term.write(new Uint8Array(event.data as ArrayBuffer));
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setStatus("reconnecting…", "warn");
    window.setTimeout(connect, 1000);
  };
}

term.onData((data) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
});

let resizeTimer: number | undefined;
const observer = new ResizeObserver(() => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    fit.fit();
    sendResize();
  }, 80);
});
observer.observe(host);

connect();
