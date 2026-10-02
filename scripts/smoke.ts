/**
 * P0 smoke test: daemon + one PTY + one pane.
 *
 * Phase A proves the full loop (input -> PTY -> output -> websocket) with bash,
 * so the assertion cannot be confused with omp's own output.
 * Phase B proves the real thing: omp paints its TUI through the daemon, the
 * reported pid is really omp, resize reaches the PTY, and daemon exit reaps it.
 *
 * Run: bun run smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.OMP_DESKTOP_SMOKE_PORT ?? 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/term`;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function startDaemon(env: Record<string, string>): Promise<Bun.Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "daemon.ts")], {
    cwd: ROOT,
    env: { ...process.env, OMP_DESKTOP_PORT: String(PORT), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(150);
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`daemon failed to start: ${stderr.slice(0, 2000)}`);
}

async function stopDaemon(proc: Bun.Subprocess): Promise<void> {
  proc.kill("SIGTERM");
  await proc.exited;
}

/** Resolves when the socket is open; collects binary output into `sink`. */
function openTerminal(sink?: (bytes: number) => void): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  const timer = setTimeout(() => reject(new Error("websocket open timeout")), 10_000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve(ws);
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reject(new Error("websocket error"));
  };
  if (sink) {
    let total = 0;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") return;
      total += (event.data as ArrayBuffer).byteLength;
      sink(total);
    };
  }
  return promise;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`FAIL: timeout waiting for ${label}`);
}

async function bashRoundTrip(): Promise<void> {
  const proc = await startDaemon({
    OMP_DESKTOP_OMP: "/bin/bash",
    OMP_DESKTOP_OMP_ARGS: "-i",
    OMP_DESKTOP_CWD: tmpdir(),
    OMP_DESKTOP_OVERLAY: "",
  });
  try {
    const chunks: string[] = [];
    const ws = await openTerminal();
    ws.onmessage = (event) => {
      if (typeof event.data === "string") return;
      chunks.push(new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer)));
    };
    // The literal below is echoed back by the shell; only the formatted output
    // ("SMOKE_OK") proves the bytes made it through the PTY and back.
    ws.send(JSON.stringify({ type: "input", data: "printf 'SMOKE_%s\\n' OK\r" }));
    await waitFor(() => chunks.join("").includes("SMOKE_OK"), 10_000, "bash echo round-trip");
    assert(true, "typed input round-trips through the PTY");
    ws.close();
  } finally {
    await stopDaemon(proc);
  }
}

async function ompFirstFrame(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "omp-desktop-smoke-"));
  const proc = await startDaemon({ OMP_DESKTOP_CWD: cwd });
  let pid: number | null = null;
  try {
    let bytes = 0;
    const text: string[] = [];
    const decoder = new TextDecoder();
    const ws = await openTerminal((total) => {
      bytes = total;
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        text.push(decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true }));
      }
    });
    await waitFor(() => bytes >= 200, 25_000, "omp TUI output");
    assert(bytes >= 200, `omp painted its TUI through the daemon (${bytes} bytes)`);

    // The app's overlay sets symbolPreset=nerd, so the status line carries
    // private-use icons instead of Unicode symbols/emoji (which fall back to
    // proportional fonts and clip in a terminal cell).
    await waitFor(
      () => /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/u.test(text.join("")),
      25_000,
      "nerd-font glyph in omp output",
    );
    assert(true, "omp renders private-use (nerd font) glyphs from the app overlay");

    type State = { runtime: { pid: number | null; cols: number; rows: number } };
    const state = (await (await fetch(`${BASE}/api/state`)).json()) as State;
    pid = state.runtime.pid;
    assert(typeof pid === "number" && pid > 1, `daemon reports the runtime pid (${pid})`);
    const comm = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)]).stdout.toString().trim();
    assert(comm.includes("omp"), `pid ${pid} is an omp process (comm=${comm})`);

    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await Bun.sleep(400);
    const resized = (await (await fetch(`${BASE}/api/state`)).json()) as {
      runtime: { cols: number; rows: number };
    };
    assert(resized.runtime.cols === 100 && resized.runtime.rows === 30, "resize reaches the PTY");
    ws.close();
  } finally {
    await stopDaemon(proc);
    rmSync(cwd, { recursive: true, force: true });
  }

  assert(typeof pid === "number", "runtime pid captured for the orphan check");
  let alive = true;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && alive) {
    alive = Bun.spawnSync(["ps", "-p", String(pid)]).exitCode === 0;
    if (alive) await Bun.sleep(200);
  }
  assert(!alive, `daemon exit reaped the omp child (pid ${pid})`);
}

console.log("smoke: omp-desktopd + PTY + one pane");
await bashRoundTrip();
await ompFirstFrame();
console.log("SMOKE PASSED");
