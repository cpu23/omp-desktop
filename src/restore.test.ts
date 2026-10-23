/**
 * End-to-end regression for the "only some sessions come back" bug: a daemon
 * restart must restore every session that was live — including sessions no pane
 * document mentions — while explicit stops and ordinary process exits stay
 * stopped, and a client resume that races the restore joins it instead of
 * spawning a duplicate process.
 *
 * The second test pins the case that made the loss look random: on a unit
 * teardown (systemctl stop/restart, logout, reboot) systemd SIGTERMs the daemon
 * and its PTY children at the same time, so a child's death is often seen before
 * the daemon's own shutdown runs. Killing a session from outside the daemon
 * reproduces exactly that ordering, deterministically.
 *
 * Both tests start real isolated daemons over a temp state directory and session
 * store, with a stand-in omp binary that exits when its PTY receives a line. Only
 * the daemon is exercised: no client document is involved, which is the point —
 * restoration is owned by the pool, not by a browser.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.OMP_DESKTOP_RESTORE_TEST_PORT ?? 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/term`;

type RuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cwd: string;
  sessionFile: string | null;
  status: string;
};

type Fixture = {
  stateDir: string;
  sessionsDir: string;
  projectDir: string;
  env: Record<string, string>;
  cleanup: () => void;
};

async function startDaemon(env: Record<string, string>): Promise<Bun.Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "daemon.ts")], {
    env: { ...process.env, OMP_DESKTOP_PORT: String(PORT), ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 30_000;
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

function runtimeFrom(value: unknown): RuntimeInfo {
  expect(isRecord(value)).toBe(true);
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : "",
    alive: record.alive === true,
    pid: typeof record.pid === "number" ? record.pid : null,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
    status: typeof record.status === "string" ? record.status : "",
  };
}

async function runtimes(): Promise<RuntimeInfo[]> {
  const res = await fetch(`${BASE}/api/runtimes`);
  if (!res.ok) throw new Error(`GET /api/runtimes -> ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.runtimes)) throw new Error("bad runtimes payload");
  return body.runtimes.map(runtimeFrom);
}

async function createRuntime(request: Record<string, unknown>): Promise<RuntimeInfo> {
  const res = await fetch(`${BASE}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`POST /api/runtimes ${JSON.stringify(request)} -> ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error("bad create payload");
  return runtimeFrom(body.runtime);
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  // The daemon and its PTY children are real processes here; there is no fake
  // timer that can drive a spawn or an exit, so poll the observable state.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Attach like a pane does and type one line, which ends the stand-in session. */
