/**
 * Regression tests for the pane-binding lifecycle rules.
 *
 * These cover the deliberate reopen semantics the client relies on: a pane's
 * resume claim survives a daemon restart (so formerly live, transcript-backed
 * sessions come back) and dies with a deliberate stop (so a session the user
 * stopped, closed, or watched exit is not resurrected). See ../docs/desktop-
 * architecture.md for the state document the bindings are persisted in.
 */
import { describe, expect, test } from "bun:test";
import {
  attachable,
  bindingForRuntime,
  bindingFromStored,
  emptyBinding,
  intentAfterExit,
  intentAfterRuntimeLoss,
  pendingResumes,
  type PaneBinding,
} from "./lifecycle";
import type { RuntimeInfo } from "./protocol";

type BindingOverrides = Partial<PaneBinding>;

function binding(overrides: BindingOverrides = {}): PaneBinding {
  return { ...emptyBinding(), ...overrides };
}

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

describe("stored binding migration", () => {
  test("a stored runtime id infers the resume claim for documents predating autoResume", () => {
    const migrated = bindingFromStored({ runtimeId: "rt-old", title: "session", sessionFile: "/s/a.jsonl" });
    expect(migrated).toEqual({
      runtimeId: "rt-old",
      title: "session",
      sessionFile: "/s/a.jsonl",
      autoResume: true,
      daemonGeneration: null,
    });
  });

  test("the broken legacy state (runtimeId already cleared, transcript retained) claims resume", () => {
    const migrated = bindingFromStored({ runtimeId: null, title: "session", sessionFile: "/s/a.jsonl" });
    expect(migrated?.autoResume).toBe(true);
  });

  test("an old pane with neither runtime nor transcript has nothing to resume", () => {
    const migrated = bindingFromStored({ runtimeId: null, title: "session", sessionFile: null });
    expect(migrated?.autoResume).toBe(false);
  });

  test("an explicit claim (false or true) wins over the migration inference", () => {
    expect(bindingFromStored({ runtimeId: "rt", autoResume: false })?.autoResume).toBe(false);
    expect(bindingFromStored({ runtimeId: null, autoResume: true })?.autoResume).toBe(true);
  });

  test("a stored generation is preserved; a malformed id degrades to a placeholder", () => {
    expect(bindingFromStored({ runtimeId: "rt", daemonGeneration: "gen-1" })?.daemonGeneration).toBe("gen-1");
    const malformed = bindingFromStored({ runtimeId: 7 });
    expect(malformed?.runtimeId).toBeNull();
    expect(malformed?.autoResume).toBe(false);
    expect(bindingFromStored("nope")).toBeNull();
  });
});

describe("resume claim across runtime loss", () => {
  const live = binding({ autoResume: true, sessionFile: "/s/a.jsonl", runtimeId: "rt-1", daemonGeneration: "gen-1" });

  test("a runtime that vanished under the same daemon is a deliberate stop", () => {
    expect(intentAfterRuntimeLoss(live, { up: true, generation: "gen-1" })).toBe(false);
  });

  test("a generation change means the daemon restarted: keep the claim", () => {
    expect(intentAfterRuntimeLoss(live, { up: true, generation: "gen-2" })).toBe(true);
  });

  test("an unreachable daemon cannot prove a stop: keep the claim", () => {
    expect(intentAfterRuntimeLoss(live, { up: false, generation: "gen-1" })).toBe(true);
  });

  test("unknown generations (a pre-upgrade document) keep the claim", () => {
    expect(intentAfterRuntimeLoss(binding({ autoResume: true, sessionFile: "/s/a.jsonl" }), { up: true, generation: "gen-2" })).toBe(true);
    expect(intentAfterRuntimeLoss(live, { up: true, generation: null })).toBe(true);
  });

  test("a pane without a transcript has nothing to resume", () => {
    expect(intentAfterRuntimeLoss(binding({ autoResume: true, runtimeId: "rt-1" }), { up: true, generation: "gen-2" })).toBe(false);
  });

  test("loss never invents a claim on a stopped pane, even across a restart", () => {
    const stopped = binding({ autoResume: false, sessionFile: "/s/a.jsonl", runtimeId: "rt-1", daemonGeneration: "gen-1" });
    expect(intentAfterRuntimeLoss(stopped, { up: true, generation: "gen-2" })).toBe(false);
    expect(intentAfterRuntimeLoss(stopped, { up: false, generation: null })).toBe(false);
  });
});

