/**
 * Boundary tests for the runtime list wire format. The presentation block is
 * optional enhancement data from a per-runtime extension socket: a malformed
 * one must degrade to "unavailable" without taking the runtime (or the whole
 * response) down, and payloads predating the field must keep parsing.
 */
import { describe, expect, test } from "bun:test";
import {
  isTerminalReply,
  MAX_RUNTIME_INPUT_CODE_UNITS,
  parseClientMessage,
  parseRuntimeInfo,
  parseRuntimeOne,
  parseRuntimesResponse,
  parseServerMessage,
  parseStateResponse,
} from "./protocol";

function runtime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe("runtime presentation parsing", () => {
  test("a runtime without presentation still parses (info() and older payloads)", () => {
    const list = parseRuntimesResponse({ generation: "g", runtimes: [runtime()] });
    expect(list).not.toBeNull();
    expect(list?.runtimes[0].presentation).toBeUndefined();
  });

  test("a valid presentation is kept, with completion identity and timestamp only", () => {
    const list = parseRuntimesResponse({
      generation: "g",
      runtimes: [
        runtime({
          presentation: {
            accent: "#7aa2f7",
            agentActive: true,
            completion: { identity: "gen:3", generation: "gen", turn: 3, completedAt: 1730000000000 },
          },
        }),
      ],
    });
    expect(list?.runtimes[0].presentation).toEqual({
      accent: "#7aa2f7",
      agentActive: true,
      completion: { identity: "gen:3", completedAt: 1730000000000 },
    });
  });

  test("a quiet runtime keeps a valid presentation with no completion marker", () => {
    const list = parseRuntimesResponse({
      generation: "g",
      runtimes: [runtime({ presentation: { accent: null, agentActive: false } })],
    });
    expect(list?.runtimes[0].presentation).toEqual({ accent: null, agentActive: false, completion: null });
  });

  test("a malformed presentation is dropped without blanking the list", () => {
    const list = parseRuntimesResponse({
      generation: "g",
      runtimes: [
        runtime({ id: "rt-bad", presentation: { accent: "#ffffff", agentActive: "yes" } }),
        runtime({ id: "rt-ok", presentation: { accent: "#abcdef", agentActive: false } }),
      ],
    });
    expect(list?.runtimes.map((entry) => entry.id)).toEqual(["rt-bad", "rt-ok"]);
    expect(list?.runtimes[0].presentation).toBeUndefined();
    expect(list?.runtimes[1].presentation).toEqual({ accent: "#abcdef", agentActive: false, completion: null });
  });

  test("a malformed completion never becomes a fake done marker", () => {
    const cases = [
      { identity: "", completedAt: 1 },
      { identity: "gen:1", completedAt: "now" },
      { identity: "gen:1" },
    ];
    for (const completion of cases) {
      const parsed = parseRuntimeInfo(runtime({ presentation: { accent: "#ffffff", agentActive: false, completion } }));
      expect(parsed?.presentation).toEqual({ accent: "#ffffff", agentActive: false, completion: null });
    }
  });

  test("accents the UI could not render degrade to null", () => {
    for (const accent of ["tomato", "#abc", "#12345678", 12]) {
      const parsed = parseRuntimeInfo(runtime({ presentation: { accent, agentActive: false } }));
      expect(parsed?.presentation).toEqual({ accent: null, agentActive: false, completion: null });
    }
  });

  test("pending user interactions survive parsing without losing completion state", () => {
    for (const kind of ["approval", "ask", "plan", "dialog"] as const) {
      const pendingAction = { id: "interaction-1", kind, title: "Review required" };
      const completion = { identity: "gen:1", completedAt: 1000 };
      const parsed = parseRuntimeInfo(runtime({
        presentation: { agentActive: true, pendingAction, completion },
      }));
      expect(parsed?.presentation?.pendingAction).toEqual(pendingAction);
      expect(parsed?.presentation?.completion).toEqual(completion);
    }
  });

  test("invalid pending actions cannot create attention state or discard valid activity", () => {
    for (const pendingAction of [null, {}, { id: "", kind: "ask", title: "Question" },
      { id: "a", kind: "unknown", title: "Question" }, { id: "a", kind: "approval" }]) {
      const parsed = parseRuntimeInfo(runtime({ presentation: { agentActive: true, pendingAction } }));
      expect(parsed?.presentation?.pendingAction).toBeUndefined();
      expect(parsed?.presentation?.agentActive).toBe(true);
    }
  });

  test("core runtime fields stay strict; presentation leniency does not loosen them", () => {
    expect(parseRuntimesResponse({ runtimes: [runtime({ status: "busy" })] })).toBeNull();
    expect(parseRuntimeInfo(runtime({ cols: "80" }))).toBeNull();
  });

  test("runtime parsing rejects missing or malformed core lifecycle fields", () => {
    for (const invalid of [
      { alive: undefined }, { alive: "yes" },
      { pid: undefined }, { pid: "100" },
      { sessionFile: undefined }, { sessionFile: {} },
    ]) {
      const payload = runtime(invalid);
      expect(parseRuntimeInfo(payload)).toBeNull();
      expect(parseRuntimesResponse({ runtimes: [payload] })).toBeNull();
      expect(parseServerMessage(JSON.stringify({ type: "ready", runtime: payload }))).toBeNull();
    }
    expect(parseRuntimeInfo(runtime({ alive: false, pid: null, sessionFile: null, status: "starting" }))).not.toBeNull();
  });

  test("one-shot runtime parsing drops junk presentation too", () => {
    const one = parseRuntimeOne({ runtime: runtime({ presentation: { agentActive: 1 } }) });
    expect(one?.presentation).toBeUndefined();

    const hello = parseServerMessage(
      JSON.stringify({ type: "hello", runtime: runtime({ presentation: { agentActive: 1 } }), replayBytes: 4 }),
    );
    expect(hello?.type).toBe("hello");
    if (hello?.type === "hello") {
      expect(hello.runtime.presentation).toBeUndefined();
      expect(hello.replayBytes).toBe(4);
    }
  });

  test("starting is a valid runtime state and ready control messages parse", () => {
    const starting = runtime({ status: "starting" });
    expect(parseRuntimeInfo(starting)?.status).toBe("starting");
    const ready = parseServerMessage(JSON.stringify({ type: "ready", runtime: runtime({ status: "idle" }) }));
    expect(ready?.type).toBe("ready");
    if (ready?.type === "ready") expect(ready.runtime.status).toBe("idle");
  });
});

