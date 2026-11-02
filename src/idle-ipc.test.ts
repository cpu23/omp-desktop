import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { IdleRuntimeClient } from "./idle-ipc";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const statusBody = {
  hostId: "host-a",
  sessionId: "session-a",
  sessionFile: "/sessions/a.jsonl",
  idleSince: 1_000,
  reasons: [],
  revision: 3,
  unloading: false,
};

describe("desktop idle IPC client", () => {
  test("authenticates, parses typed status, queues large follow-up prompts, and reports conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-desktop-idle-ipc-"));
    roots.push(root);
    const socketPath = join(root, "rt-test-1.sock");
    let promptText = "";
    let requests = 0;
    const server = Bun.serve({
      unix: socketPath,
      fetch: async (request) => {
        requests++;
        if (request.headers.get("authorization") !== "Bearer test-token") {
          return Response.json({ kind: "unavailable", reason: "unauthorized" }, { status: 401 });
        }
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/status") return Response.json(statusBody);
        if (request.method === "POST" && path === "/prompt") {
          const body = await request.json() as { text?: unknown };
          promptText = typeof body.text === "string" ? body.text : "";
          return Response.json({ kind: "accepted" }, { status: 202 });
        }
        if (request.method === "POST" && path === "/unload") {
          return Response.json({ kind: "conflict", reason: "agent_active" }, { status: 409 });
        }
        return Response.json({ kind: "unavailable", reason: "not_found" }, { status: 404 });
      },
    });
    servers.push(server);
    await chmod(socketPath, 0o600);

    const client = new IdleRuntimeClient({ dir: root, token: "test-token" });
    expect(await client.status("rt-test-1")).toEqual({ kind: "available", status: statusBody });
    const largePrompt = "x".repeat(20 * 1024);
    expect(await client.prompt("rt-test-1", { sessionFile: statusBody.sessionFile, text: largePrompt }))
      .toEqual({ kind: "accepted" });
    expect(promptText).toBe(largePrompt);
    expect(await client.unload("rt-test-1", { sessionFile: statusBody.sessionFile, idleTimeoutMs: 60_000 }))
      .toEqual({ kind: "conflict", reason: "agent_active" });
    const beforeOversized = requests;
    expect(await client.prompt("rt-test-1", {
      sessionFile: statusBody.sessionFile,
      text: "x".repeat(128 * 1024),
    })).toEqual({ kind: "unavailable", reason: "ipc_unavailable" });
    expect(requests).toBe(beforeOversized);

    const unauthenticated = new IdleRuntimeClient({ dir: root, token: "wrong-token" });
    expect(await unauthenticated.status("rt-test-1")).toEqual({ kind: "unavailable", reason: "status_unavailable" });
  });
});
