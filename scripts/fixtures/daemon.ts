import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/guards";

const DAEMON_ENTRY = join(import.meta.dir, "../../src/daemon.ts");
const FAKE_OMP_ENTRY = join(import.meta.dir, "fake-omp.ts");
const MAX_DIAGNOSTICS = 64 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const CONDITION_TIMEOUT_MS = 20_000;
const LISTENING = /omp-desktopd listening on http:\/\/127\.0\.0\.1:(\d+)/;
const RESERVED_ENV: Record<string, true> = {
  HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_CACHE_HOME: true,
  XDG_STATE_HOME: true,
  XDG_RUNTIME_DIR: true,
  OMP_DESKTOP_HOST: true,
  OMP_DESKTOP_PORT: true,
  OMP_DESKTOP_STATE_DIR: true,
  OMP_DESKTOP_SESSIONS_DIR: true,
  OMP_DESKTOP_PASTE_DIR: true,
  OMP_DESKTOP_OMP: true,
  OMP_DESKTOP_OMP_ARGS: true,
  OMP_DESKTOP_EXTENSION: true,
  OMP_DESKTOP_TEST_RECORD_DIR: true,
  OMP_MOBILE_IPC_DIR: true,
  OMP_MOBILE_TOKEN_FILE: true,
};

export type StartTestDaemonOptions = {
  /** Supply an existing test-owned directory; otherwise the fixture owns a fresh temporary root. */
  root?: string;
  /** Executable to run instead of the deterministic fake OMP. */
  omp?: string;
  /** Arguments passed to the selected OMP executable. */
  args?: string[];
  /** Daemon listener port; 0 asks the operating system to select one. */
  port?: number;
  /** Explicit test overrides. Host identity, credentials, systemd, and profile paths stay fixture-owned. */
  env?: Record<string, string>;
};

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("test daemon port must be an integer from 0 to 65535");
  }
  return port;
}

export type TestDaemon = {
  base: string;
  port: number;
  generation: string;
  /** Initial daemon process handle. API restarts are supervised through its owned process group. */
  proc: Bun.Subprocess;
  root: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
  diagnostics(): string;
};

export type TestTranscriptOptions = { cwd?: string; title?: string; firstPrompt?: string };

/**
 * Write the stable, minimal transcript consumed by the real daemon resume route.
 * The fixture stores all such files beneath its isolated session root.
 */
export function testSessionsRoot(root: string): string {
  return join(root, "home", ".omp", "agent", "sessions");
}
export async function writeTestTranscript(
  root: string,
  name: string,
  options: TestTranscriptOptions = {},
): Promise<string> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const id = `01a10000-0000-7000-8000-${suffix}`;
  const sessionsRoot = testSessionsRoot(root);
  const directory = join(sessionsRoot, "-test-fixtures");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `2026-10-05T00-00-00-000Z_${id}.jsonl`);
  const timestamp = "2026-10-05T00:00:00.000Z";
  const events: Record<string, unknown>[] = [
    { type: "session", version: 2, id, timestamp, cwd: options.cwd ?? join(root, "project") },
    {
      type: "message",
      id: `u-${timestamp}`,
      parentId: null,
      timestamp,
      message: { role: "user", content: options.firstPrompt ?? `fixture transcript ${normalized}` },
    },
  ];
  if (options.title) events.push({ type: "title", v: 1, title: options.title, updatedAt: timestamp });
  await Bun.write(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return path;
}

/** Raw PTY input is appended per runtime, allowing exact-byte assertions without cross-pane ambiguity. */
export function fakeOmpRecordPath(root: string, runtimeId: string): string {
  return join(root, "records", `${runtimeId}.bin`);
}

type DaemonState = {
  proc: Bun.Subprocess;
  diagnostics: string;
  stdoutPending: string;
  ports: number[];
  portWaiters: Map<number, (port: number) => void>;
  stdoutTask: Promise<void>;
  stderrTask: Promise<void>;
  stopped: boolean;
};

function appendDiagnostic(state: DaemonState, text: string): void {
  state.diagnostics = (state.diagnostics + text).slice(-MAX_DIAGNOSTICS);
}

