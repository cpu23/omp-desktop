import { describe, expect, test } from "bun:test";
import {
  attachable,
  bindingFromStored,
  runtimeForSession,
} from "./lifecycle";
import type { RuntimeInfo } from "./protocol";

function runtime(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    id: "rt-1",
    alive: true,
    pid: 100,
    cols: 80,
    rows: 24,
    startedAt: "2026-10-05T00:00:00.000Z",
    bytesOut: 0,
    cwd: "/home/dev",
    sessionFile: null,
    title: "dev",
    status: "idle",
    lastActivity: null,
    ...overrides,
  };
}

describe("durable pane identity", () => {
  test("stored transcript identity and drafts survive loss of the ephemeral runtime id", () => {
    const restored = bindingFromStored({
      runtimeId: null,
      title: "session",
      sessionFile: "/s/a.jsonl",
      drafts: { "/s/a.jsonl": "unfinished prompt" },
      autoResume: false,
      daemonGeneration: "old-generation",
    });
    expect(restored).toEqual({
      runtimeId: null,
      title: "session",
      sessionFile: "/s/a.jsonl",
      drafts: { "/s/a.jsonl": "unfinished prompt" },
    });
  });

  test("legacy stored bindings retain transcript identity without restoring a process", () => {
    const restored = bindingFromStored({ runtimeId: "old-runtime", sessionFile: "/s/a.jsonl", autoResume: true });
    expect(restored).toEqual({ runtimeId: "old-runtime", title: null, sessionFile: "/s/a.jsonl" });
  });

  test("malformed bindings degrade to an empty identity and malformed drafts are discarded", () => {
    expect(bindingFromStored("nope")).toBeNull();
    expect(bindingFromStored({
      runtimeId: 7, sessionFile: 9, drafts: { "/s/a.jsonl": 2 },
      draftFiles: { "/s/a.jsonl": [{ path: "/private.png", text: "" }, { path: "", text: "reference" }] },
    })).toEqual({
      runtimeId: null,
      title: null,
      sessionFile: null,
    });
  });
});

describe("runtime adoption by transcript", () => {
  test("the matching attachable runtime is reused by exact transcript identity", () => {
    const other = runtime({ id: "rt-other", sessionFile: "/s/b.jsonl" });
    const matching = runtime({ id: "rt-match", sessionFile: "/s/a.jsonl" });
    expect(runtimeForSession("/s/a.jsonl", [other, matching])).toBe(matching);
  });

  test("a reserved runtime is attachable but an exited runtime is not", () => {
    const reserved = runtime({ alive: false, pid: null, sessionFile: "/s/a.jsonl", status: "idle" });
    const exited = runtime({ alive: false, pid: null, sessionFile: "/s/a.jsonl", status: "exited" });
    expect(attachable(reserved)).toBe(true);
    expect(runtimeForSession("/s/a.jsonl", [exited])).toBeNull();
    expect(runtimeForSession(null, [reserved])).toBeNull();
  });

  test("a reserved runtime without a process id remains attachable", () => {
    expect(attachable(runtime({ alive: false, pid: null, status: "idle" }))).toBe(true);
    expect(attachable(runtime({ alive: false, pid: null, status: "exited" }))).toBe(false);
    expect(attachable(runtime({ alive: true, status: "streaming" }))).toBe(true);
  });
});
