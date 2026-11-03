import { describe, expect, test } from "bun:test";
import { asyncJobBlockers, backgroundServiceBlockers, IdleActivityState, namedBashServicesInBranch, subagentBlockers } from "./idle-state";

const safeObservation = (sessionFile = "/sessions/a.jsonl") => ({
  sessionFile,
  sessionId: "session-a",
  reasons: [] as string[],
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    running: [],
    recent: [],
    delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    ...overrides,
  };
}

describe("desktop idle activity classification", () => {
  test("protects any running background job and all pending delivery states", () => {
    expect(asyncJobBlockers(snapshot({
      running: [{ id: "job-1", type: "bash", status: "running", command: "sleep 3600" }],
    }))).toContain("async_jobs_running");
    expect(asyncJobBlockers(snapshot({ delivery: { queued: 1, delivering: false, pendingJobIds: [] } })))
      .toContain("async_job_delivery_pending");
    expect(asyncJobBlockers(snapshot({ delivery: { queued: 0, delivering: true, pendingJobIds: [] } })))
      .toContain("async_job_delivery_pending");
    expect(asyncJobBlockers(snapshot({ delivery: { queued: 0, delivering: false, pendingJobIds: ["job-2"] } })))
      .toContain("async_job_delivery_pending");
    expect(asyncJobBlockers({ running: [], recent: [] })).toContain("async_job_state_unknown");
  });
  test("tracks named services from branch history and releases protection after registry stop", () => {
    const refs = namedBashServicesInBranch([
      { type: "message", message: { toolName: "bash", arguments: JSON.stringify({ name: "worker", cwd: "/work/project/src" }) } },
    ]);
    expect(refs).toEqual([{ name: "worker", cwd: "/work/project/src" }]);
    expect(backgroundServiceBlockers([
      { kind: "project", projectDir: "/work/project", daemons: [{ name: "worker", cwd: "/work/project/src", state: "running" }] },
      { kind: "global", daemons: [{ name: "unrelated", state: "running" }] },
    ], refs!)).toContain("named_bash_service_running");
    expect(backgroundServiceBlockers([
      { kind: "project", projectDir: "/work/project", daemons: [{ name: "worker", cwd: "/work/project/src", state: "stopped" }] },
      { kind: "project", projectDir: "/work/project", daemons: [{ name: "unrelated", state: "running" }] },
      { kind: "global", daemons: [{ name: "unrelated", state: "running" }] },
    ], refs!)).toEqual([]);
    expect(backgroundServiceBlockers([
      { kind: "project", projectDir: "/work/project", daemons: [{ name: "worker", cwd: "/work/project/src", state: "mystery" }] },
    ], refs!)).toContain("service_registry_unknown");
  });

  test("retained idle subagents stop blocking only after all of their work is quiescent", () => {
    const session = {
      isStreaming: false,
      hasAdmittedSubmission: false,
      hasPendingAsyncWork: () => false,
      getAsyncJobSnapshot: () => snapshot(),
      agent: { hasQueuedMessages: () => false },
    };
    expect(subagentBlockers({ status: "idle", session })).toEqual([]);
    expect(subagentBlockers({ status: "running", session })).toContain("subagent_active");
    expect(subagentBlockers({ status: "idle", session: { ...session, hasAdmittedSubmission: true } })).toContain("subagent_active");
    expect(subagentBlockers({ status: "idle", session: { ...session, agent: { hasQueuedMessages: () => true } } })).toContain("subagent_active");
    expect(subagentBlockers({ status: "idle", session: {
      ...session, getAsyncJobSnapshot: () => snapshot({ running: [{ id: "sleep", type: "bash", status: "running" }] }),
    } })).toContain("subagent_async_jobs_running");
    expect(subagentBlockers({ status: "parked", session: null })).toEqual([]);
    expect(subagentBlockers({ status: "idle", session: {} })).toContain("subagent_state_unknown");
  });

  test("requires one continuous idle interval and a fresh safe unload check", () => {
    const state = new IdleActivityState("host-a");
    expect(state.status(safeObservation(), 1_000).idleSince).toBe(1_000);
    expect(state.status({ ...safeObservation(), reasons: ["agent_active"] }, 4_000).idleSince).toBeNull();
    expect(state.status(safeObservation(), 5_000).idleSince).toBe(5_000);
    expect(state.beginUnload("/sessions/a.jsonl", 10_000, safeObservation(), 14_999))
      .toEqual({ kind: "conflict", reason: "idle_timeout_not_elapsed" });
    expect(state.beginUnload("/sessions/a.jsonl", 10_000, safeObservation(), 15_000))
      .toEqual({ kind: "accepted" });
    expect(state.completeUnload({ ...safeObservation(), reasons: ["async_jobs_running"] }, 15_151)).toBe(false);
    expect(state.status(safeObservation(), 15_200).unloading).toBe(false);
  });

  test("fences prompts and unload atomically while allowing distinct queued follow-ups", () => {
    const state = new IdleActivityState("host-a");
    state.status(safeObservation(), 100);
    expect(state.beginPrompt("/sessions/a.jsonl", "first", "same text", safeObservation(), 200)).toEqual({ kind: "accepted" });
    expect(state.beginPrompt("/sessions/a.jsonl", "second", "same text", safeObservation(), 201)).toEqual({ kind: "accepted" });
    expect(state.beginUnload("/sessions/a.jsonl", 1, safeObservation(), 300))
      .toEqual({ kind: "conflict", reason: "prompt_pending" });
    state.promptHandedOff("first");
    state.promptHandedOff("first");
    expect(state.status(safeObservation(), 350).reasons).toContain("prompt_pending");
    state.promptHandedOff("second");
    state.status(safeObservation(), 400);
    expect(state.beginUnload("/sessions/a.jsonl", 1, safeObservation(), 401)).toEqual({ kind: "accepted" });
    expect(state.beginPrompt("/sessions/a.jsonl", "racing", "racing prompt", safeObservation(), 402))
      .toMatchObject({ kind: "conflict" });
    expect(state.completeUnload(safeObservation(), 552)).toBe(true);
    expect(state.status(safeObservation(), 553).unloading).toBe(true);
    expect(state.beginPrompt("/sessions/a.jsonl", "late", "late prompt", safeObservation(), 554))
      .toEqual({ kind: "conflict", reason: "unloading" });
  });
});
