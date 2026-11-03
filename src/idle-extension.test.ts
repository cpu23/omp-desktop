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
    const context = {
      cwd: root,
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getAsyncJobSnapshot: () => [],
      getPendingPlanReview: () => null,
      setInterval: () => 1,
      setTimeout: () => 1,
      clearTimer() {},
      shutdown() {},
      sessionManager,
    };

    try {
      registerDesktopIdleExtension(host);
      handlers.get("session_start")?.({}, context);
      handlers.get("tool_execution_end")?.({
        toolCallId: "service-call",
        toolName: "bash",
        result: { details: { service: { name: "named-service", cwd: root } } },
      }, context);
      const client = new IdleRuntimeClient({ dir: socketDir, token: environment.OMP_DESKTOP_IDLE_IPC_TOKEN });
      const status = await client.status(runtimeId);
      expect(status.kind).toBe("available");
      const invocation = JSON.parse(await readFile(invocationFile, "utf8")) as string[];
      expect(invocation).toEqual(expectedArgs);
      if (status.kind === "available") {
        expect(status.status.reasons).not.toContain("service_registry_unavailable");
        expect(status.status.reasons).toContain("named_bash_service_running");
        expect(status.status.unloading).toBe(false);
      }
    } finally {
      handlers.get("session_shutdown")?.({}, context);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20_000);
});
