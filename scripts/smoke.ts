/**
 * Smoke test: daemon + PTY pool + panes.
 *
 * Phase A proves the byte loop (input -> PTY -> websocket -> output) with bash, so
 * the assertion cannot be confused with omp's own output.
 * Phase B proves the real thing: a real omp TUI paints through the daemon, reports
 * a real pid, and announces its session file over OSC 1337.
 * Phase C is the P1 acceptance: two live runtimes, panes rebound (swapped) between
 * them, and neither process restarts — same pids, same output streams.
 * Phase D exercises the session index behind the sidebar.
 * Phase E covers clipboard image paste: stored bytes, rejected types, empty bodies.
 *
 * Run: bun run smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/guards";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.OMP_DESKTOP_SMOKE_PORT ?? 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/term`;

type RuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cols: number;
  rows: number;
  bytesOut: number;
  cwd: string;
  sessionFile: string | null;
  title: string;
  status: string;
};

type SessionInfo = { id: string; path: string; title: string; cwd: string; costUsd: number };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

/** Boundary validation for this script: the daemon's JSON is `unknown` until checked. */
function runtimeFrom(value: unknown): RuntimeInfo {
  assert(isRecord(value), "runtime payload is an object");
  const { id, pid, cols, rows, bytesOut, cwd, sessionFile, title, status, alive } = value;
  assert(typeof id === "string", "runtime.id is a string");
  assert(pid === null || typeof pid === "number", "runtime.pid is a number or null");
  return {
    id,
    pid,
    cols: typeof cols === "number" ? cols : 0,
    rows: typeof rows === "number" ? rows : 0,
    bytesOut: typeof bytesOut === "number" ? bytesOut : 0,
    cwd: typeof cwd === "string" ? cwd : "",
    sessionFile: typeof sessionFile === "string" ? sessionFile : null,
    title: typeof title === "string" ? title : "",
    status: typeof status === "string" ? status : "idle",
    alive: alive === true,
  };
}

function sessionFrom(value: unknown): SessionInfo {
  assert(isRecord(value), "session payload is an object");
  const { id, path, title, cwd, costUsd } = value;
  assert(typeof id === "string" && typeof path === "string", "session has id and path");
  // The client rejects the whole session list if this field is missing, so the
  // contract is worth pinning: a number, never null, never negative.
  assert(typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0, "session has a finite non-negative costUsd");
  return {
    id,
    path,
    title: typeof title === "string" ? title : "",
    cwd: typeof cwd === "string" ? cwd : "",
    costUsd,
  };
}

async function startDaemon(env: Record<string, string>): Promise<Bun.Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "daemon.ts")], {
    env: { ...process.env, OMP_DESKTOP_PORT: String(PORT), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/build`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`daemon failed to start: ${stderr.slice(0, 2000)}`);
}

async function stopDaemon(proc: Bun.Subprocess): Promise<void> {
  proc.kill("SIGTERM");
  await proc.exited;
}

async function createRuntime(request: Record<string, unknown>): Promise<RuntimeInfo> {
  const res = await fetch(`${BASE}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert(res.ok, `POST /api/runtimes ${JSON.stringify(request)} -> ${res.status}`);
  const body: unknown = await res.json();
  assert(isRecord(body), "create response is an object");
  return runtimeFrom(body.runtime);
}

async function runtimes(): Promise<RuntimeInfo[]> {
  const res = await fetch(`${BASE}/api/runtimes`);
  assert(res.ok, "GET /api/runtimes");
  const body: unknown = await res.json();
  assert(isRecord(body) && Array.isArray(body.runtimes), "runtimes response has a list");
  return body.runtimes.map(runtimeFrom);
}

async function sessions(limit: number, search?: string): Promise<SessionInfo[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (search) query.set("search", search);
  const res = await fetch(`${BASE}/api/sessions?${query}`);
  assert(res.ok, "GET /api/sessions");
  const body: unknown = await res.json();
  assert(isRecord(body) && Array.isArray(body.sessions), "sessions response has a list");
  return body.sessions.map(sessionFrom);
}

type Pane = { text: () => string; send: (data: string) => void; close: () => void };

/** One pane: a websocket bound to a runtime, mirroring what the client does. */
async function attach(runtimeId: string): Promise<Pane> {
  const ws = new WebSocket(`${WS_URL}?runtime=${encodeURIComponent(runtimeId)}`);
  ws.binaryType = "arraybuffer";
  let out = "";
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) out += new TextDecoder().decode(new Uint8Array(event.data));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`websocket to ${runtimeId} failed`));
  });
  return {
    text: () => out,
    send: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
    close: () => ws.close(),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`FAIL: timed out waiting for ${label}`);
}

