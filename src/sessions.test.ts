/**
 * Regression tests for the session index's "last used" semantics: activity must
 * come from conversation messages, never from the file mtime that resuming or
 * its bookkeeping writes (`session_exit`) touch.
 *
 * Run: bun test src/sessions.test.ts
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, readSessionCwd } from "./sessions";

type Event = Record<string, unknown>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-desktop-sessions-"));
  roots.push(root);
  return root;
}

function writeSession(root: string, name: string, events: Event[]): string {
  const dir = join(root, "-home-user-demo");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return path;
}

function setMtime(path: string, iso: string): void {
  const when = new Date(iso);
  utimesSync(path, when, when);
}

function session(id: string, timestamp: string): Event {
  return { type: "session", id, cwd: "/home/user/demo", timestamp, version: 2 };
}

function user(timestamp: string, text: string): Event {
  return { type: "message", id: `u-${timestamp}`, parentId: null, timestamp, message: { role: "user", content: text } };
}

function assistant(timestamp: string, cost?: number): Event {
  const message: Record<string, unknown> = { role: "assistant", content: [{ type: "text", text: "reply" }] };
  if (cost !== undefined) message.usage = { cost: { total: cost } };
  return { type: "message", id: `a-${timestamp}`, parentId: null, timestamp, message };
}

/** What omp appends when a session process exits: mtime-only activity. */
function exitEvent(timestamp: string): Event {
  return { type: "custom", customType: "session_exit", id: `x-${timestamp}`, parentId: null, timestamp, data: {} };
}

