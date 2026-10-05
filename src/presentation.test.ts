/**
 * Behavioral tests for the extension-socket reader that feeds sidebar
 * presentation. The boundaries that matter: a valid `/status` answer becomes a
 * validated presentation; a missing, wedged, unauthorized, over-permissive or
 * broken socket resolves to `null` (unavailable) instead of throwing, stalling
 * or publishing a guessed working/done state; successful reads are cached.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresentationReader } from "./presentation";

const ID = "rt-presentation-test";
const servers: Array<{ stop: () => void }> = [];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-presentation-"));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  rmSync(dir, { recursive: true, force: true });
});

function serve(handler: (path: string, request: Request) => Response): { requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    unix: join(dir, `${ID}.sock`),
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return handler(path, request);
    },
  });
  chmodSync(join(dir, `${ID}.sock`), 0o600);
  servers.push({ stop: () => server.stop(true) });
  return { requests };
}

describe("presentation reader", () => {
  test("reads presentation from a live extension socket, ignoring snapshot extras", async () => {
    serve(() =>
      Response.json({
        accent: "#ff8800",
        agentActive: true,
        completion: { identity: "gen:2", generation: "gen", turn: 2, completedAt: 1730000000000 },
        messages: [{ role: "user" }],
      }),
    );
    const reader = new PresentationReader({ dir });
    expect(await reader.read(ID)).toEqual({
      accent: "#ff8800",
      agentActive: true,
      completion: { identity: "gen:2", completedAt: 1730000000000 },
    });
  });

  test("a quiet runtime reads as agentActive false without a completion", async () => {
    serve(() => Response.json({ accent: null, agentActive: false }));
    const reader = new PresentationReader({ dir });
    expect(await reader.read(ID)).toEqual({ accent: null, agentActive: false, completion: null });
  });

  test("a missing socket is unavailable", async () => {
    const reader = new PresentationReader({ dir, timeoutMs: 200 });
    expect(await reader.read(ID)).toBeNull();
  });

  test("a socket that never answers is unavailable within the deadline", async () => {
    const server = createServer(() => {
      // Hold the connection open without answering.
    });
    const listening = Promise.withResolvers<void>();
    server.listen(join(dir, `${ID}.sock`), () => listening.resolve());
    await listening.promise;
    chmodSync(join(dir, `${ID}.sock`), 0o600);

    const reader = new PresentationReader({ dir, timeoutMs: 150, failTtlMs: 0 });
    const started = Date.now();
    expect(await reader.read(ID)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);

    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });

  test("a socket readable by others is refused", async () => {
    serve(() => Response.json({ accent: "#123456", agentActive: false }));
    chmodSync(join(dir, `${ID}.sock`), 0o666);
    const reader = new PresentationReader({ dir, failTtlMs: 0 });
    expect(await reader.read(ID)).toBeNull();
  });

  test("the shared token gates the read", async () => {
    serve((_path, request) =>
      request.headers.get("authorization") === "Bearer secret-token"
        ? Response.json({ accent: "#123456", agentActive: true })
        : Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const denied = new PresentationReader({ dir, token: "wrong-token", failTtlMs: 0 });
    expect(await denied.read(ID)).toBeNull();
    const allowed = new PresentationReader({ dir, token: "secret-token", failTtlMs: 0 });
    expect(await allowed.read(ID)).toEqual({ accent: "#123456", agentActive: true, completion: null });
  });

  test("malformed bodies resolve unavailable, never a guessed state", async () => {
    serve(() => new Response("not json", { status: 200 }));
    const reader = new PresentationReader({ dir, failTtlMs: 0 });
    expect(await reader.read(ID)).toBeNull();
  });

  test("a body without a boolean agentActive is unavailable", async () => {
    serve(() => Response.json({ accent: "#ffffff", agentActive: "yes" }));
    const reader = new PresentationReader({ dir, failTtlMs: 0 });
    expect(await reader.read(ID)).toBeNull();
  });

  test("an oversized status body is refused", async () => {
    serve(() => Response.json({ accent: "#ffffff", agentActive: false, pad: "x".repeat(64 * 1024) }));
    const reader = new PresentationReader({ dir, failTtlMs: 0 });
    expect(await reader.read(ID)).toBeNull();
  });

  test("successful reads are reused within the TTL", async () => {
    const socket = serve(() => Response.json({ accent: "#010203", agentActive: false }));
    const reader = new PresentationReader({ dir, okTtlMs: 1000, failTtlMs: 0 });
    await reader.read(ID);
    await reader.read(ID);
    expect(socket.requests.length).toBe(1);
  });
});