describe("resume claim across a process exit", () => {
  test("a daemon-wide shutdown keeps the claim for the next daemon start", () => {
    expect(intentAfterExit(binding({ autoResume: true, sessionFile: "/s/a.jsonl" }), true)).toBe(true);
  });

  test("an ordinary exit (omp quit, crash, kill) ends the claim", () => {
    expect(intentAfterExit(binding({ autoResume: true, sessionFile: "/s/a.jsonl" }), false)).toBe(false);
  });

  test("a stopped pane stays stopped through a daemon shutdown", () => {
    expect(intentAfterExit(binding({ autoResume: false, sessionFile: "/s/a.jsonl" }), true)).toBe(false);
  });
});

describe("pending resumes", () => {
  const wanted = binding({ autoResume: true, sessionFile: "/s/a.jsonl" });
  const other = binding({ autoResume: true, sessionFile: "/s/b.jsonl", title: "b" });

  test("panes claiming the same transcript are grouped into one resume", () => {
    const second = { ...wanted, title: "second view" };
    expect(pendingResumes([wanted, second, other], [])).toEqual([
      { sessionFile: "/s/a.jsonl", live: null },
      { sessionFile: "/s/b.jsonl", live: null },
    ]);
  });

  test("an existing live runtime writing the transcript is offered for adoption", () => {
    const live = runtime({ id: "rt-live", sessionFile: "/s/a.jsonl" });
    expect(pendingResumes([wanted], [live])).toEqual([{ sessionFile: "/s/a.jsonl", live }]);
  });

  test("an exited runtime is not adopted", () => {
    const dead = runtime({ id: "rt-dead", sessionFile: "/s/a.jsonl", alive: false, pid: null, status: "exited" });
    expect(pendingResumes([wanted], [dead])).toEqual([{ sessionFile: "/s/a.jsonl", live: null }]);
  });

  test("a reserved runtime already holding the transcript is adopted, not duplicated", () => {
    // `POST /api/runtimes` without resume reserves a runtime (`alive:false`,
    // `pid:null`) whose process starts on first attach; it is not dead.
    const reserved = runtime({ id: "rt-reserved", sessionFile: "/s/a.jsonl", alive: false, pid: null, status: "idle" });
    expect(pendingResumes([wanted], [reserved])).toEqual([{ sessionFile: "/s/a.jsonl", live: reserved }]);
  });

  test("attached panes, stopped panes and transcript-less panes are skipped", () => {
    const attached = binding({ autoResume: true, sessionFile: "/s/a.jsonl", runtimeId: "rt-1" });
    const stopped = binding({ autoResume: false, sessionFile: "/s/b.jsonl" });
    const noFile = binding({ autoResume: true });
    expect(pendingResumes([attached, stopped, noFile], [])).toEqual([]);
  });
});

describe("attachable runtimes", () => {
  test("a reserved runtime that has not been attached yet is attachable", () => {
    expect(attachable(runtime({ alive: false, pid: null, status: "idle" }))).toBe(true);
  });

  test("an exited process is final", () => {
    expect(attachable(runtime({ alive: false, pid: null, status: "exited" }))).toBe(false);
  });

  test("a running runtime is attachable", () => {
    expect(attachable(runtime({ alive: true, status: "streaming" }))).toBe(true);
  });
});

describe("binding constructors", () => {
  test("a live runtime bind claims resume and stamps the current generation", () => {
    const info = runtime({ sessionFile: "/s/a.jsonl", title: "sniffed" });
    expect(bindingForRuntime(info, "gen-1", "nicer")).toEqual({
      runtimeId: "rt-1",
      title: "nicer",
      sessionFile: "/s/a.jsonl",
      autoResume: true,
      daemonGeneration: "gen-1",
    });
    expect(bindingForRuntime(info, "gen-1").title).toBe("sniffed");
  });
});
