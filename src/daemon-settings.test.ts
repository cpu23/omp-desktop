import { describe, expect, test } from "bun:test";
import { isRecord } from "./guards";
import type { SettingsPayload } from "./settings";
import { startTestDaemon, writeTestTranscript, type TestDaemon } from "../scripts/fixtures/daemon";

type RuntimeInfo = { id: string; alive: boolean; pid: number | null; sessionFile: string | null };
type PoolSnapshot = { generation: string; runtimes: RuntimeInfo[] };

async function readSettings(daemon: TestDaemon): Promise<SettingsPayload> {
  const response = await fetch(`${daemon.base}/api/settings`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    !isRecord(body) || typeof body.maxRuntimes !== "number" ||
    typeof body.effectiveMaxRuntimes !== "number" || typeof body.restartRequired !== "boolean"
  ) throw new Error(`bad settings payload: ${JSON.stringify(body)}`);
  return {
    maxRuntimes: body.maxRuntimes,
    effectiveMaxRuntimes: body.effectiveMaxRuntimes,
    restartRequired: body.restartRequired,
  };
}

function putSettings(daemon: TestDaemon, value: unknown): Promise<Response> {
  return fetch(`${daemon.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function runtimes(daemon: TestDaemon): Promise<PoolSnapshot> {
  const response = await fetch(`${daemon.base}/api/runtimes`);
  if (!response.ok) throw new Error(`GET /api/runtimes -> ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.generation !== "string" || !Array.isArray(body.runtimes)) {
    throw new Error("bad runtimes payload");
  }
  return {
    generation: body.generation,
    runtimes: body.runtimes.map((value): RuntimeInfo => {
      const record = isRecord(value) ? value : {};
      return {
        id: typeof record.id === "string" ? record.id : "",
        alive: record.alive === true,
        pid: typeof record.pid === "number" ? record.pid : null,
        sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
      };
    }),
  };
}

