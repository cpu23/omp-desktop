/**
 * End-to-end regression for daemon-owned runtime settings and the restart
 * endpoint.
 *
 * A real isolated daemon is started for each scenario (temp state/session
 * directories, stand-in omp that stays alive) so the tests exercise the same
 * startup resolution, ledger restore, and HTTP surface a user's daemon uses:
 *
 * - the saved limit outranks `OMP_DESKTOP_MAX_RUNTIMES` and survives a restart,
 * - changing it reports `restartRequired` until the daemon restarts,
 * - a lower limit than the restorable pool is rejected instead of dropping
 *   sessions, and
 * - POST /api/restart answers before the old process disappears and the new
 *   process restores the ledger.
 *
 * The restart replaces the daemon process, so cleanup finds every daemon by a
 * unique environment marker rather than trusting the original child handle.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";
import type { SettingsPayload } from "./settings";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.OMP_DESKTOP_SETTINGS_TEST_PORT ?? 4327);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_ENV = "OMP_DESKTOP_TEST_TOKEN";

type RuntimeInfo = {
  id: string;
  alive: boolean;
  sessionFile: string | null;
};

type Fixture = {
  root: string;
  stateDir: string;
  sessionsDir: string;
  projectDir: string;
  token: string;
  env: Record<string, string>;
  transcripts: string[];
  cleanup: () => Promise<void>;
};

const roots: string[] = [];
const token = crypto.randomUUID();

afterAll(async () => {
  await stopDaemons();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omp-daemon-settings-test-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const sessionsDir = join(root, "sessions");
  const projectDir = join(root, "project");
  const transcriptDir = join(sessionsDir, "-fixture");
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const fakeOmp = join(root, "fake-omp");
  writeFileSync(fakeOmp, "#!/bin/sh\nread line\nexit 0\n");
  chmodSync(fakeOmp, 0o755);
  const transcript = (name: string): string => {
    const path = join(transcriptDir, `${name}.jsonl`);
    writeFileSync(path, "");
    return path;
  };
  const transcripts = [transcript("session-a"), transcript("session-b"), transcript("session-c")];
  const testToken = `${token}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    root,
    stateDir,
    sessionsDir,
    projectDir,
    token: testToken,
    transcripts,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OMP_DESKTOP_PORT: String(PORT),
      OMP_DESKTOP_STATE_DIR: stateDir,
      OMP_DESKTOP_SESSIONS_DIR: sessionsDir,
      OMP_DESKTOP_PASTE_DIR: join(root, "pastes"),
      OMP_DESKTOP_CWD: projectDir,
      OMP_DESKTOP_OMP: fakeOmp,
      // Keep the optional mobile extension, its sockets, and the user's real
      // token out of an isolated test.
      OMP_DESKTOP_EXTENSION: "",
      OMP_MOBILE_IPC_DIR: join(root, "mobile"),
      OMP_MOBILE_TOKEN_FILE: join(root, "missing-token"),
      [TOKEN_ENV]: testToken,
    },
    cleanup: async () => {
      await stopDaemons();
      rmSync(root, { recursive: true, force: true });
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
    },
  };
}

/** Every live daemon belonging to a test carries the token in its environment. */
async function stopDaemons(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      const marker = env.find((value) => value.startsWith(`${TOKEN_ENV}=`));
      if (!marker) continue;
      process.kill(Number(entry), "SIGTERM");
    } catch {
      // The process exited between the directory read and the environ read.
    }
  }
  // The daemon freezes its ledger and gives its PTY children a moment to go.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const alive = entries.some((entry) => {
      try {
        return /^[0-9]+$/.test(entry) && readFileSync(`/proc/${entry}/environ`, "utf8").includes(`${TOKEN_ENV}=`);
      } catch {
        return false;
      }
    });
    if (!alive) return;
    await Bun.sleep(50);
  }
}

async function startDaemon(env: Record<string, string>): Promise<Bun.Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "daemon.ts")], {
    cwd: env.OMP_DESKTOP_CWD,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/build`);
      if (res.ok) return proc;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`daemon failed to start: ${stderr.slice(0, 2000)}`);
}

async function readSettings(): Promise<SettingsPayload> {
  const res = await fetch(`${BASE}/api/settings`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.maxRuntimes !== "number" ||
    typeof body.effectiveMaxRuntimes !== "number" ||
    typeof body.restartRequired !== "boolean"
  ) {
    throw new Error(`bad settings payload: ${JSON.stringify(body)}`);
  }
  return {
    maxRuntimes: body.maxRuntimes,
    effectiveMaxRuntimes: body.effectiveMaxRuntimes,
    restartRequired: body.restartRequired,
  };
}

function putSettings(value: unknown): Promise<Response> {
  return fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function runtimes(): Promise<{ generation: string; runtimes: RuntimeInfo[] }> {
  const res = await fetch(`${BASE}/api/runtimes`);
  if (!res.ok) throw new Error(`GET /api/runtimes -> ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.generation !== "string" || !Array.isArray(body.runtimes)) {
    throw new Error("bad runtimes payload");
  }
  return {
    generation: body.generation,
    runtimes: body.runtimes.map((value): RuntimeInfo => {
      const record: Record<string, unknown> = isRecord(value) ? value : {};
      return {
        id: typeof record.id === "string" ? record.id : "",
        alive: record.alive === true,
        sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
      };
    }),
  };
}