function consumeStdout(state: DaemonState, text: string): void {
  state.stdoutPending += text;
  let newline: number;
  while ((newline = state.stdoutPending.indexOf("\n")) >= 0) {
    const line = state.stdoutPending.slice(0, newline).replace(/\r$/, "");
    state.stdoutPending = state.stdoutPending.slice(newline + 1);
    appendDiagnostic(state, `${line}\n`);
    const match = LISTENING.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    const index = state.ports.push(port) - 1;
    state.portWaiters.get(index)?.(port);
    state.portWaiters.delete(index);
  }
  if (state.stdoutPending.length > 8192) {
    appendDiagnostic(state, state.stdoutPending.slice(-8192));
    state.stdoutPending = state.stdoutPending.slice(-8192);
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  state: DaemonState,
  isStdout: boolean,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (isStdout) consumeStdout(state, text);
      else appendDiagnostic(state, text);
    }
    const remainder = decoder.decode();
    if (remainder) {
      if (isStdout) consumeStdout(state, remainder);
      else appendDiagnostic(state, remainder);
    }
  } catch (error) {
    appendDiagnostic(state, `\n[${isStdout ? "stdout" : "stderr"} reader failed: ${String(error)}]\n`);
  } finally {
    reader.releaseLock();
  }
}

function diagnostics(state: DaemonState): string {
  return state.diagnostics.slice(-MAX_DIAGNOSTICS);
}

function waitForListening(
  state: DaemonState,
  index: number,
  deadline: number,
  failOnInitialExit = false,
): Promise<number> {
  const existing = state.ports[index];
  if (existing !== undefined) return Promise.resolve(existing);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const timer = setInterval(() => {
    if (failOnInitialExit && state.proc.exitCode !== null) {
      clearInterval(timer);
      state.portWaiters.delete(index);
      reject(new Error(`daemon exited early with code ${state.proc.exitCode}:\n${diagnostics(state)}`));
    } else if (Date.now() >= deadline) {
      clearInterval(timer);
      state.portWaiters.delete(index);
      reject(new Error(`timed out waiting for daemon listening line\n${diagnostics(state)}`));
    }
  }, 50);
  state.portWaiters.set(index, (port) => {
    clearInterval(timer);
    resolve(port);
  });
  return promise;
}

function validBuild(value: unknown): value is { build: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "build" in value && typeof value.build === "string" && value.build.length > 0;
}

