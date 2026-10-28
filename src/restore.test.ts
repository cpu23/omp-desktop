import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";
import { startTestDaemon, writeTestTranscript, type TestDaemon } from "../scripts/fixtures/daemon";

type RuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cwd: string;
  sessionFile: string | null;
  status: string;
};

function runtimeFrom(value: unknown): RuntimeInfo {
  if (!isRecord(value)) throw new Error("runtime payload is not an object");
  return {
    id: typeof value.id === "string" ? value.id : "",
    alive: value.alive === true,
    pid: typeof value.pid === "number" ? value.pid : null,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
    status: typeof value.status === "string" ? value.status : "",
  };
}

async function runtimes(base: string): Promise<RuntimeInfo[]> {
  const response = await fetch(`${base}/api/runtimes`);
  if (!response.ok) throw new Error(`GET /api/runtimes -> ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.runtimes)) throw new Error("bad runtimes payload");
  return body.runtimes.map(runtimeFrom);
}

async function createRuntime(base: string, request: Record<string, unknown>): Promise<RuntimeInfo> {
  const response = await fetch(`${base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`POST /api/runtimes ${JSON.stringify(request)} -> ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("bad create payload");
  return runtimeFrom(body.runtime);
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function exitThroughAttach(base: string, runtimeId: string): Promise<void> {
  const ws = new WebSocket(`ws://${new URL(base).host}/ws/term?runtime=${encodeURIComponent(runtimeId)}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`websocket to ${runtimeId} failed`));
    });
    ws.send(JSON.stringify({ type: "input", data: "exit 0\n" }));
    await waitFor(async () => !(await runtimes(base)).some((entry) => entry.id === runtimeId), "the fake OMP command to exit");
  } finally {
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else {
        ws.onclose = () => resolve();
        ws.close();
      }
    });
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

function killPtyGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

async function ptyGroupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, 0);
        return true;
      } catch (inner) {
        return (inner as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    return true;
  }
}

async function terminatePtyGroups(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      try {
        process.kill(pid, "SIGTERM");
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
    }
  }
  const termDeadline = Date.now() + 20_000;
  while (Date.now() < termDeadline && (await Promise.all(pids.map(ptyGroupExists))).some(Boolean)) {
    await Bun.sleep(50);
  }
  const survivors: number[] = [];
  for (const pid of pids) {
    if (!(await ptyGroupExists(pid))) continue;
    survivors.push(pid);
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      try {
        process.kill(pid, "SIGKILL");
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
    }
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && (await Promise.all(survivors.map(ptyGroupExists))).some(Boolean)) {
    await Bun.sleep(50);
  }
  const alive: number[] = [];
  for (const pid of survivors) if (await ptyGroupExists(pid)) alive.push(pid);
  if (alive.length) throw new Error(`owned PTY groups survived SIGKILL: ${alive.join(", ")}`);
}