async function startRuntime(transcript: string): Promise<RuntimeInfo> {
  const res = await fetch(`${BASE}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: transcript }),
  });
  if (!res.ok) throw new Error(`POST /api/runtimes -> ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  const runtime: Record<string, unknown> = isRecord(body) && isRecord(body.runtime) ? body.runtime : {};
  return {
    id: typeof runtime.id === "string" ? runtime.id : "",
    alive: runtime.alive === true,
    sessionFile: typeof runtime.sessionFile === "string" ? runtime.sessionFile : null,
  };
}

async function waitForGeneration(previous: string): Promise<{ generation: string; runtimes: RuntimeInfo[] }> {
  // The daemon is a separate OS process that binds and exits in real time, so
  // there is no deterministic timer seam: poll its observable HTTP state.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const current = await runtimes();
      if (current.generation !== previous) return current;
    } catch {
      // The old daemon is gone and the replacement has not bound the port yet.
    }
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for the restarted daemon");
}

describe("daemon runtime settings", () => {
  test(
    "saved limit outranks the env fallback, survives a restart, and restores the ledger",
    async () => {
      const f = fixture();
      try {
        await startDaemon({ ...f.env, OMP_DESKTOP_MAX_RUNTIMES: "4" });
        expect(await readSettings()).toEqual({
          maxRuntimes: 4,
          effectiveMaxRuntimes: 4,
          restartRequired: false,
        });

        const changed = await putSettings({ maxRuntimes: 20 });
        expect(changed.status).toBe(200);
        expect(await changed.json()).toEqual({
          maxRuntimes: 20,
          effectiveMaxRuntimes: 4,
          restartRequired: true,
        });

        const started = await startRuntime(f.transcripts[0]);
        expect(started.alive).toBe(true);
        expect(started.sessionFile).toBe(f.transcripts[0]);
        const before = await runtimes();
        expect(before.runtimes.map((runtime) => runtime.sessionFile)).toEqual([f.transcripts[0]]);

        const restart = await fetch(`${BASE}/api/restart`, { method: "POST" });
        expect(restart.status).toBe(202);
        expect(await restart.text()).toContain("restarting omp-desktopd");

        const restarted = await waitForGeneration(before.generation);
        expect(restarted.generation).not.toBe(before.generation);
        expect(restarted.runtimes.map((runtime) => runtime.sessionFile)).toEqual([f.transcripts[0]]);

        // The process now enforces the saved 20, not the env fallback of 4.
        expect(await readSettings()).toEqual({
          maxRuntimes: 20,
          effectiveMaxRuntimes: 20,
          restartRequired: false,
        });
      } finally {
        await f.cleanup();
      }
    },
    60_000,
  );

  test(
    "capacity failures are descriptive and refuse a limit below the restorable pool",
    async () => {
      const f = fixture();
      try {
        await startDaemon({ ...f.env, OMP_DESKTOP_MAX_RUNTIMES: "2" });
        expect(await readSettings()).toEqual({
          maxRuntimes: 2,
          effectiveMaxRuntimes: 2,
          restartRequired: false,
        });

        const first = await startRuntime(f.transcripts[0]);
        await startRuntime(f.transcripts[1]);
        const over = await fetch(`${BASE}/api/runtimes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resume: f.transcripts[2] }),
        });
        expect(over.status).toBe(409);
        const capacityMessage = await over.text();
        expect(capacityMessage).toContain("session limit reached");
        expect(capacityMessage).toContain("2/2");
        expect(capacityMessage).toContain("Settings");
        expect(capacityMessage).toContain("Stop a session");

        const unsafe = await putSettings({ maxRuntimes: 1 });
        expect(unsafe.status).toBe(400);
        const unsafeMessage = await unsafe.text();
        expect(unsafeMessage).toContain("2 live session(s)");
        expect(unsafeMessage).toContain("at least 2");

        for (const invalid of [{}, { maxRuntimes: 0 }, { maxRuntimes: "3" }, { maxRuntimes: 1.5 }, null]) {
          const rejected = await putSettings(invalid);
          expect(rejected.status).toBe(400);
          expect(await rejected.text()).toContain("positive integer");
        }
        expect((await readSettings()).maxRuntimes).toBe(2);

        // A limit equal to the restorable pool is safe: stop one session, then
        // persist 1. The running daemon still enforces 2 until it restarts.
        const stopped = await fetch(`${BASE}/api/runtimes/${first.id}`, { method: "DELETE" });
        expect(stopped.status).toBe(200);
        const lowered = await putSettings({ maxRuntimes: 1 });
        expect(lowered.status).toBe(200);
        expect(await lowered.json()).toEqual({
          maxRuntimes: 1,
          effectiveMaxRuntimes: 2,
          restartRequired: true,
        });

        // The old process still has two slots, but the pending saved limit is
        // one: an extra session now would be absent after the restart.
        const pending = await fetch(`${BASE}/api/runtimes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resume: f.transcripts[0] }),
        });
        expect(pending.status).toBe(409);
        expect(await pending.text()).toContain("after restart");

        const before = await runtimes();
        expect(before.runtimes).toHaveLength(1);
        const restart = await fetch(`${BASE}/api/restart`, { method: "POST" });
        expect(restart.status).toBe(202);
        const restarted = await waitForGeneration(before.generation);
        expect(restarted.runtimes.map((runtime) => runtime.sessionFile)).toEqual([f.transcripts[1]]);
        expect(await readSettings()).toEqual({
          maxRuntimes: 1,
          effectiveMaxRuntimes: 1,
          restartRequired: false,
        });
      } finally {
        await f.cleanup();
      }
    },
    60_000,
  );
});