async function awaitBuild(
  state: DaemonState,
  base: string,
  deadline: number,
  failOnInitialExit: boolean,
): Promise<string> {
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (failOnInitialExit && state.proc.exitCode !== null) {
      throw new Error(`daemon exited early with code ${state.proc.exitCode}:\n${diagnostics(state)}`);
    }
    try {
      const response = await fetch(`${base}/api/build`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (!validBuild(body)) throw new Error("/api/build returned an invalid payload");
        const runtimes = await fetch(`${base}/api/runtimes`, { signal: AbortSignal.timeout(500) });
        const payload: unknown = await runtimes.json();
        if (
          !runtimes.ok || typeof payload !== "object" || payload === null || Array.isArray(payload) ||
          !("generation" in payload) || typeof payload.generation !== "string" || !payload.generation
        ) throw new Error("/api/runtimes returned no daemon generation");
        return payload.generation;
      }
      lastError = `/api/build returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`daemon did not become ready (${lastError}):\n${diagnostics(state)}`);
}

async function waitForProcessExit(proc: Bun.Subprocess, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
    }
  }
}

async function waitForGroupExit(pgid: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (!groupExists(pgid)) return true;
    await Bun.sleep(50);
  }
  return !groupExists(pgid);
}
async function runtimePids(base: string): Promise<number[]> {
  try {
    const response = await fetch(`${base}/api/runtimes`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.runtimes)) return [];
    return [...new Set(body.runtimes
      .filter(isRecord)
      .map((runtime) => runtime.pid)
      .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0))];
  } catch {
    return [];
  }
}

function ptyExists(pid: number): boolean {
  if (groupExists(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalPty(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
    }
  }
}

async function terminateOwnedPtys(pids: number[]): Promise<void> {
  for (const pid of pids) signalPty(pid, "SIGTERM");
  const termDeadline = Date.now() + CONDITION_TIMEOUT_MS;
  while (Date.now() < termDeadline && pids.some(ptyExists)) await Bun.sleep(50);
  const survivors = pids.filter(ptyExists);
  for (const pid of survivors) signalPty(pid, "SIGKILL");
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && survivors.some(ptyExists)) await Bun.sleep(50);
  const stillAlive = survivors.filter(ptyExists);
  if (stillAlive.length > 0) throw new Error(`fixture PTY processes survived SIGKILL: ${stillAlive.join(", ")}`);
}


function validateOverrides(overrides: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!/^(?:PATH|LANG|LC_[A-Z0-9_]+|TERM|COLORTERM|XDG_[A-Z0-9_]+|OMP_DESKTOP_[A-Z0-9_]+|OMP_MOBILE_[A-Z0-9_]+)$/.test(key)) {
      throw new Error(`test daemon override ${key} is not an allowed test environment variable`);
    }
    if (/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|SYSTEMD|DBUS_SESSION/i.test(key)) {
      throw new Error(`test daemon override ${key} could expose credentials or systemd ownership`);
    }
    if (RESERVED_ENV[key] === true) {
      throw new Error(`test daemon override ${key} is fixture-owned`);
    }
    result[key] = value;
  }
  return result;
}

export async function startTestDaemon(options: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const portOption = validatePort(options.port ?? 0);
  const overrideEnv = validateOverrides(options.env);
  const ownsRoot = options.root === undefined;
  const root = options.root ?? await mkdtemp(join(tmpdir(), "omp-test-daemon-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  const config = join(home, ".config");
  const stateHome = join(home, ".local", "state");
  const dataHome = join(home, ".local", "share");
  const cacheHome = join(home, ".cache");
  const runtimeDir = join(root, "runtime");
  const project = join(root, "project");
  const state = join(root, "state");
  const sessions = join(home, ".omp", "agent", "sessions");
  const pastes = join(root, "pastes");
  const records = join(root, "records");
  const mobile = join(root, "mobile");
  await Promise.all([home, config, stateHome, dataHome, cacheHome, runtimeDir, project, state, sessions, pastes, records, mobile]
    .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));

  const bun = process.execPath;
  const allowedEnv: Record<string, string> = {
    ...overrideEnv,
    PATH: `${dirname(bun)}:${overrideEnv.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    LANG: overrideEnv.LANG ?? process.env.LANG ?? "C.UTF-8",
    TERM: overrideEnv.TERM ?? "xterm-256color",
    COLORTERM: overrideEnv.COLORTERM ?? "truecolor",
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: stateHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_RUNTIME_DIR: runtimeDir,
    OMP_DESKTOP_HOST: "127.0.0.1",
    OMP_DESKTOP_PORT: String(portOption),
    OMP_DESKTOP_CWD: overrideEnv.OMP_DESKTOP_CWD ?? project,
    OMP_DESKTOP_STATE_DIR: state,
    OMP_DESKTOP_SESSIONS_DIR: sessions,
    OMP_DESKTOP_PASTE_DIR: pastes,
    OMP_DESKTOP_OMP: options.omp ?? bun,
    OMP_DESKTOP_OMP_ARGS: (options.args ?? (options.omp ? [] : [FAKE_OMP_ENTRY])).join(" "),
    OMP_DESKTOP_EXTENSION: "",
    OMP_DESKTOP_TEST_RECORD_DIR: records,
    OMP_MOBILE_IPC_DIR: mobile,
    OMP_MOBILE_TOKEN_FILE: join(config, "missing-mobile-token"),
  };

  const proc = Bun.spawn({
    cmd: [bun, "run", DAEMON_ENTRY],
    cwd: root,
    env: allowedEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const daemonState: DaemonState = {
    proc,
    diagnostics: "",
    stdoutPending: "",
    ports: [],
    portWaiters: new Map<number, (port: number) => void>(),
    stdoutTask: Promise.resolve(),
    stderrTask: Promise.resolve(),
    stopped: false,
  };
  daemonState.stdoutTask = consumeStream(proc.stdout, daemonState, true);
  daemonState.stderrTask = consumeStream(proc.stderr, daemonState, false);

  let daemon: TestDaemon;
  daemon = {
    base: "",
    port: 0,
    generation: "",
    proc,
    root,
    diagnostics() {
      return diagnostics(daemonState);
    },
    async stop() {
      if (daemonState.stopped) return;
      daemonState.stopped = true;
      let ptyCleanupError: unknown;
      try {
        const pids = await runtimePids(daemon.base);
        await terminateOwnedPtys(pids);
      } catch (error) {
        ptyCleanupError = error;
      }
      signalOwnedProcessGroup(proc.pid, "SIGTERM");
      await waitForProcessExit(proc, Date.now() + CONDITION_TIMEOUT_MS);
      let groupExited = await waitForGroupExit(proc.pid, Date.now() + CONDITION_TIMEOUT_MS);
      if (!groupExited) {
        signalOwnedProcessGroup(proc.pid, "SIGKILL");
        groupExited = await waitForGroupExit(proc.pid, Date.now() + 5_000);
        if (!groupExited) throw new Error(`owned daemon process group ${proc.pid} survived SIGKILL\n${diagnostics(daemonState)}`);
      }
      if (!await waitForProcessExit(proc, Date.now() + 5_000)) {
        throw new Error(`owned daemon process ${proc.pid} was not reaped\n${diagnostics(daemonState)}`);
      }
      if (ownsRoot) await rm(root, { recursive: true, force: true });
      if (ptyCleanupError !== undefined) throw ptyCleanupError;
    },
    async restart() {
      if (daemonState.stopped) throw new Error("cannot restart a stopped test daemon");
      const previousGeneration = daemon.generation;
      const previousListenerCount = daemonState.ports.length;
      const response = await fetch(`${daemon.base}/api/restart`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 202) {
        throw new Error(`POST /api/restart returned ${response.status}: ${await response.text()}\n${diagnostics(daemonState)}`);
      }
      const port = await waitForListening(
        daemonState,
        previousListenerCount,
        Date.now() + STARTUP_TIMEOUT_MS,
      );
      const base = `http://127.0.0.1:${port}`;
      const generation = await awaitBuild(daemonState, base, Date.now() + STARTUP_TIMEOUT_MS, false);
      if (generation === previousGeneration) {
        const deadline = Date.now() + CONDITION_TIMEOUT_MS;
        let next = generation;
        while (Date.now() < deadline && next === previousGeneration) {
          await Bun.sleep(100);
          try {
            next = await awaitBuild(daemonState, base, Date.now() + 1_000, false);
          } catch {
            // Replacement is between binding and first complete response.
          }
        }
        if (next === previousGeneration) throw new Error("restarted daemon retained its generation");
        daemon.generation = next;
      } else {
        daemon.generation = generation;
      }
      daemon.port = port;
      daemon.base = base;
    },
  };

  try {
    const port = await waitForListening(daemonState, 0, Date.now() + STARTUP_TIMEOUT_MS, true);
    daemon.port = port;
    daemon.base = `http://127.0.0.1:${port}`;
    daemon.generation = await awaitBuild(daemonState, daemon.base, Date.now() + STARTUP_TIMEOUT_MS, true);
    return daemon;
  } catch (error) {
    signalOwnedProcessGroup(proc.pid, "SIGTERM");
    await waitForProcessExit(proc, Date.now() + 5_000);
    let groupExited = await waitForGroupExit(proc.pid, Date.now() + 5_000);
    if (!groupExited) {
      signalOwnedProcessGroup(proc.pid, "SIGKILL");
      groupExited = await waitForGroupExit(proc.pid, Date.now() + 5_000);
    }
    if (!groupExited) throw new Error(`test daemon process group ${proc.pid} survived startup cleanup`);
    if (!await waitForProcessExit(proc, Date.now() + 5_000)) {
      proc.kill("SIGKILL");
      await waitForProcessExit(proc, Date.now() + 5_000);
    }
    await Promise.all([daemonState.stdoutTask, daemonState.stderrTask]);
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    throw error;
  }
}

