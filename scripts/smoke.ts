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
 * Phase H proves resume uses the transcript's recorded cwd, not OMP_DESKTOP_CWD.
 * Phase I proves the daemon's own restore: a restart brings back the session that
 * was live, and never the one the user stopped.
 *
 * Run: bun run smoke
 *
 * The whole run uses a disposable temp root (and a disposable HOME/XDG set for
 * every daemon), so it never reads or writes the user's real omp session store,
 * config, workspace state or pasted images. Phase D runs against a seeded
 * session store instead of the user's real `~/.omp/agent/sessions`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../src/guards";
import { Terminal } from "@xterm/headless";
import { parseServerMessage } from "../src/protocol";

const ROOT = join(import.meta.dir, "..");
// Refuse an occupied explicit port; otherwise choose an unused ephemeral port.
const portProbe = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.OMP_DESKTOP_SMOKE_PORT ?? 0),
  fetch: () => new Response(null),
});
const PORT = portProbe.port;
portProbe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/term`;

/** Phase D fixtures: fixed ids so the expected session row is deterministic. */
const INDEX_FIXTURE_A = "01a10000-0000-7000-8000-0000000000a1";
const INDEX_FIXTURE_B = "01a10000-0000-7000-8000-0000000000b2";

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
    // Do not inherit config paths, credentials, or service environment overrides.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OMP_DESKTOP_OMP: process.env.OMP_DESKTOP_OMP ?? "omp",
      OMP_DESKTOP_PORT: String(PORT),
      ...env,
    },
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

/** Start one daemon, run a scenario set against it, and always stop it. */
async function withDaemon(env: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const proc = await startDaemon(env);
  try {
    await run();
  } finally {
    await stopDaemon(proc);
  }
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

/**
 * The daemon generation alongside the pool. Clients treat a generation change
 * as "the daemon restarted, every runtime is gone", so it must be present and
 * stable for one process and different for the next.
 */
async function generation(): Promise<string> {
  const res = await fetch(`${BASE}/api/runtimes`);
  assert(res.ok, "GET /api/runtimes");
  const body: unknown = await res.json();
  const value = isRecord(body) ? body.generation : undefined;
  assert(typeof value === "string" && value.length > 0, "runtimes response carries a daemon generation");
  return value;
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

type Pane = { text: () => string; screen: () => string[]; send: (data: string) => void; close: () => void };

/** One pane: a websocket bound to a runtime, mirroring what the client does. */
async function attach(runtimeId: string): Promise<Pane> {
  const ws = new WebSocket(`${WS_URL}?runtime=${encodeURIComponent(runtimeId)}`);
  ws.binaryType = "arraybuffer";
  let out = "";
  const terminal = new Terminal({ allowProposedApi: true });
  // One decoder per pane keeps a multi-byte character split across two frames
  // from being mangled: the PTY can cut anywhere, not just at character ends.
  const decoder = new TextDecoder();
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      out += decoder.decode(bytes, { stream: true });
      terminal.write(bytes);
    } else if (typeof event.data === "string") {
      const message = parseServerMessage(event.data);
      if (message?.type === "hello") terminal.resize(message.runtime.cols, message.runtime.rows);
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`websocket to ${runtimeId} failed`));
  });
  return {
    text: () => out,
    screen: () => {
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)!.translateToString(true));
    },
    send: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
    close: () => {
      ws.close();
      terminal.dispose();
    },
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
  console.log("ok - input -> PTY -> output -> websocket round-trip");
  const listed = await runtimes();
  assert(listed.some((entry) => entry.id === runtime.id), "runtime shows up in /api/runtimes");
  // Output must keep draining with no subscribers, not merely keep a pid alive.
  const detachedTag = `detached-${Date.now()}`;
  pane.send(`sleep 1; printf '\\n%s%s\\n' 'detached-' '${detachedTag.slice(9)}'\n`);
  pane.close();
  const before = (await runtimes()).find((entry) => entry.id === runtime.id)!;
  await waitFor(async () => {
    const current = (await runtimes()).find((entry) => entry.id === runtime.id);
    return !!current && current.bytesOut > before.bytesOut;
  }, 10_000, "output advances after the last pane closes");
  await Bun.sleep(1200);
  const reattached = await attach(runtime.id);
  await waitFor(() => reattached.text().includes(`\r\n${detachedTag}\r\n`), 10_000, "detached output is replayed on reopen");
  assert((await runtimes()).find((entry) => entry.id === runtime.id)?.pid === before.pid,
    "closing and reopening a streaming view preserves its process");
  reattached.close();
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
  console.log("ok - both rebound panes still take input; pids unchanged");

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
    console.log("ok - killed runtime's process is gone (process group reaped)");
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
  assert(recent.length === 2, `the seeded store lists exactly its two fixtures (${recent.length})`);
  assert(recent.every((session) => session.path.endsWith(".jsonl")), "sessions carry transcript paths");
  assert(recent.every((session) => session.id.length > 0 && session.title.length > 0), "sessions carry ids and titles");
  const newest = recent[0];
  assert(newest.id === INDEX_FIXTURE_B, `the newest fixture sorts first (${newest.id})`);
  assert(newest.title === "smoke index beta", `the fixture title round-trips (${newest.title})`);
  const found = await sessions(5, newest.id.slice(0, 8));
  assert(found.some((session) => session.id === newest.id), "search finds a session by id prefix");
  const byTitle = await sessions(5, newest.title.slice(0, 6));
  assert(byTitle.some((session) => session.id === newest.id), "search finds a session by title");
}

async function phaseB(home: string): Promise<void> {
  console.log("\n-- Phase B: real omp TUI + session-file sniff");
  const runtime = await createRuntime({ cwd: home });
  assert(runtime.pid === null, "new runtime is not spawned until a pane attaches");
  const pane = await attach(runtime.id);
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

type RestoreFixture = { sessionPath: string; stoppedPath: string; project: string };

/** A minimal resumable transcript: its session header carries the recorded cwd. */
function writeTranscript(root: string, id: string, cwd: string): string {
  mkdirSync(join(root, "-tmp-smoke-restore"), { recursive: true });
  const path = join(root, "-tmp-smoke-restore", `2026-10-04T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n");
  return path;
}