async function startRuntime(daemon: TestDaemon, transcript: string): Promise<RuntimeInfo> {
  const response = await fetch(`${daemon.base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: transcript }),
  });
  if (!response.ok) throw new Error(`POST /api/runtimes -> ${response.status} ${await response.text()}`);
  const body: unknown = await response.json();
  const runtime = isRecord(body) && isRecord(body.runtime) ? body.runtime : {};
  return {
    id: typeof runtime.id === "string" ? runtime.id : "",
    alive: runtime.alive === true,
    pid: typeof runtime.pid === "number" ? runtime.pid : null,
    sessionFile: typeof runtime.sessionFile === "string" ? runtime.sessionFile : null,
  };
}

describe("daemon runtime settings", () => {
  test("saved limit outranks the environment fallback and survives API restart with ledger recovery", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_MAX_RUNTIMES: "4" } });
    try {
      expect(await readSettings(daemon)).toEqual({ maxRuntimes: 4, effectiveMaxRuntimes: 4, restartRequired: false });
      const changed = await putSettings(daemon, { maxRuntimes: 20 });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ maxRuntimes: 20, effectiveMaxRuntimes: 4, restartRequired: true });

      const transcript = await writeTestTranscript(daemon.root, "settings-restart");
      const started = await startRuntime(daemon, transcript);
      expect(started.alive).toBe(true);
      expect(started.pid).toEqual(expect.any(Number));
      expect(started.sessionFile).toBe(transcript);
      const before = await runtimes(daemon);
      expect(before.runtimes.map((runtime) => runtime.sessionFile)).toEqual([transcript]);

      await daemon.restart();
      expect(daemon.generation).not.toBe(before.generation);
      const restarted = await runtimes(daemon);
      expect(restarted.generation).not.toBe(before.generation);
      expect(restarted.runtimes.map((runtime) => runtime.sessionFile)).toEqual([transcript]);
      expect(await readSettings(daemon)).toEqual({ maxRuntimes: 20, effectiveMaxRuntimes: 20, restartRequired: false });
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("capacity errors remain descriptive and unsafe limits cannot drop restorable sessions", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_MAX_RUNTIMES: "2" } });
    try {
      expect(await readSettings(daemon)).toEqual({ maxRuntimes: 2, effectiveMaxRuntimes: 2, restartRequired: false });
      const transcripts = await Promise.all(["capacity-one", "capacity-two", "capacity-three"].map((name) =>
        writeTestTranscript(daemon.root, name),
      ));
      const first = await startRuntime(daemon, transcripts[0]!);
      await startRuntime(daemon, transcripts[1]!);
      const over = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: transcripts[2] }),
      });
      expect(over.status).toBe(409);
      const capacityMessage = await over.text();
      expect(capacityMessage).toContain("session limit reached");
      expect(capacityMessage).toContain("2/2");
      expect(capacityMessage).toContain("Settings");
      expect(capacityMessage).toContain("Stop a session");

      const unsafe = await putSettings(daemon, { maxRuntimes: 1 });
      expect(unsafe.status).toBe(400);
      const unsafeMessage = await unsafe.text();
      expect(unsafeMessage).toContain("2 live session(s)");
      expect(unsafeMessage).toContain("at least 2");
      for (const invalid of [{}, { maxRuntimes: 0 }, { maxRuntimes: "3" }, { maxRuntimes: 1.5 }, null]) {
        const rejected = await putSettings(daemon, invalid);
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain("positive integer");
      }
      expect((await readSettings(daemon)).maxRuntimes).toBe(2);

      const stopped = await fetch(`${daemon.base}/api/runtimes/${first.id}`, { method: "DELETE" });
      expect(stopped.status).toBe(200);
      const lowered = await putSettings(daemon, { maxRuntimes: 1 });
      expect(lowered.status).toBe(200);
      expect(await lowered.json()).toEqual({ maxRuntimes: 1, effectiveMaxRuntimes: 2, restartRequired: true });

      const pending = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: transcripts[0] }),
      });
      expect(pending.status).toBe(409);
      expect(await pending.text()).toContain("after restart");

      const before = await runtimes(daemon);
      expect(before.runtimes).toHaveLength(1);
      const reattached = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: transcripts[1] }),
      });
      expect(reattached.status).toBe(200);
      const reattachedBody: unknown = await reattached.json();
      expect(isRecord(reattachedBody) && isRecord(reattachedBody.runtime) ? reattachedBody.runtime.id : null)
        .toBe(before.runtimes[0]!.id);
      expect((await runtimes(daemon)).runtimes).toHaveLength(1);

      await daemon.restart();
      const restarted = await runtimes(daemon);
      expect(restarted.generation).not.toBe(before.generation);
      expect(restarted.runtimes.map((runtime) => runtime.sessionFile)).toEqual([transcripts[1]]);
      expect(await readSettings(daemon)).toEqual({ maxRuntimes: 1, effectiveMaxRuntimes: 1, restartRequired: false });
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("a pending lower limit caps fresh reservations before they have transcripts", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_MAX_RUNTIMES: "2" } });
    try {
      const lowered = await putSettings(daemon, { maxRuntimes: 1 });
      expect(lowered.status).toBe(200);
      expect(await lowered.json()).toEqual({ maxRuntimes: 1, effectiveMaxRuntimes: 2, restartRequired: true });

      const first = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(first.status).toBe(200);
      const firstBody: unknown = await first.json();
      if (!isRecord(firstBody) || !isRecord(firstBody.runtime) || typeof firstBody.runtime.id !== "string") {
        throw new Error(`bad runtime payload: ${JSON.stringify(firstBody)}`);
      }
      expect(firstBody.runtime.sessionFile).toBeNull();

      const second = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(409);
      const message = await second.text();
      expect(message).toContain("session limit reached");
      expect(message).toContain("1/1");
      expect(message).toContain("after restart");
      expect((await runtimes(daemon)).runtimes).toHaveLength(1);

      expect((await fetch(`${daemon.base}/api/runtimes/${firstBody.runtime.id}`, { method: "DELETE" })).status).toBe(200);
      const attempts = await Promise.all(Array.from({ length: 2 }, () => fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })));
      expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
      expect((await runtimes(daemon)).runtimes).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
