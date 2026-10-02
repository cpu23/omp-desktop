import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import type { ServerMessage } from "./protocol";

const statusEl = document.getElementById("status") as HTMLElement;
const sessionEl = document.getElementById("session") as HTMLElement;
const host = document.getElementById("term") as HTMLElement;

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  scrollback: 20_000,
  fontSize: 13,
  fontFamily: '"DejaVu Sans Mono", ui-monospace, SFMono-Regular, monospace',
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
fit.fit();
term.focus();
host.addEventListener("mousedown", () => term.focus());

let ws: WebSocket | null = null;

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