/**
 * Runs on the daemon that owns the pool: one session resumes and stays live,
 * a second is explicitly stopped. Isolated store, and a stand-in omp that
 * blocks on stdin, so the pool is genuinely live when the daemon stops.
 */
async function phaseIStart(fixture: RestoreFixture): Promise<void> {
  console.log("\n-- Phase I: the pool survives a daemon restart");
  const runtime = await createRuntime({ resume: fixture.sessionPath });
  assert(runtime.sessionFile === fixture.sessionPath, `the resumed session is in the pool (${runtime.sessionFile})`);
  assert((await runtimes()).find((entry) => entry.id === runtime.id)?.alive === true, "the resumed session is running");
  const stopped = await createRuntime({ resume: fixture.stoppedPath });
  const killed = await fetch(`${BASE}/api/runtimes/${stopped.id}`, { method: "DELETE" });
  assert(killed.ok, "DELETE stops the second session");
}

/**
 * Runs on a fresh daemon sharing the state dir of the daemon that just stopped:
 * the session that was live is restored with no client asking, in its recorded
 * directory, and the session the user stopped stays stopped.
 */
async function phaseIRestored(fixture: RestoreFixture): Promise<void> {
  await waitFor(
    async () => (await runtimes()).some((entry) => entry.sessionFile === fixture.sessionPath),
    20_000,
    "the session that was live at shutdown to be restored",
  );
  const listed = await runtimes();
  assert(listed.length === 1, `exactly the live session came back (${listed.length})`);
  assert(listed[0].sessionFile === fixture.sessionPath, "the restored session is the one that was live");
  assert(listed[0].cwd === fixture.project, `the restored session runs in its recorded cwd (${listed[0].cwd})`);
  assert(listed[0].alive === true, "the restored session is running");
  assert(!listed.some((entry) => entry.sessionFile === fixture.stoppedPath), "the stopped session stayed stopped");
  // Attach and type a line: one line ends the stand-in omp, so this proves the
  // restored process is real, reachable, and taking input.
  const pane = await attach(listed[0].id);
  pane.send("restored\n");
  await waitFor(
    async () => !(await runtimes()).some((entry) => entry.id === listed[0].id),
    10_000,
    "the restored process to take input",
  );
}