describe("runtime input bounds", () => {
  test("accepts chunks up to the UTF-16 code-unit limit and rejects larger messages", () => {
    const accepted = "x".repeat(MAX_RUNTIME_INPUT_CODE_UNITS);
    const rejected = `${accepted}x`;
    expect(parseClientMessage(JSON.stringify({ type: "input", data: accepted }))).toEqual({
      type: "input",
      data: accepted,
    });
    expect(parseClientMessage(JSON.stringify({ type: "input", data: rejected }))).toBeNull();

    const paired = "😀".repeat(MAX_RUNTIME_INPUT_CODE_UNITS / 2);
    expect(parseClientMessage(JSON.stringify({ type: "input", data: paired }))?.type).toBe("input");
    expect(parseClientMessage(JSON.stringify({ type: "input", data: `${paired}😀` }))).toBeNull();
  });

  test("terminalReply accepts only bounded concatenated terminal query responses", () => {
    const responses = [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b[?12;34R",
      "\x1b[?2026;1$y",
      "\x1b[?1;2u",
      "\x1b[4;1080;1920t",
      "\x1b]10;rgb:ffff/eeee/dddd\x1b\\",
      "\x1b]11;rgb:123/456/789\x07",
    ];
    for (const response of responses) {
      expect(isTerminalReply(response)).toBe(true);
      expect(parseClientMessage(JSON.stringify({ type: "terminalReply", data: response }))).toEqual({
        type: "terminalReply",
        data: response,
      });
    }
    expect(isTerminalReply(responses.join(""))).toBe(true);
    for (const rejected of [
      "",
      "hello",
      "\x1b[2J",
      "\x1b[c",
      "\x1b[5n",
      "\x1b[?2026;9$y",
      "\x1b[0nhello",
      "\x1b]10;rgb:ffff/eeee/dddd\x07text",
      "\x1b]10;rgb:ffff/eeee/dddd\x07\x1b]12;rgb:ffff/eeee/dddd\x07",
      "\x1b[4;1080;1920z",
      "x".repeat(MAX_RUNTIME_INPUT_CODE_UNITS + 1),
    ]) {
      expect(isTerminalReply(rejected)).toBe(false);
      expect(parseClientMessage(JSON.stringify({ type: "terminalReply", data: rejected }))).toBeNull();
    }
  });
});
describe("workspace state version parsing", () => {
  test("accepts the single-layout and spaces workspace document versions", () => {
    expect(parseStateResponse({ state: { version: 1 } })?.kind).toBe("state");
    expect(parseStateResponse({ state: { version: 2 } })?.kind).toBe("state");
  });

  test("leaves newer workspace documents unsupported", () => {
    expect(parseStateResponse({ state: { version: 3 } })).toEqual({ kind: "unsupported", version: 3 });
  });
});