async function exitThroughAttach(runtimeId: string): Promise<void> {
  const ws = new WebSocket(`${WS_URL}?runtime=${encodeURIComponent(runtimeId)}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`websocket to ${runtimeId} failed`));
  });
  ws.send(JSON.stringify({ type: "input", data: "quit\n" }));
  ws.close();
}

/** Kill a PTY child the way a unit teardown does: SIGTERM from outside the daemon. */
function killOutsideDaemon(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

async function ledgerFiles(stateDir: string): Promise<string[]> {
  try {
    const doc: unknown = JSON.parse(await Bun.file(join(stateDir, "sessions.json")).text());
    if (!isRecord(doc) || !Array.isArray(doc.sessions)) return [];
    return doc.sessions
      .filter(isRecord)
      .map((entry) => (typeof entry.sessionFile === "string" ? entry.sessionFile : ""));
  } catch {
    return [];
  }
}

function fixtureDir(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "omp-restore-test-"));
  const stateDir = join(dir, "state");
  const sessionsDir = join(dir, "sessions");
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const fakeOmp = join(dir, "fake-omp");
  writeFileSync(fakeOmp, "#!/bin/sh\nprintf 'fake-omp-ready\\n'\nread line\nexit 0\n");
  chmodSync(fakeOmp, 0o755);
  return {
    stateDir,
    sessionsDir,
    projectDir,
    env: {
      OMP_DESKTOP_OMP: fakeOmp,
      OMP_DESKTOP_OMP_ARGS: "",
      OMP_DESKTOP_OVERLAY: "",
      OMP_DESKTOP_EXTENSION: "",
      OMP_DESKTOP_CWD: dir,
      OMP_DESKTOP_SESSIONS_DIR: sessionsDir,
      OMP_DESKTOP_STATE_DIR: stateDir,
      OMP_DESKTOP_PASTE_DIR: join(dir, "pastes"),
      OMP_DESKTOP_MAX_RUNTIMES: "6",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fixtureTranscript(fixture: Fixture, suffix: string): string {
  const root = join(fixture.sessionsDir, "-tmp-restore-fixture");
  mkdirSync(root, { recursive: true });
  const id = `01a10000-0000-7000-8000-0000000000${suffix}`;
  const path = join(root, `2026-10-05T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-10-05T00:00:00.000Z",
        cwd: fixture.projectDir,
      }),
      JSON.stringify({ type: "message", role: "user", content: "restore regression fixture", timestamp: "2026-10-05T00:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  return path;
}

describe("daemon pool restore across a restart", () => {
  test("every live session is restored; explicit stops and exits are not", async () => {
    const fixture = fixtureDir();
    const { stateDir } = fixture;
    const stopped = fixtureTranscript(fixture, "0a");
    const exited = fixtureTranscript(fixture, "0b");
    const kept = fixtureTranscript(fixture, "0c");
    let daemon: Bun.Subprocess | null = null;
    try {
      daemon = await startDaemon(fixture.env);
      const a = await createRuntime({ resume: stopped });
      const b = await createRuntime({ resume: exited });
      const c = await createRuntime({ resume: kept });
      expect(a.sessionFile).toBe(stopped);
      expect(c.sessionFile).toBe(kept);
      await waitFor(async () => (await runtimes()).length === 3, "three live sessions");
      await waitFor(async () => (await ledgerFiles(stateDir)).length === 3, "three recorded sessions");

      // Explicit stop: the user's kill button.
      const deleted = await fetch(`${BASE}/api/runtimes/${a.id}`, { method: "DELETE" });
      expect(deleted.ok).toBe(true);
      // The stop is durable at once, not after the exit settle window.
      await waitFor(async () => (await ledgerFiles(stateDir)).join() === [exited, kept].join(), "the ledger to drop the stopped session");
      // Ordinary exit: omp quits inside its pane.
      await exitThroughAttach(b.id);
      await waitFor(async () => !(await runtimes()).some((entry) => entry.id === b.id), "the ordinary exit");
      await waitFor(async () => (await ledgerFiles(stateDir)).join() === kept, "the settled ledger to hold only the live session");
      await stopDaemon(daemon);
      daemon = null;
      // Shutdown preserved the snapshot: the session that was live at the end.
      expect(await ledgerFiles(stateDir)).toEqual([kept]);

      daemon = await startDaemon(fixture.env);
      await waitFor(async () => (await runtimes()).some((entry) => entry.sessionFile === kept), "the kept session to come back");
      const restored = await runtimes();
      expect(restored).toHaveLength(1);
      expect(restored[0].sessionFile).toBe(kept);
      expect(restored[0].cwd).toBe(fixture.projectDir);
      expect(restored[0].alive).toBe(true);
      expect(restored.some((entry) => entry.sessionFile === stopped)).toBe(false);
      expect(restored.some((entry) => entry.sessionFile === exited)).toBe(false);

      // A client resuming the same transcript must join the restored process,
      // not start a second writer for it.
      const raced = await createRuntime({ resume: kept });
      expect(raced.id).toBe(restored[0].id);
      expect((await runtimes()).filter((entry) => entry.sessionFile === kept)).toHaveLength(1);
    } finally {
      if (daemon) await stopDaemon(daemon);
      fixture.cleanup();
    }
  }, 90_000);

  test("sessions killed with the host are restored, not written off", async () => {
    const fixture = fixtureDir();
    const { stateDir } = fixture;
    const first = fixtureTranscript(fixture, "1a");
    const second = fixtureTranscript(fixture, "1b");
    let daemon: Bun.Subprocess | null = null;
    try {
      daemon = await startDaemon(fixture.env);
      const a = await createRuntime({ resume: first });
      const b = await createRuntime({ resume: second });
      await waitFor(async () => (await ledgerFiles(stateDir)).length === 2, "both sessions recorded");
      const pid = a.pid;
      if (pid === null) throw new Error("the resumed session has no pid");
      expect(b.sessionFile).toBe(second);

      // The teardown ordering that used to lose sessions: the child dies from a
      // signal that came from outside the daemon, and the daemon observes the
      // exit while it is still running. Its own SIGTERM follows immediately.
      killOutsideDaemon(pid);
      await waitFor(async () => !(await runtimes()).some((entry) => entry.id === a.id), "the daemon to see the external kill");
      await stopDaemon(daemon);
      daemon = null;
      expect((await ledgerFiles(stateDir)).sort()).toEqual([first, second].sort());

      daemon = await startDaemon(fixture.env);
      await waitFor(async () => (await runtimes()).length === 2, "both sessions to come back");
      const restored = await runtimes();
      expect(restored.map((entry) => entry.sessionFile).sort()).toEqual([first, second].sort());
      expect(restored.every((entry) => entry.alive && entry.cwd === fixture.projectDir)).toBe(true);
    } finally {
      if (daemon) await stopDaemon(daemon);
      fixture.cleanup();
    }
  }, 90_000);
});