async function phaseE(pasteDir: string): Promise<void> {
  console.log("\n-- Phase E: image paste");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const res = await fetch(`${BASE}/api/paste`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  assert(res.status === 200, "paste accepts an image/png body");
  const payload: unknown = await res.json();
  assert(isRecord(payload) && typeof payload.path === "string", "paste returns a path");
  const path = payload.path;
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

/** The exact document written in phase F; phase G compares the daemon's copy against it. */
let writtenState = "";
/** Generation of the first daemon; the restarted one must differ (phase G). */
let firstGeneration = "";

async function phaseF(stateDir: string): Promise<void> {
  console.log("\n-- Phase F: durable workspace state");
  const fresh = await fetch(`${BASE}/api/state`);
  assert(fresh.ok, "GET /api/state answers on a fresh state dir");
  const freshBody: unknown = await fresh.json();
  assert(isRecord(freshBody) && freshBody.state === null, "no state is stored yet");
  assert(
    freshBody.path === join(stateDir, "state.json"),
    `state file lives under OMP_DESKTOP_STATE_DIR (${String(freshBody.path)})`,
  );

  const doc = {
    version: 1,
    savedAt: new Date().toISOString(),
    layout: {
      tree: {
        kind: "split",
        dir: "row",
        ratio: 0.5,
        a: { kind: "leaf", pane: "p1" },
        b: { kind: "leaf", pane: "p2" },
      },
      panes: {
        p1: { runtimeId: null, title: "restart smoke", sessionFile: "/tmp/omp-smoke-session.jsonl" },
        p2: { runtimeId: null, title: null, sessionFile: null },
      },
      focused: "p2",
    },
    pins: [],
    cellSize: 14.33,
    sidebar: JSON.stringify({ width: 300, collapsed: false }),
  };
  writtenState = JSON.stringify(doc);
  const writeHeaders = { "content-type": "application/json", "X-OMP-Generation": await generation() };
  const stale = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: { ...writeHeaders, "X-OMP-Generation": "previous-daemon" },
    body: writtenState,
  });
  assert(stale.status === 409, "stale daemon generation cannot overwrite workspace state");
  const put = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: writeHeaders,
    body: writtenState,
  });
  assert(put.ok, "PUT /api/state stores a v1 document");
  const got = await fetch(`${BASE}/api/state`);
  const gotBody: unknown = await got.json();
  assert(
    isRecord(gotBody) && JSON.stringify(gotBody.state) === writtenState,
    "GET /api/state returns the stored document",
  );
  const wrongVersion = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ version: 3, savedAt: new Date().toISOString() }),
  });
  assert(wrongVersion.status === 400, "PUT rejects an unsupported workspace version");
  const notJson = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: writeHeaders,
    body: "not json",
  });
  assert(notJson.status === 400, "PUT rejects a non-JSON body");
}

/** Runs on a second daemon sharing the state dir: the document survived the restart. */
async function phaseG(stateDir: string): Promise<void> {
  console.log("\n-- Phase G: workspace state and daemon identity survive a restart");
  assert(await Bun.file(join(stateDir, "state.json")).exists(), "state file is on disk");
  const res = await fetch(`${BASE}/api/state`);
  assert(res.ok, "GET /api/state after restart");
  const body: unknown = await res.json();
  assert(isRecord(body) && JSON.stringify(body.state) === writtenState, "stored document is unchanged");
  assert((await generation()) !== firstGeneration, "the restarted daemon reports a new generation");
}

type CwdFixture = { sessionPath: string; project: string; launch: string; capacityPaths: string[] };

/**
 * Isolated store + transcript: resume must run in the directory recorded in the
 * transcript, never the daemon's OMP_DESKTOP_CWD fallback, and a conflicting
 * explicit cwd must not override the recorded one.
 */
