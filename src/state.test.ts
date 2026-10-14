/**
 * Regression tests for the durable stores.
 *
 * The runtime ledger is what makes session restoration survive a daemon
 * restart: it is written by the daemon (never by a client) and replayed on
 * start, so a missing, corrupt, or oversized file must degrade to "nothing to
 * restore" instead of failing startup, and the last snapshot must always win
 * over a slow in-flight write. The workspace store shares the atomic writer
 * these tests also pin (a rewrite must be complete, never truncated).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_LIMIT_BYTES, RuntimeLedgerStore, WorkspaceStateStore } from "./state";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-state-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runtime ledger", () => {
  test("a missing ledger reads as no sessions", async () => {
    const store = new RuntimeLedgerStore(join(await tempDir(), "sessions.json"));
    expect(await store.read()).toEqual([]);
  });

  test("a snapshot round-trips with its restore fields", async () => {
    const dir = await tempDir();
    const store = new RuntimeLedgerStore(join(dir, "sessions.json"));
    const sessions = [
      { sessionFile: "/home/user/.omp/agent/sessions/-dev/2026-10-05T00-00-00-000Z_a.jsonl", cwd: "/home/user/dev", cols: 123, rows: 35 },
      { sessionFile: "/home/user/.omp/agent/sessions/-dev/2026-10-05T00-00-00-000Z_b.jsonl", cwd: "/home/user/dev/demo-project" },
    ];
    await store.save(sessions);
    expect(await store.read()).toEqual(sessions);
  });

  test("writes are serialized and the last snapshot wins", async () => {
    const dir = await tempDir();
    const store = new RuntimeLedgerStore(join(dir, "sessions.json"));
    const first = { sessionFile: "/s/a.jsonl", cwd: "/one" };
    const second = { sessionFile: "/s/b.jsonl", cwd: "/two" };
    const pending = [store.save([first]), store.save([second])];
    await Promise.all(pending);
    expect(await store.read()).toEqual([second]);
  });

  test("corrupt, unknown-version, and malformed ledgers read as no sessions", async () => {
    const dir = await tempDir();
    const file = join(dir, "sessions.json");
    const store = new RuntimeLedgerStore(file);
    await writeFile(file, "{ not json");
    expect(await store.read()).toEqual([]);
    await writeFile(file, JSON.stringify({ version: 2, sessions: [{ sessionFile: "/s/a.jsonl", cwd: "/x" }] }));
    expect(await store.read()).toEqual([]);
    await writeFile(file, JSON.stringify({ version: 1, sessions: "nope" }));
    expect(await store.read()).toEqual([]);
  });

  test("malformed records are skipped, and unusable sizes degrade instead of dropping the session", async () => {
    const dir = await tempDir();
    const file = join(dir, "sessions.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          "not a record",
          { sessionFile: 7, cwd: "/x" },
          { sessionFile: "/s/gone.jsonl" },
          { sessionFile: "/s/a.jsonl", cwd: "/one", cols: "wide", rows: Number.NaN },
          { sessionFile: "/s/b.jsonl", cwd: "/two", cols: 90, rows: 30 },
        ],
      }),
    );
    const store = new RuntimeLedgerStore(file);
    expect(await store.read()).toEqual([
      { sessionFile: "/s/a.jsonl", cwd: "/one", cols: undefined, rows: undefined },
      { sessionFile: "/s/b.jsonl", cwd: "/two", cols: 90, rows: 30 },
    ]);
  });

  test("an oversized ledger is refused rather than loaded", async () => {
    const dir = await tempDir();
    const file = join(dir, "sessions.json");
    await writeFile(file, "x".repeat(LEDGER_LIMIT_BYTES + 1));
    const store = new RuntimeLedgerStore(file);
    expect(await store.read()).toEqual([]);
  });

  test("a snapshot write leaves a complete file and no temp files behind", async () => {
    const dir = await tempDir();
    const file = join(dir, "nested", "sessions.json");
    const store = new RuntimeLedgerStore(file);
    await store.save([{ sessionFile: "/s/a.jsonl", cwd: "/x" }]);
    expect(await store.read()).toEqual([{ sessionFile: "/s/a.jsonl", cwd: "/x" }]);
    const entries = await readdir(join(dir, "nested"));
    expect(entries).toEqual(["sessions.json"]);
  });
});

describe("workspace state store", () => {
  test("a stored document round-trips; a missing file is empty state", async () => {
    const dir = await tempDir();
    const store = new WorkspaceStateStore(join(dir, "state.json"));
    expect((await store.read()).state).toBeNull();
    const doc = { version: 2, savedAt: new Date().toISOString(), layout: { tree: { kind: "leaf", pane: "p1" } } };
    await store.write(doc);
    const snapshot = await store.read();
    expect(snapshot.state).toEqual(doc);
    expect(snapshot.corrupt).toBe(false);
    expect(snapshot.savedAt).not.toBeNull();
  });

  test("a corrupt workspace document is reported, not thrown", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "}}}");
    const snapshot = await new WorkspaceStateStore(file).read();
    expect(snapshot.state).toBeNull();
    expect(snapshot.corrupt).toBe(true);
  });
});