async function phaseA(dir: string): Promise<void> {
  console.log("\n-- Phase A: bash byte loop through the pool");
  const runtime = await createRuntime({ cwd: dir });
  const pane = await attach(runtime.id);
  const tag = `omp-smoke-${Date.now()}`;
  pane.send(`echo ${tag}\n`);
  await waitFor(() => pane.text().includes(tag), 10_000, `echo ${tag} round-trip`);
  assert(true, "input -> PTY -> output -> websocket round-trip");
  const listed = await runtimes();
  assert(listed.some((entry) => entry.id === runtime.id), "runtime shows up in /api/runtimes");
  pane.close();
}

async function phaseC(dir: string): Promise<void> {
  console.log("\n-- Phase C: P1 acceptance — swap two live sessions without restarting");
  const a = await createRuntime({ cwd: dir });
  const b = await createRuntime({ cwd: dir });
  const paneA = await attach(a.id);
  const paneB = await attach(b.id);
  paneA.send("echo AAA\n");
  paneB.send("echo BBB\n");
  await waitFor(() => paneA.text().includes("AAA") && !paneA.text().includes("BBB"), 10_000, "pane A own output");
  await waitFor(() => paneB.text().includes("BBB") && !paneB.text().includes("AAA"), 10_000, "pane B own output");
  const before = await runtimes();
  const pidA = before.find((entry) => entry.id === a.id)?.pid;
  const pidB = before.find((entry) => entry.id === b.id)?.pid;
  assert(typeof pidA === "number" && pidA !== pidB, `two distinct live processes (${pidA}, ${pidB})`);

  // The swap: each pane rebinds to the other runtime, exactly like dragging one
  // pane header onto the other in the UI. No process may restart.
  const swappedA = await attach(b.id);
  const swappedB = await attach(a.id);
  await waitFor(
    () => swappedA.text().includes("BBB") && swappedB.text().includes("AAA"),
    10_000,
    "replay after swap",
  );
  paneA.close();
  paneB.close();

  const after = await runtimes();
  assert(after.find((entry) => entry.id === a.id)?.pid === pidA, "runtime A kept its pid through the swap");
  assert(after.find((entry) => entry.id === b.id)?.pid === pidB, "runtime B kept its pid through the swap");

  swappedA.send("echo AAA\n");
  swappedB.send("echo BBB\n");
  await waitFor(
    () => swappedA.text().includes("AAA") && swappedB.text().includes("BBB"),
    10_000,
    "input on rebound panes",
  );
  assert(true, "both rebound panes still take input; pids unchanged");

  // Closing a pane must not kill the process: a pane is a view, the pool owns it.
  swappedA.close();
  swappedB.close();
  await Bun.sleep(300);
  assert((await runtimes()).length >= 2, "closing panes left both runtimes running");

  const killed = await fetch(`${BASE}/api/runtimes/${a.id}`, { method: "DELETE" });
  assert(killed.ok, "DELETE /api/runtimes/<id>");
  await waitFor(async () => !(await runtimes()).some((entry) => entry.id === a.id), 5_000, "runtime removed");
  if (typeof pidA === "number") {
    await waitFor(() => !isAlive(pidA), 5_000, "killed runtime reaped");
    assert(true, "killed runtime's process is gone (process group reaped)");
  }
  await fetch(`${BASE}/api/runtimes/${b.id}`, { method: "DELETE" });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function phaseD(): Promise<void> {
  console.log("\n-- Phase D: session index");
  const recent = await sessions(5);
  assert(recent.length > 0, `recent sessions come back (${recent.length})`);
  assert(recent.every((session) => session.path.endsWith(".jsonl")), "sessions carry transcript paths");
  assert(recent.every((session) => session.id.length > 0 && session.title.length > 0), "sessions carry ids and titles");
  const newest = recent[0];
  const found = await sessions(5, newest.id.slice(0, 8));
  assert(found.some((session) => session.id === newest.id), "search finds a session by id prefix");
  const byTitle = await sessions(5, newest.title.slice(0, 6));
  assert(byTitle.some((session) => session.id === newest.id), "search finds a session by title");
}

async function phaseB(): Promise<void> {
  console.log("\n-- Phase B: real omp TUI + session-file sniff");
  const runtime = await createRuntime({ cwd: process.env.HOME ?? "/tmp" });
  assert(runtime.pid === null, "new runtime is not spawned until a pane attaches");
  const pane = await attach(runtime.id);
  await waitFor(() => pane.text().length > 2000, 25_000, "omp TUI output");
  const info = (await runtimes()).find((entry) => entry.id === runtime.id);
  assert(info?.alive === true, "omp is alive after attach");
  assert(typeof info?.pid === "number" && info.pid > 0, `daemon reports a real omp pid (${info?.pid})`);
  await waitFor(
    async () => Boolean((await runtimes()).find((entry) => entry.id === runtime.id)?.sessionFile),
    25_000,
    "OSC 1337 session file",
  );
  const sniffed = (await runtimes()).find((entry) => entry.id === runtime.id);
  assert(
    Boolean(sniffed?.sessionFile?.endsWith(".jsonl")),
    `session file sniffed from omp's OSC 1337 (${sniffed?.sessionFile})`,
  );
  pane.close();
}

async function phaseE(pasteDir: string): Promise<void> {
  console.log("\n-- Phase E: image paste");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const res = await fetch(`${BASE}/api/paste`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  assert(res.status === 200, "paste accepts an image/png body");
  const payload: unknown = await res.json();
  assert(isRecord(payload) && typeof payload.path === "string", "paste returns a path");
  const path = (payload as { path: string }).path;
  assert(path.startsWith(pasteDir), `paste is written under the configured directory (${path})`);
  const written = new Uint8Array(await Bun.file(path).arrayBuffer());
  assert(
    written.length === png.length && written.every((byte, index) => byte === png[index]),
    "stored paste matches the uploaded bytes",
  );
  const bad = await fetch(`${BASE}/api/paste`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not an image",
  });
  assert(bad.status === 415, "paste rejects a non-image type");
  const empty = await fetch(`${BASE}/api/paste`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(0),
  });
  assert(empty.status === 400, "paste rejects an empty body");
}

const dir = mkdtempSync(join(tmpdir(), "omp-smoke-"));
const pasteDir = join(dir, "pastes");
console.log(`smoke: omp-desktopd + PTY pool (tmp ${dir})`);
let failed = false;
try {
  const bashDaemon = await startDaemon({
    OMP_DESKTOP_OMP: "/bin/bash",
    OMP_DESKTOP_OMP_ARGS: "-i",
    OMP_DESKTOP_OVERLAY: "",
    OMP_DESKTOP_CWD: dir,
    OMP_DESKTOP_PASTE_DIR: pasteDir,
  });
  try {
    await phaseA(dir);
    await phaseC(dir);
    await phaseD();
    await phaseE(pasteDir);
  } finally {
    await stopDaemon(bashDaemon);
  }

  const ompDaemon = await startDaemon({ OMP_DESKTOP_CWD: dir });
  try {
    await phaseB();
  } finally {
    await stopDaemon(ompDaemon);
  }
  console.log("\nSMOKE PASSED");
} catch (error) {
  failed = true;
  console.error(`\nSMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
