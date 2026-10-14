/**
 * Boundary tests for the runtime list wire format. The presentation block is
 * optional enhancement data from a per-runtime extension socket: a malformed
 * one must degrade to "unavailable" without taking the runtime (or the whole
 * response) down, and payloads predating the field must keep parsing.
 */
import { describe, expect, test } from "bun:test";
import {
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

  test("core runtime fields stay strict; presentation leniency does not loosen them", () => {
    expect(parseRuntimesResponse({ runtimes: [runtime({ status: "busy" })] })).toBeNull();
    expect(parseRuntimeInfo(runtime({ cols: "80" }))).toBeNull();
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