describe("daemon pool restore across restart", () => {
  test("live sessions return; explicit stops and ordinary exits do not", async () => {
    const daemon = await startTestDaemon();
    try {
      const projectDir = join(daemon.root, "project");
      const stopped = await writeTestTranscript(daemon.root, "restore-stopped", { cwd: projectDir });
      const exited = await writeTestTranscript(daemon.root, "restore-exited", { cwd: projectDir });
      const kept = await writeTestTranscript(daemon.root, "restore-kept", { cwd: projectDir });
      const a = await createRuntime(daemon.base, { resume: stopped });
      const b = await createRuntime(daemon.base, { resume: exited });
      const c = await createRuntime(daemon.base, { resume: kept });
      expect(a.sessionFile).toBe(stopped);
      expect(c.sessionFile).toBe(kept);
      await waitFor(async () => (await runtimes(daemon.base)).length === 3, "three live sessions");
      await waitFor(async () => (await ledgerFiles(join(daemon.root, "state"))).length === 3, "three recorded sessions");

      const deleted = await fetch(`${daemon.base}/api/runtimes/${a.id}`, { method: "DELETE" });
      expect(deleted.ok).toBe(true);
      await waitFor(
        async () => (await ledgerFiles(join(daemon.root, "state"))).sort().join() === [exited, kept].sort().join(),
        "the ledger to drop the explicitly stopped session",
      );

      await exitThroughAttach(daemon.base, b.id);
      await waitFor(async () => !(await runtimes(daemon.base)).some((entry) => entry.id === b.id), "ordinary process exit");
      await waitFor(
        async () => (await ledgerFiles(join(daemon.root, "state"))).join() === kept,
        "the settled ledger to hold only the live session",
      );
      await daemon.restart();
      expect(await ledgerFiles(join(daemon.root, "state"))).toEqual([kept]);
      await waitFor(
        async () => (await runtimes(daemon.base)).some((entry) => entry.sessionFile === kept),
        "the kept session to return",
      );
      const restored = await runtimes(daemon.base);
      expect(restored).toHaveLength(1);
      expect(restored[0]!.sessionFile).toBe(kept);
      expect(restored[0]!.cwd).toBe(projectDir);
      expect(restored[0]!.alive).toBe(true);
      expect(restored.some((entry) => entry.sessionFile === stopped || entry.sessionFile === exited)).toBe(false);

      const raced = await createRuntime(daemon.base, { resume: kept });
      expect(raced.id).toBe(restored[0]!.id);
      expect((await runtimes(daemon.base)).filter((entry) => entry.sessionFile === kept)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  }, 90_000);

  test("a child killed during host teardown is retained in the committed ledger", async () => {
    const daemon = await startTestDaemon();
    try {
      const first = await writeTestTranscript(daemon.root, "external-kill-first");
      const second = await writeTestTranscript(daemon.root, "external-kill-second");
      const a = await createRuntime(daemon.base, { resume: first });
      const b = await createRuntime(daemon.base, { resume: second });
      await waitFor(async () => (await ledgerFiles(join(daemon.root, "state"))).length === 2, "both sessions recorded");
      if (a.pid === null) throw new Error("resumed session did not start a PTY");
      expect(b.sessionFile).toBe(second);

      killPtyGroup(a.pid);
      await waitFor(async () => !(await runtimes(daemon.base)).some((entry) => entry.id === a.id), "external PTY death");
      await daemon.restart();
      const restored = await runtimes(daemon.base);
      expect(restored).toHaveLength(2);
      expect(restored.map((entry) => entry.sessionFile).sort()).toEqual([first, second].sort());
      expect(restored.every((entry) => entry.alive)).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 90_000);

  test("a committed ledger survives daemon-only death and omits missing transcripts on recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-restore-recovery-"));
    let daemon = await startTestDaemon({ root });
    let replacement: TestDaemon | null = null;
    let pids: number[] = [];
    try {
      const projectDir = join(root, "project");
      const first = await writeTestTranscript(root, "committed-ledger-first", { cwd: projectDir });
      const second = await writeTestTranscript(root, "committed-ledger-second", { cwd: projectDir });
      const missing = await writeTestTranscript(root, "committed-ledger-missing", { cwd: projectDir });
      const entries = await Promise.all([first, second, missing].map((sessionFile) =>
        createRuntime(daemon.base, { resume: sessionFile }),
      ));
      expect(entries.every((entry) => entry.pid !== null)).toBe(true);
      await waitFor(async () => (await ledgerFiles(join(root, "state"))).length === 3, "three committed ledger entries");
      await rm(missing);

      pids = entries.map((entry) => entry.pid!).filter((pid) => Number.isInteger(pid));
      daemon.proc.kill("SIGKILL");
      await daemon.proc.exited;
      await daemon.stop();

      replacement = await startTestDaemon({ root });
      await waitFor(async () => (await runtimes(replacement!.base)).length === 2, "the valid ledger entries to restore");
      const restored = await runtimes(replacement.base);
      expect(restored.map((entry) => entry.sessionFile).sort()).toEqual([first, second].sort());
      expect(restored.every((entry) => entry.alive && entry.cwd === projectDir)).toBe(true);
      expect(restored.some((entry) => entry.sessionFile === missing)).toBe(false);
      await terminatePtyGroups(pids);
    } finally {
      try {
        if (replacement) await replacement.stop();
        else await daemon.stop();
      } finally {
        try {
          if (pids.length > 0) await terminatePtyGroups(pids);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 90_000);
});
