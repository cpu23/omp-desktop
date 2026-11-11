import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerDesktopIdleExtension from "./idle-extension";
import { IdleRuntimeClient } from "./idle-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type EventHandler = (event: unknown, ctx?: unknown) => void;

describe("desktop idle service registry executable selection", () => {
  test("queries a configured interpreter/shebang OMP CLI with argv-safe prefix arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-idle-registry-"));
    roots.push(root);
    const executable = join(root, "fixture omp cli");
    const invocationFile = join(root, "invocation.json");
    const socketDir = join(root, "i");
    const runtimeId = "rt-registry-fixture";
    const sessionFile = join(root, "session.jsonl");
    const sessionId = "registry-fixture";
    const expectedArgs = ["--fixture-option", "fixed;literal", "ps", "list", "--json", "--all"];
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OMP_IDLE_TEST_INVOCATION!, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify([{ kind: "project", projectDir: process.cwd(), daemons: [{ name: "named-service", cwd: process.cwd(), state: "running" }] }]));\n`);
    await chmod(executable, 0o700);

    const previous = new Map<string, string | undefined>();
    const environment: Record<string, string> = {
      OMP_MOBILE_SLOT: runtimeId,
      OMP_DESKTOP_IDLE_IPC_DIR: socketDir,
      OMP_DESKTOP_IDLE_IPC_TOKEN: "test-only-idle-token-12345",
      OMP_DESKTOP_OMP: executable,
      OMP_DESKTOP_OMP_ARGS: "--fixture-option fixed;literal",
      OMP_IDLE_TEST_INVOCATION: invocationFile,
    };
    for (const [key, value] of Object.entries(environment)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    const sessionManager = {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
      getBranch: () => [],
    };
    const session = {
      sessionManager,
      hasAdmittedSubmission: false,
      hasPendingAsyncWork: () => false,
    };
    const handlers = new Map<string, EventHandler>();
    const host = {
      on(event: string, handler: EventHandler) { handlers.set(event, handler); },
      pi: {
        AgentRegistry: {
          global: () => ({ list: () => [{
            id: "main-registry-fixture",
            kind: "main",
            status: "idle",
            sessionFile,
            session,
          }] }),
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    } as Parameters<typeof registerDesktopIdleExtension>[0];
    const shutdownCallbacks: Array<() => void> = [];
    let shutdowns = 0;
    const context = {
      cwd: root,
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
      getPendingPlanReview: () => null,
      setInterval: () => 1,
      setTimeout: (callback: () => void) => { shutdownCallbacks.push(callback); return 1; },
      clearTimer() {},
      shutdown() { shutdowns += 1; },
      sessionManager,
    };

    try {
      registerDesktopIdleExtension(host);
      handlers.get("session_start")?.({}, context);
      // Exercise the real receiver independently of the client's size guard.
      const overhead = Buffer.byteLength(JSON.stringify({ sessionFile, padding: "" }));
      const boundaryBody = JSON.stringify({ sessionFile, padding: "x".repeat(128 * 1024 - overhead) });
      for (const [body, expectedStatus] of [[boundaryBody, 400], [boundaryBody + " ", 413]] as const) {
        const response = await fetch("http://localhost/unload", {
          unix: join(socketDir, `${runtimeId}.sock`),
          method: "POST",
          headers: { authorization: `Bearer ${environment.OMP_DESKTOP_IDLE_IPC_TOKEN}`, "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(expectedStatus);
        expect((await response.json() as { reason: string }).reason)
          .toBe(expectedStatus === 413 ? "body_too_large" : "invalid_idle_timeout");
      }

      const client = new IdleRuntimeClient({ dir: socketDir, token: environment.OMP_DESKTOP_IDLE_IPC_TOKEN });
      handlers.get("tool_execution_end")?.({
        toolCallId: "service-call",
        toolName: "bash",
        result: { details: { service: { name: "named-service", cwd: root } } },
      }, context);
      const status = await client.status(runtimeId);
      expect(status.kind).toBe("available");
      const invocation = JSON.parse(await readFile(invocationFile, "utf8")) as string[];
      expect(invocation).toEqual(expectedArgs);
      if (status.kind === "available") {
        expect(status.status.reasons).not.toContain("service_registry_unavailable");
        expect(status.status.reasons).toContain("named_bash_service_running");
        expect(status.status.unloading).toBe(false);
      }
      handlers.get("session_shutdown")?.({}, context);
      registerDesktopIdleExtension(host);
      handlers.get("session_start")?.({}, context);
      await client.status(runtimeId);
      await Bun.sleep(5);
      const attemptId = "test-unload";
      const unload = await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId });
      expect(unload.kind, JSON.stringify(unload)).toBe("accepted");
      const cancel = await client.cancelUnload(runtimeId, { sessionFile, attemptId });
      expect(cancel.kind).toBe("accepted");
      const reopened = await client.status(runtimeId);
      expect(reopened.kind).toBe("available");
      if (reopened.kind === "available") expect(reopened.status.unloading).toBe(false);

      // Cancellation before arrival must also reject a delayed/replayed unload.
      expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: "early" })).kind).toBe("accepted");
      await Bun.sleep(5);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId: "early" }))
          .toEqual({ kind: "conflict", reason: "unload_cancelled" });
      }
      expect((await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId: "next" })).kind).toBe("accepted");
      // A host may already have queued a cancelled callback and reuse its handle.
      shutdownCallbacks[0]!();
      expect(shutdowns).toBe(0);
      shutdownCallbacks[1]!();
      expect(shutdowns).toBe(1);
      expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: "next" })).kind).toBe("conflict");

      handlers.get("session_shutdown")?.({}, context);
      registerDesktopIdleExtension(host);
      handlers.get("session_start")?.({}, context);
      await client.status(runtimeId);
      expect(await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId: "x".repeat(129) }))
        .toEqual({ kind: "conflict", reason: "invalid_attempt_id" });
      for (let index = 0; index < 127; index++) {
        expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: `reserved-${index}` })).kind)
          .toBe("accepted");
      }
      await Bun.sleep(5);
      const callbackCount = shutdownCallbacks.length;
      expect((await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId: "last-slot" })).kind)
        .toBe("accepted");
      expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: "unrelated" })).kind)
        .not.toBe("accepted");
      expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: "last-slot" })).kind)
        .toBe("accepted");
      shutdownCallbacks[callbackCount]!();
      expect(shutdowns).toBe(1);
      await client.status(runtimeId);
      await Bun.sleep(5);
      expect((await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1, attemptId: "over-capacity" })).kind)
        .toBe("unavailable");
      const full = await fetch("http://localhost/unload", {
        unix: join(socketDir, `${runtimeId}.sock`), method: "POST",
        headers: { authorization: `Bearer ${environment.OMP_DESKTOP_IDLE_IPC_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionFile, idleTimeoutMs: 1, attemptId: "still-over-capacity" }),
      });
      expect(full.status).toBe(503);
      expect(await full.json()).toEqual({ kind: "unavailable", reason: "cancellation_capacity" });
      expect(shutdownCallbacks.length).toBe(callbackCount + 1);
      // Idempotent cancellation and ordinary idle unload still work at capacity.
      expect((await client.cancelUnload(runtimeId, { sessionFile, attemptId: "last-slot" })).kind)
        .toBe("accepted");
      expect((await client.unload(runtimeId, { sessionFile, idleTimeoutMs: 1 })).kind).toBe("accepted");
      shutdownCallbacks.at(-1)!();
      expect(shutdowns).toBe(2);
    } finally {
      handlers.get("session_shutdown")?.({}, context);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20_000);
});
