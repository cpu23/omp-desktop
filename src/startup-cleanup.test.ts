import { expect, test } from "bun:test";

// Exercise the exact daemon helper without importing its listening server.
// Its collaborators are deterministic so the disputed event order is explicit.
const source = await Bun.file(new URL("./daemon.ts", import.meta.url)).text();
const start = source.indexOf("async function retireUnadmittedFreshRuntime(");
const end = source.indexOf("/** The host, not a cached status", start);
if (start < 0 || end < start) throw new Error("startup cleanup helper not found");
const helper = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));

test("startup cleanup releases a confirmed cancellation at its final deadline", async () => {
  const file = "/fixture/startup.jsonl";
  let now = 0;
  let readyListener: (() => void) | undefined;
  let statusCalls = 0;
  let cancellations = 0;
  const runtime = {
    id: "rt-cleanup-deadline", alive: true, ready: false, sessionFile: file,
    subscribeReady(listener: () => void) { readyListener = listener; return () => { readyListener = undefined; }; },
    subscribeExit(_listener: () => void) { return () => {}; },
  };
  const unloadingBySession = new Map<string, unknown>();
  const unloadingRuntimes = new Set<unknown>();
  const status = { sessionFile: file, unloading: false, idleSince: 0, reasons: [] };
  const idleClient = {
    async status() {
      if (++statusCalls > 1) {
        runtime.ready = true;
        readyListener!();
        // Cancellation is accepted while cleanup is still awaiting its final
        // status read, before that read crosses the cleanup deadline.
        for (let tick = 0; tick < 5; tick++) await Promise.resolve();
        now = 5_001;
      }
      return { kind: "available", status };
    },
    async unload() { status.unloading = true; return { kind: "accepted" }; },
    async cancelUnload() { cancellations++; status.unloading = false; return { kind: "accepted" }; },
  };
  const run = new Function("manager", "unloadingBySession", "unloadingRuntimes", "requestingSessions",
    "idleClient", "shuttingDown", "Date", "Bun", `${helper}; return retireUnadmittedFreshRuntime;`)(
    { get: () => runtime }, unloadingBySession, unloadingRuntimes, new Set(), idleClient,
    false, { now: () => now }, { sleep: async () => {} },
  ) as (runtime: unknown) => Promise<void>;
  await run(runtime);
  expect(statusCalls).toBe(2);
  expect(cancellations).toBe(1);
  expect(runtime.ready).toBe(true);
  expect(runtime.alive).toBe(true);
  expect(unloadingBySession.has(file)).toBe(false);
  expect(unloadingRuntimes.has(runtime)).toBe(false);
});