describe("message-derived activity", () => {
  test("opening an old session (mtime touch + session_exit) keeps its last-used message time and order", async () => {
    const root = makeRoot();
    const old = writeSession(root, "2026-07-01T10-00-00-000Z_old-1.jsonl", [
      session("old-1", "2026-07-01T10:00:00.000Z"),
      user("2026-07-01T10:00:01.000Z", "first question"),
      assistant("2026-07-01T10:05:00.000Z"),
      exitEvent("2026-09-30T12:00:00.000Z"),
    ]);
    setMtime(old, "2026-09-30T12:00:00.000Z");
    const fresh = writeSession(root, "2026-09-20T09-00-00-000Z_fresh-1.jsonl", [
      session("fresh-1", "2026-09-20T09:00:00.000Z"),
      user("2026-09-20T09:00:01.000Z", "recent question"),
      assistant("2026-09-20T09:03:00.000Z"),
    ]);
    setMtime(fresh, "2026-09-20T09:03:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["fresh-1", "old-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-20T09:03:00.000Z");
    expect(sessions[1].updatedAt).toBe("2026-07-01T10:05:00.000Z");
  });

  test("a later mtime touch alone does not refresh last-used", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-08-01T00-00-00-000Z_old-2.jsonl", [
      session("old-2", "2026-08-01T00:00:00.000Z"),
      user("2026-08-01T00:00:01.000Z", "hello"),
      assistant("2026-08-01T00:02:00.000Z"),
    ]);
    setMtime(path, "2026-08-01T00:02:00.000Z");
    await listSessions({ sessionsRoot: root }); // Warm the activity cache.
    setMtime(path, "2026-09-30T12:00:00.000Z"); // Opened again, no new messages.

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["old-2"]);
    expect(sessions[0].updatedAt).toBe("2026-08-01T00:02:00.000Z");
  });

  test("a new message moves the session up and updates last-used", async () => {
    const root = makeRoot();
    const old = writeSession(root, "2026-08-01T00-00-00-000Z_old-3.jsonl", [
      session("old-3", "2026-08-01T00:00:00.000Z"),
      user("2026-08-01T00:00:01.000Z", "hello"),
      assistant("2026-08-01T00:02:00.000Z"),
    ]);
    setMtime(old, "2026-08-01T00:02:00.000Z");
    const fresh = writeSession(root, "2026-09-20T09-00-00-000Z_fresh-3.jsonl", [
      session("fresh-3", "2026-09-20T09:00:00.000Z"),
      user("2026-09-20T09:00:01.000Z", "recent question"),
      assistant("2026-09-20T09:03:00.000Z"),
    ]);
    setMtime(fresh, "2026-09-20T09:03:00.000Z");
    expect((await listSessions({ sessionsRoot: root })).map((entry) => entry.id)).toEqual(["fresh-3", "old-3"]);

    appendFileSync(old, `${JSON.stringify(user("2026-09-25T08:00:00.000Z", "follow-up"))}\n`);
    setMtime(old, "2026-09-25T08:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["old-3", "fresh-3"]);
    expect(sessions[0].updatedAt).toBe("2026-09-25T08:00:00.000Z");
  });
  test("same-size rewrites with a preserved mtime refresh conversation order", async () => {
    const root = makeRoot();
    const old = writeSession(root, "2026-08-01T00-00-00-000Z_rewritten.jsonl", [
      session("rewritten", "2026-08-01T00:00:00.000Z"),
      user("2026-08-01T00:00:01.000Z", "same prompt"),
      assistant("2026-08-01T00:02:00.000Z"),
    ]);
    const fresh = writeSession(root, "2026-09-20T09-00-00-000Z_fresh-rewrite.jsonl", [
      session("fresh-rewrite", "2026-09-20T09:00:00.000Z"),
      user("2026-09-20T09:00:01.000Z", "recent question"),
      assistant("2026-09-20T09:03:00.000Z"),
    ]);
    const oldMtime = "2026-08-01T00:02:00.000Z";
    setMtime(old, oldMtime);
    setMtime(fresh, "2026-09-20T09:03:00.000Z");
    expect((await listSessions({ sessionsRoot: root })).map((entry) => entry.id)).toEqual([
      "fresh-rewrite",
      "rewritten",
    ]);

    const replacement = writeSession(root, "staged-rewrite.jsonl", [
      session("rewritten", "2026-08-01T00:00:00.000Z"),
      user("2026-08-01T00:00:01.000Z", "same prompt"),
      assistant("2026-09-25T08:00:00.000Z"),
    ]);
    renameSync(replacement, old);
    setMtime(old, oldMtime);

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["rewritten", "fresh-rewrite"]);
    expect(sessions[0]?.updatedAt).toBe("2026-09-25T08:00:00.000Z");
  });

  test("a session with no conversation falls back to creation time, not its exit event", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-01T00-00-00-000Z_empty-1.jsonl", [
      session("empty-1", "2026-09-01T00:00:00.000Z"),
      exitEvent("2026-09-29T23:00:00.000Z"),
      exitEvent("2026-09-30T12:00:00.000Z"),
    ]);
    setMtime(path, "2026-09-30T12:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["empty-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("truncated and malformed lines do not hide the last good message", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-10T00-00-00-000Z_broken-1.jsonl", [
      session("broken-1", "2026-09-10T00:00:00.000Z"),
      user("2026-09-10T00:00:01.000Z", "question"),
    ]);
    appendFileSync(path, "this is not json\n");
    appendFileSync(path, '{"type":"message","timestamp":"2026-09-29T00:00:00.000Z","message":{"role":"assistant"');
    setMtime(path, "2026-09-30T12:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["broken-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-10T00:00:01.000Z");
  });

  test("the limit applies after activity order, not mtime order", async () => {
    const root = makeRoot();
    const touched = writeSession(root, "2026-08-01T00-00-00-000Z_touched.jsonl", [
      session("touched", "2026-08-01T00:00:00.000Z"),
      user("2026-08-01T00:00:01.000Z", "old question"),
      assistant("2026-08-01T00:01:00.000Z"),
    ]);
    setMtime(touched, "2026-09-30T00:00:00.000Z"); // Newest file, oldest chat.
    const middle = writeSession(root, "2026-09-10T00-00-00-000Z_middle.jsonl", [
      session("middle", "2026-09-10T00:00:00.000Z"),
      user("2026-09-10T00:00:01.000Z", "middle question"),
      assistant("2026-09-10T00:01:00.000Z"),
    ]);
    setMtime(middle, "2026-09-20T00:00:00.000Z");
    const later = writeSession(root, "2026-09-25T00-00-00-000Z_later.jsonl", [
      session("later", "2026-09-25T00:00:00.000Z"),
      user("2026-09-25T00:00:01.000Z", "newest question"),
      assistant("2026-09-25T00:02:00.000Z"),
    ]);
    setMtime(later, "2026-09-25T00:02:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root, limit: 1 });
    expect(sessions.map((entry) => entry.id)).toEqual(["later"]);
    expect(sessions[0].updatedAt).toBe("2026-09-25T00:02:00.000Z");
  });

  test("a message newer than the file mtime still wins (clock skew or import)", async () => {
    const root = makeRoot();
    const skewed = writeSession(root, "2026-08-01T00-00-00-000Z_skewed-1.jsonl", [
      session("skewed-1", "2026-09-25T00:00:00.000Z"),
      user("2026-09-29T00:00:01.000Z", "skewed question"),
      assistant("2026-09-29T00:02:00.000Z"),
    ]);
    setMtime(skewed, "2026-08-01T00:00:00.000Z"); // Older than the messages it holds.
    const plain = writeSession(root, "2026-09-20T09-00-00-000Z_plain-1.jsonl", [
      session("plain-1", "2026-09-20T09:00:00.000Z"),
      user("2026-09-20T09:00:01.000Z", "plain question"),
      assistant("2026-09-20T09:03:00.000Z"),
    ]);
    setMtime(plain, "2026-09-20T09:03:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["skewed-1", "plain-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-29T00:02:00.000Z");
  });

  test("a message is still found behind megabytes of trailing metadata", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-10T00-00-00-000Z_buried-1.jsonl", [
      session("buried-1", "2026-09-10T00:00:00.000Z"),
      user("2026-09-10T00:00:01.000Z", "question"),
      assistant("2026-09-10T00:02:00.000Z"),
    ]);
    const padding = "x".repeat(3 * 1024 * 1024);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "custom", customType: "session_exit", id: "big", parentId: null, timestamp: "2026-09-30T00:00:00.000Z", data: { padding } })}\n`,
    );
    setMtime(path, "2026-09-30T00:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["buried-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-10T00:02:00.000Z");
  });

  test("a message line longer than the read chunk is assembled from fragments", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-11T00-00-00-000Z_wide-1.jsonl", [
      session("wide-1", "2026-09-11T00:00:00.000Z"),
    ]);
    // Structure spread over many 64 KiB fragments: wrong order or a dropped
    // fragment makes the assembled JSON unparseable and hides the timestamp.
    const content = Array.from({ length: 20_000 }, (_, index) => ({
      type: "text",
      text: `item-${index}-${"é".repeat(8)}`,
    }));
    appendFileSync(
      path,
      `${JSON.stringify({ type: "message", id: "wide", parentId: null, message: { role: "user", content }, timestamp: "2026-09-11T00:02:00.000Z" })}\n`,
    );
    setMtime(path, "2026-09-11T00:02:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["wide-1"]);
    expect(sessions[0].updatedAt).toBe("2026-09-11T00:02:00.000Z");
  });

  test.skipIf(process.getuid?.() === 0)("a transient read failure is not memoized as no conversation", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-08-05T00-00-00-000Z_denied-1.jsonl", [
      session("denied-1", "2026-08-05T00:00:00.000Z"),
      user("2026-08-05T00:01:00.000Z", "later message"),
    ]);
    setMtime(path, "2026-08-05T00:01:00.000Z");
    chmodSync(path, 0o000);
    try {
      await listSessions({ sessionsRoot: root }); // Read fails; must not be cached as "no message".
    } finally {
      chmodSync(path, 0o644);
    }

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["denied-1"]);
    expect(sessions[0].updatedAt).toBe("2026-08-05T00:01:00.000Z");
  });

  test("a legacy transcript without a session header uses the filename time, not mtime", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-06-01T12-30-00-000Z_legacy-1.jsonl", [exitEvent("2026-09-30T12:00:00.000Z")]);
    setMtime(path, "2026-09-30T12:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.map((entry) => entry.id)).toEqual(["legacy-1"]);
    expect(sessions[0].updatedAt).toBe("2026-06-01T12:30:00.000Z");
  });

  test("search sees an old-mtime match that mtime pruning would have hidden", async () => {
    const root = makeRoot();
    // 120 freshly-touched files whose conversations are stale...
    for (let index = 0; index < 120; index++) {
      const path = writeSession(root, `2026-09-30T00-00-00-000Z_filler-${String(index).padStart(3, "0")}.jsonl`, [
        session(`filler-${index}`, "2026-07-01T00:00:00.000Z"),
        user("2026-07-01T00:00:01.000Z", `stale question ${index}`),
        assistant("2026-07-01T00:01:00.000Z"),
      ]);
      setMtime(path, "2026-09-30T00:00:00.000Z");
    }
    // ...and the only match has the oldest mtime of the whole store.
    const match = writeSession(root, "2026-06-01T00-00-00-000Z_zebra-old.jsonl", [
      session("zebra-old", "2026-06-01T00:00:00.000Z"),
      { type: "title_change", id: "t1", parentId: null, timestamp: "2026-06-01T00:00:02.000Z", title: "Zebra archive" },
      user("2026-06-01T00:00:01.000Z", "question"),
      assistant("2026-06-01T00:00:03.000Z"),
    ]);
    setMtime(match, "2026-06-01T00:00:00.000Z");

    const sessions = await listSessions({ sessionsRoot: root, limit: 5, search: "zebra" });
    expect(sessions.map((entry) => entry.id)).toEqual(["zebra-old"]);
  });

  test("cost accounting still sums usage across the transcript", async () => {
    const root = makeRoot();
    writeSession(root, "2026-09-12T00-00-00-000Z_cost-1.jsonl", [
      session("cost-1", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.25),
      user("2026-09-12T00:01:00.000Z", "more"),
      assistant("2026-09-12T00:01:05.000Z", 0.75),
    ]);

    const sessions = await listSessions({ sessionsRoot: root });
    expect(sessions.length).toBe(1);
    expect(sessions[0].costUsd).toBe(1);
  });

  test("appended usage carries incomplete cost JSON without double-counting", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-12T00-00-00-000Z_cost-append.jsonl", [
      session("cost-append", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.25),
    ]);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.25);

    appendFileSync(
      path,
      '{"type":"message","timestamp":"2026-09-12T00:01:00.000Z","message":{"role":"assistant","usage":{"cost":{"total":0.',
    );
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.25);
    appendFileSync(path, "75}}}}\n");
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(1);

    appendFileSync(path, `${JSON.stringify(assistant("2026-09-12T00:02:00.000Z", 0.5))}\n`);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(1.5);
  });

  test("same-size in-place cost rewrites with restored mtime trigger a full rescan", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-12T00-00-00-000Z_cost-in-place.jsonl", [
      session("cost-in-place", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.25),
    ]);
    const mtime = "2026-09-12T00:00:00.000Z";
    setMtime(path, mtime);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.25);

    writeFileSync(
      path,
      `${[
        session("cost-in-place", "2026-09-12T00:00:00.000Z"),
        user("2026-09-12T00:00:01.000Z", "hi"),
        assistant("2026-09-12T00:00:05.000Z", 0.75),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    setMtime(path, mtime);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.75);
  });

  test("truncating a transcript discards the old accumulated cost", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-12T00-00-00-000Z_cost-truncate.jsonl", [
      session("cost-truncate", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.25),
      assistant("2026-09-12T00:01:05.000Z", 0.75),
    ]);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(1);

    writeFileSync(
      path,
      `${[
        session("cost-truncate", "2026-09-12T00:00:00.000Z"),
        user("2026-09-12T00:00:01.000Z", "hi"),
        assistant("2026-09-12T00:00:05.000Z", 0.5),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.5);
  });

  test("refreshes cached cost after a same-size replacement with preserved mtime", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-12T00-00-00-000Z_cost-rewrite.jsonl", [
      session("cost-rewrite", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.25),
    ]);
    const mtime = "2026-09-12T00:00:00.000Z";
    setMtime(path, mtime);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.25);

    const replacement = writeSession(root, "staged-cost-rewrite.jsonl", [
      session("cost-rewrite", "2026-09-12T00:00:00.000Z"),
      user("2026-09-12T00:00:01.000Z", "hi"),
      assistant("2026-09-12T00:00:05.000Z", 0.75),
    ]);
    renameSync(replacement, path);
    setMtime(path, mtime);
    expect((await listSessions({ sessionsRoot: root }))[0]?.costUsd).toBe(0.75);
  });

  test("search still filters the activity-ordered rows", async () => {
    const root = makeRoot();
    writeSession(root, "2026-09-01T00-00-00-000Z_search-old.jsonl", [
      session("search-old", "2026-09-01T00:00:00.000Z"),
      { type: "title_change", id: "t1", parentId: null, timestamp: "2026-09-01T00:00:02.000Z", title: "Zebra research" },
      user("2026-09-01T00:00:01.000Z", "question"),
      assistant("2026-09-01T00:00:03.000Z"),
    ]);
    writeSession(root, "2026-09-05T00-00-00-000Z_search-new.jsonl", [
      session("search-new", "2026-09-05T00:00:00.000Z"),
      user("2026-09-05T00:00:01.000Z", "another question"),
      assistant("2026-09-05T00:00:03.000Z"),
    ]);

    const sessions = await listSessions({ sessionsRoot: root, search: "zebra" });
    expect(sessions.map((entry) => entry.id)).toEqual(["search-old"]);
  });
});

describe("parsed header cache", () => {
  test("reuses warm headers and invalidates on mtime, replacement, or size changes", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-01T00-00-00-000Z_cached.jsonl", [
      session("cached", "2026-09-01T00:00:00.000Z"),
      { type: "title_change", id: "t1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", title: "Old title" },
      user("2026-09-01T00:00:02.000Z", "prompt"),
      assistant("2026-09-01T00:00:03.000Z"),
    ]);
    const unchangedMtime = "2026-09-01T00:00:00.000Z";
    setMtime(path, unchangedMtime);

    const fileSpy = spyOn(Bun, "file");
    try {
      expect((await listSessions({ sessionsRoot: root }))[0]?.title).toBe("Old title");
      const warmReadCount = fileSpy.mock.calls.length;
      expect((await listSessions({ sessionsRoot: root }))[0]?.title).toBe("Old title");
      expect(fileSpy.mock.calls.length).toBe(warmReadCount);

      writeSession(root, "2026-09-01T00-00-00-000Z_cached.jsonl", [
        session("cached", "2026-09-01T00:00:00.000Z"),
        { type: "title_change", id: "t1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", title: "New title" },
        user("2026-09-01T00:00:02.000Z", "prompt"),
        assistant("2026-09-01T00:00:03.000Z"),
      ]);
      setMtime(path, "2026-09-02T00:00:00.000Z");
      expect((await listSessions({ sessionsRoot: root }))[0]?.title).toBe("New title");

      const replacement = writeSession(root, "staged-cached.jsonl", [
        session("cached", "2026-09-01T00:00:00.000Z"),
        { type: "title_change", id: "t1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", title: "Old title" },
        user("2026-09-01T00:00:02.000Z", "prompt"),
        assistant("2026-09-01T00:00:03.000Z"),
      ]);
      renameSync(replacement, path);
      setMtime(path, "2026-09-02T00:00:00.000Z");
      expect((await listSessions({ sessionsRoot: root }))[0]?.title).toBe("Old title");

      writeSession(root, "2026-09-01T00-00-00-000Z_cached.jsonl", [
        session("cached", "2026-09-01T00:00:00.000Z"),
        { type: "title_change", id: "t1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", title: "Longer title" },
        user("2026-09-01T00:00:02.000Z", "prompt"),
        assistant("2026-09-01T00:00:03.000Z"),
      ]);
      setMtime(path, "2026-09-02T00:00:00.000Z");
      expect((await listSessions({ sessionsRoot: root }))[0]?.title).toBe("Longer title");
    } finally {
      fileSpy.mockRestore();
    }
  });

  test("keeps a large cache warm while preserving search, order, imports, and deletions", async () => {
    const root = makeRoot();
    const dir = join(root, "-home-user-demo");
    mkdirSync(dir, { recursive: true });
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 1100; index++) {
      const id = `bulk-${String(index).padStart(4, "0")}`;
      const timestamp = new Date(startMs + index * 2_000).toISOString();
      const replyTime = new Date(startMs + index * 2_000 + 1_000).toISOString();
      const prompt = index === 0 ? "boundary-search-token" : `question ${index}`;
      writeFileSync(
        join(dir, `${id}.jsonl`),
        `${[session(id, timestamp), user(timestamp, prompt), assistant(replyTime)]
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
      );
    }

    const fileSpy = spyOn(Bun, "file");
    try {
      const recent = await listSessions({ sessionsRoot: root, limit: 60 });
      expect(recent).toHaveLength(60);
      expect(recent[0]?.id).toBe("bulk-1099");
      const warmReadCount = fileSpy.mock.calls.length;
      expect((await listSessions({ sessionsRoot: root, limit: 60 })).map((entry) => entry.id)).toEqual(
        recent.map((entry) => entry.id),
      );
      expect(fileSpy.mock.calls.length).toBe(warmReadCount);

      expect(
        (await listSessions({ sessionsRoot: root, search: "boundary-search-token", limit: 1 })).map(
          (entry) => entry.id,
        ),
      ).toEqual(["bulk-0000"]);
      expect(await listSessions({ sessionsRoot: root, limit: Number.MAX_SAFE_INTEGER })).toHaveLength(200);

      rmSync(join(dir, "bulk-0000.jsonl"));
      const imported = writeSession(root, "000-imported.jsonl", [
        session("imported", "2026-01-01T00:00:00.000Z"),
        user("2026-12-01T00:00:01.000Z", "imported marker"),
        assistant("2026-12-01T00:00:02.000Z"),
      ]);
      setMtime(imported, "2026-01-01T00:00:00.000Z");
      expect((await listSessions({ sessionsRoot: root, limit: 1 }))[0]?.id).toBe("imported");
      expect(await listSessions({ sessionsRoot: root, search: "boundary-search-token" })).toEqual([]);
    } finally {
      fileSpy.mockRestore();
    }
  });

  test("simultaneous listings share transcript indexing and cost work", async () => {
    const root = makeRoot();
    writeSession(root, "2026-09-01T00-00-00-000Z_concurrent.jsonl", [
      session("concurrent", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "prompt"),
      assistant("2026-09-01T00:00:02.000Z", 0.5),
    ]);
    const fileSpy = spyOn(Bun, "file");
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ sessionsRoot: root })),
      );
      expect(results.map((sessions) => sessions[0]?.costUsd)).toEqual(Array(8).fill(0.5));
      expect(fileSpy.mock.calls.length).toBe(3);
    } finally {
      fileSpy.mockRestore();
    }
  });

  test("separate session roots keep independently cached index results", async () => {
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    writeSession(firstRoot, "2026-09-01T00-00-00-000Z_shared.jsonl", [
      session("first-root", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "first"),
    ]);
    writeSession(secondRoot, "2026-09-01T00-00-00-000Z_shared.jsonl", [
      session("second-root", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "second"),
    ]);
    const [first, second] = await Promise.all([
      listSessions({ sessionsRoot: firstRoot }),
      listSessions({ sessionsRoot: secondRoot }),
    ]);
    expect(first.map((entry) => entry.id)).toEqual(["first-root"]);
    expect(second.map((entry) => entry.id)).toEqual(["second-root"]);
  });

  test("retries a transient header read failure", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-01T00-00-00-000Z_retry.jsonl", [
      session("retry", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "prompt"),
      assistant("2026-09-01T00:00:02.000Z"),
    ]);
    const realFile = Bun.file.bind(Bun);
    let failHeaderRead = true;
    const fileSpy = spyOn(Bun, "file").mockImplementation((filePath) => {
      if (String(filePath) === path && failHeaderRead) {
        failHeaderRead = false;
        throw new Error("transient read failure");
      }
      return Reflect.apply(realFile, Bun, [filePath]);
    });
    try {
      expect(await listSessions({ sessionsRoot: root })).toEqual([]);
      expect((await listSessions({ sessionsRoot: root })).map((entry) => entry.id)).toEqual(["retry"]);
    } finally {
      fileSpy.mockRestore();
    }
  });

  test("refreshes history.db titles independently of cached transcript headers", async () => {
    const root = makeRoot();
    const sessionsRoot = join(root, "sessions");
    writeSession(sessionsRoot, "2026-09-01T00-00-00-000Z_history.jsonl", [
      session("history", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "prompt"),
      assistant("2026-09-01T00:00:02.000Z"),
    ]);
    const historyPath = join(root, "history.db");
    const historyDb = new Database(historyPath);
    historyDb.query("PRAGMA journal_mode=WAL").get();
    historyDb.run("CREATE TABLE session_titles (session_id TEXT, title TEXT)");
    historyDb.run("INSERT INTO session_titles VALUES ('history', 'First external title')");
    try {
      expect((await listSessions({ sessionsRoot }))[0]?.title).toBe("First external title");
      historyDb.run("UPDATE session_titles SET title = 'Renamed external title' WHERE session_id = 'history'");
      // The writer remains open, so the rename is in the WAL and the main DB
      // file itself need not change.
      expect((await listSessions({ sessionsRoot }))[0]?.title).toBe("Renamed external title");
    } finally {
      historyDb.close();
    }
  });

  test("recovers external titles after a transient database lock without a file mutation", async () => {
    const root = makeRoot();
    const sessionsRoot = join(root, "sessions");
    writeSession(sessionsRoot, "2026-09-01T00-00-00-000Z_locked-history.jsonl", [
      session("locked-history", "2026-09-01T00:00:00.000Z"),
      user("2026-09-01T00:00:01.000Z", "prompt"),
    ]);
    const historyDb = new Database(join(root, "history.db"));
    historyDb.run("CREATE TABLE session_titles (session_id TEXT, title TEXT)");
    historyDb.run("INSERT INTO session_titles VALUES ('locked-history', 'Recovered external title')");
    let locked = false;
    try {
      historyDb.run("BEGIN EXCLUSIVE");
      locked = true;
      expect((await listSessions({ sessionsRoot }))[0]?.title).not.toBe("Recovered external title");
      historyDb.run("ROLLBACK");
      locked = false;
      expect((await listSessions({ sessionsRoot }))[0]?.title).toBe("Recovered external title");
    } finally {
      if (locked) historyDb.run("ROLLBACK");
      historyDb.close();
    }
  });
});

describe("readSessionCwd", () => {
  test("returns the recorded directory and null for an unreadable file", async () => {
    const root = makeRoot();
    const path = writeSession(root, "2026-09-01T00-00-00-000Z_cwd-1.jsonl", [
      session("cwd-1", "2026-09-01T00:00:00.000Z"),
    ]);
    expect(await readSessionCwd(path)).toBe("/home/user/demo");
    expect(await readSessionCwd(join(root, "missing.jsonl"))).toBeNull();
  });
});
