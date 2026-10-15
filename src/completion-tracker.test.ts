import { describe, expect, test } from "bun:test";
import { CompletionTracker } from "./completion-tracker";
import type { RuntimeInfo, RuntimePresentation } from "./protocol";

function runtime(id: string, presentation?: RuntimePresentation | null): RuntimeInfo {
  return {
    id,
    alive: true,
    pid: 100,
    cols: 80,
    rows: 24,
    startedAt: null,
    bytesOut: 0,
    cwd: "/tmp",
    sessionFile: null,
    title: id,
    status: "idle",
    lastActivity: null,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function withCompletion(id: string, identity: string | null): RuntimeInfo {
  return runtime(id, {
    accent: null,
    agentActive: false,
    completion: identity === null ? null : { identity, completedAt: 1 },
  });
}

describe("completion notification tracking", () => {
  test("baselines existing completion and emits each later identity once", () => {
    const tracker = new CompletionTracker();
    const emitted: string[] = [];
    const notify = (entry: RuntimeInfo, identity: string) => emitted.push(`${entry.id}:${identity}`);

    tracker.observe([withCompletion("rt-a", "old-turn")], notify);
    tracker.observe([withCompletion("rt-a", "old-turn")], notify);
    expect(emitted).toEqual([]);

    tracker.observe([withCompletion("rt-a", "turn-2")], notify);
    tracker.observe([withCompletion("rt-a", "turn-2")], notify);
    tracker.observe([withCompletion("rt-a", "old-turn")], notify);
    tracker.observe([withCompletion("rt-a", "turn-3")], notify);
    expect(emitted).toEqual(["rt-a:turn-2", "rt-a:turn-3"]);
  });

  test("unavailable presentation does not clear the baseline or replay an identity", () => {
    const tracker = new CompletionTracker();
    const emitted: string[] = [];
    const notify = (entry: RuntimeInfo, identity: string) => emitted.push(`${entry.id}:${identity}`);

    tracker.observe([withCompletion("rt-a", "old-turn")], notify);
    tracker.observe([runtime("rt-a")], notify);
    tracker.observe([withCompletion("rt-a", "old-turn")], notify);
    tracker.observe([withCompletion("rt-a", "new-turn")], notify);

    expect(emitted).toEqual(["rt-a:new-turn"]);
  });

  test("a valid no-completion baseline allows the first later completion", () => {
    const tracker = new CompletionTracker();
    const emitted: string[] = [];
    tracker.observe([withCompletion("rt-a", null)], (_entry, identity) => emitted.push(identity));
    tracker.observe([withCompletion("rt-a", "first-turn")], (_entry, identity) => emitted.push(identity));
    expect(emitted).toEqual(["first-turn"]);
  });

  test("identities are scoped to runtime, even when strings match", () => {
    const tracker = new CompletionTracker();
    const emitted: string[] = [];
    const notify = (entry: RuntimeInfo, identity: string) => emitted.push(`${entry.id}:${identity}`);
    tracker.observe([withCompletion("rt-a", null), withCompletion("rt-b", null)], notify);
    tracker.observe([withCompletion("rt-a", "turn-1"), withCompletion("rt-b", "turn-1")], notify);
    expect(emitted).toEqual(["rt-a:turn-1", "rt-b:turn-1"]);
  });
});