async function phaseH(fixture: CwdFixture): Promise<void> {
  console.log("\n-- Phase H: resume uses the session's recorded cwd");
  const resumed = await createRuntime({ resume: fixture.sessionPath });
  assert(resumed.cwd === fixture.project, `resume without cwd uses the recorded cwd (${resumed.cwd})`);
  const resumedPane = await attach(resumed.id);
  await waitFor(() => resumedPane.screen().includes(fixture.project), 5_000, "resumed process reports its actual project cwd");
  resumedPane.close();
  const conflicting = await createRuntime({ resume: fixture.sessionPath, cwd: fixture.launch });
  assert(conflicting.cwd === fixture.project, `resume ignores a conflicting explicit cwd (${conflicting.cwd})`);
  const fresh = await createRuntime({ cwd: fixture.launch });
  assert(fresh.cwd === fixture.launch, "new sessions still start in the requested cwd");
  const listed = await sessions(5, "smoke cwd fixture");
  const row = listed.find((session) => session.path === fixture.sessionPath);
  assert(row?.cwd === fixture.project, `session index lists the recorded cwd (${row?.cwd ?? "<missing>"})`);
  console.log("ok - recorded cwd wins on resume; explicit cwd still applies to new sessions");
  for (const runtime of [resumed, conflicting, fresh]) {
    await fetch(`${BASE}/api/runtimes/${runtime.id}`, { method: "DELETE" });
  }
  // Distinct transcripts must still not blow past the pool limit when they are
  // requested at once: every spawn occupies a slot the moment it is reserved.
  // (Concurrent requests for *one* transcript collapse onto one process, which
  // the manager regression tests pin.)
  const concurrent = await Promise.all(fixture.capacityPaths.map((resume) => fetch(`${BASE}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume }),
  })));
  const refusals = await Promise.all(concurrent.filter((response) => !response.ok).map(async (response) => `${response.status}: ${await response.text()}`));
  assert(concurrent.filter((response) => response.ok).length === 8, `concurrent transcript reads cannot exceed runtime capacity (statuses: ${concurrent.map((response) => response.status).join(", ")}; ${refusals.join("; ")})`);
  assert(concurrent.filter((response) => response.status === 409).length === 1, "one concurrent resume is rejected at capacity");
}

const dir = mkdtempSync(join(tmpdir(), "omp-smoke-"));
const pasteDir = join(dir, "pastes");
const stateDir = join(dir, "state");
// Disposable HOME/XDG for every daemon (and for the real omp they spawn): the
// smoke must never touch the user's ~/.omp store, config, state or caches.
const home = join(dir, "home");
const sessionsDir = join(home, ".omp/agent/sessions");
mkdirSync(home, { recursive: true });
const isolatedHome = {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
};
// Phase D fixtures: two transcripts with stable ids, titles and creation days,
// so the session index has exactly one deterministic answer.
for (const [stamp, id, title] of [
  ["2026-01-01T00-00-00-000Z", INDEX_FIXTURE_A, "smoke index alpha"],
  ["2026-01-02T00-00-00-000Z", INDEX_FIXTURE_B, "smoke index beta"],
] as const) {
  const file = join(sessionsDir, "-home-smoke-index", `${stamp}_${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: stamp.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z"),
        cwd: join(home, "smoke-index"),
      }),
      JSON.stringify({ type: "title", v: 1, title, updatedAt: new Date().toISOString() }),
    ].join("\n") + "\n",
  );
}
console.log(`smoke: omp-desktopd + PTY pool (tmp ${dir})`);
let failed = false;
try {
  await withDaemon(
    {
      ...isolatedHome,
      OMP_DESKTOP_OMP: "/bin/bash",
      OMP_DESKTOP_OMP_ARGS: "-i",
      OMP_DESKTOP_OVERLAY: "",
      // A stand-in binary is not omp and must never receive the extension flag.
      OMP_DESKTOP_EXTENSION: "",
      OMP_DESKTOP_CWD: dir,
      OMP_DESKTOP_SESSIONS_DIR: sessionsDir,
      OMP_DESKTOP_PASTE_DIR: pasteDir,
      OMP_DESKTOP_STATE_DIR: stateDir,
    },
    async () => {
      await phaseA(dir);
      await phaseC(dir);
      await phaseD();
      await phaseE(pasteDir);
      await phaseF(stateDir);
      firstGeneration = await generation();
      assert(firstGeneration === (await generation()), "the generation is stable within one daemon process");
    },
  );

  await withDaemon(
    {
      ...isolatedHome,
      OMP_DESKTOP_CWD: dir,
      OMP_DESKTOP_SESSIONS_DIR: sessionsDir,
      OMP_DESKTOP_STATE_DIR: stateDir,
    },
    async () => {
      await phaseG(stateDir);
      await phaseB(home);
    },
  );

  // Isolated store for phase I: the daemon owns the pool, so a restart brings
  // the live sessions back with no client asking. The stand-in omp blocks on
  // stdin, so it is genuinely running when the first daemon stops.
  const restoreRoot = join(dir, "restore-fixture");
  const restoreSessions = join(restoreRoot, "sessions");
  const restoreProject = join(restoreRoot, "project");
  mkdirSync(restoreProject, { recursive: true });
  const standIn = join(restoreRoot, "stand-in-omp");
  writeFileSync(standIn, "#!/bin/sh\nread line\nexit 0\n");
  chmodSync(standIn, 0o755);
  const restoreFixture: RestoreFixture = {
    sessionPath: writeTranscript(restoreSessions, "01a10000-0000-7000-8000-0000000000f1", restoreProject),
    stoppedPath: writeTranscript(restoreSessions, "01a10000-0000-7000-8000-0000000000f2", restoreProject),
    project: restoreProject,
  };
  const restoreEnv = {
    ...isolatedHome,
    OMP_DESKTOP_OMP: standIn,
    OMP_DESKTOP_OMP_ARGS: "",
    OMP_DESKTOP_OVERLAY: "",
    OMP_DESKTOP_EXTENSION: "",
    OMP_DESKTOP_MAX_RUNTIMES: "4",
    OMP_DESKTOP_CWD: restoreProject,
    OMP_DESKTOP_SESSIONS_DIR: restoreSessions,
    OMP_DESKTOP_PASTE_DIR: join(restoreRoot, "pastes"),
    OMP_DESKTOP_STATE_DIR: join(restoreRoot, "state"),
  };
  await withDaemon(restoreEnv, async () => {
    await phaseIStart(restoreFixture);
  });
  await withDaemon(restoreEnv, async () => {
    await phaseIRestored(restoreFixture);
  });

  // Isolated store for phase H: the fixture transcript records its own cwd, and
  // the daemon's OMP_DESKTOP_CWD is a different (launch-fallback) directory.
  const fixtureRoot = join(dir, "cwd-fixture");
  const fixtureSessions = join(fixtureRoot, "sessions");
  const fixtureProject = join(fixtureRoot, "project");
  const fixtureLaunch = join(fixtureRoot, "launch");
  const fixturePath = join(
    fixtureSessions,
    "-tmp-smoke-cwd-fixture",
    "2026-10-04T00-00-00-000Z_01a10000-0000-7000-8000-000000000009.jsonl",
  );
  mkdirSync(join(fixtureSessions, "-tmp-smoke-cwd-fixture"), { recursive: true });
  mkdirSync(fixtureProject, { recursive: true });
  mkdirSync(fixtureLaunch, { recursive: true });
  writeFileSync(
    fixturePath,
    [
      JSON.stringify({ type: "title", v: 1, title: "smoke cwd fixture", updatedAt: new Date().toISOString() }),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "01a10000-0000-7000-8000-000000000009",
        timestamp: new Date().toISOString(),
        cwd: fixtureProject,
      }),
    ].join("\n") + "\n",
  );
  // Nine sibling transcripts for the concurrency/capacity phase, each a valid
  // session under the same store with its own identity.
  const capacityPaths = Array.from({ length: 9 }, (_, index) => {
    const path = join(
      fixtureSessions,
      "-tmp-smoke-capacity-fixture",
      `2026-10-04T00-00-01-000Z_01a10000-0000-7000-8000-0000000000${(index + 10).toString(16)}.jsonl`,
    );
    mkdirSync(join(fixtureSessions, "-tmp-smoke-capacity-fixture"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        type: "session",
        version: 3,
        id: `01a10000-0000-7000-8000-0000000000${(index + 10).toString(16)}`,
        timestamp: new Date().toISOString(),
        cwd: fixtureProject,
      }) + "\n",
    );
    return path;
  });
  await withDaemon(
    {
      ...isolatedHome,
      OMP_DESKTOP_OMP: "/bin/sh",
      OMP_DESKTOP_OMP_ARGS: "-c pwd;cat",
      OMP_DESKTOP_OVERLAY: "",
      OMP_DESKTOP_EXTENSION: "",
      OMP_DESKTOP_MAX_RUNTIMES: "8",
      OMP_DESKTOP_CWD: fixtureLaunch,
      OMP_DESKTOP_SESSIONS_DIR: fixtureSessions,
      OMP_DESKTOP_PASTE_DIR: join(fixtureRoot, "pastes"),
      OMP_DESKTOP_STATE_DIR: join(fixtureRoot, "state"),
    },
    async () => {
      await phaseH({ sessionPath: fixturePath, project: fixtureProject, launch: fixtureLaunch, capacityPaths });
    },
  );
  console.log("\nSMOKE PASSED");
} catch (error) {
  failed = true;
  console.error(`\nSMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
