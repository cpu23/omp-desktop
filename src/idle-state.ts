import { relative, resolve, sep } from "node:path";

import { isRecord } from "./guards";

export type IdleHostObservation = {
  sessionFile: string | null;
  sessionId: string | null;
  reasons: readonly string[];
};

export type IdleRuntimeStatus = {
  hostId: string;
  sessionId: string | null;
  sessionFile: string | null;
  idleSince: number | null;
  reasons: string[];
  revision: number;
  unloading: boolean;
};

export type IdleTransition =
  | { kind: "accepted" }
  | { kind: "conflict"; reason: string };

type Phase = "open" | "unload-pending" | "unloading";

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "aborted"]);
const RUNTIME_ID_RE = /^rt-[A-Za-z0-9-]{1,64}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Conservatively classify OMP's async-job snapshot; any unrecognized shape blocks unloading. */
export function asyncJobBlockers(snapshot: unknown): string[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.running) || !Array.isArray(snapshot.recent) || !isRecord(snapshot.delivery)) {
    return ["async_job_state_unknown"];
  }

  const reasons = new Set<string>();
  for (const item of snapshot.running) {
    if (!isRecord(item) || !nonEmptyString(item.id) || !nonEmptyString(item.type) || !nonEmptyString(item.status)) {
      reasons.add("async_job_state_unknown");
      continue;
    }
    reasons.add("async_jobs_running");
  }

  for (const item of snapshot.recent) {
    if (!isRecord(item) || !nonEmptyString(item.id) || !nonEmptyString(item.type) || !nonEmptyString(item.status)) {
      reasons.add("async_job_state_unknown");
      continue;
    }
    if (item.status === "running") reasons.add("async_jobs_running");
    else if (!TERMINAL_JOB_STATES.has(item.status)) reasons.add("async_job_state_unknown");
  }

  const delivery = snapshot.delivery;
  const queued = delivery.queued;
  const delivering = delivery.delivering;
  const pendingJobIds = delivery.pendingJobIds;
  if (
    typeof queued !== "number" || !Number.isInteger(queued) || queued < 0 ||
    typeof delivering !== "boolean" || !Array.isArray(pendingJobIds) ||
    pendingJobIds.some((id) => !nonEmptyString(id))
  ) {
    reasons.add("async_job_state_unknown");
  } else if (queued > 0 || delivering || pendingJobIds.length > 0) {
    reasons.add("async_job_delivery_pending");
  }
  return [...reasons].sort();
}

export type NamedBashService = { name: string; cwd: string | null };

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serviceFromMessage(message: Record<string, unknown>): NamedBashService[] {
  const found: NamedBashService[] = [];
  const add = (toolName: unknown, argsValue: unknown) => {
    if (toolName !== "bash") return;
    const args = parseArguments(argsValue);
    if (!args || !nonEmptyString(args.name)) return;
    found.push({ name: args.name, cwd: nonEmptyString(args.cwd) ? args.cwd : null });
  };
  add(message.toolName ?? message.name, message.arguments ?? message.args ?? message.input);
  const details = isRecord(message.details) ? message.details : undefined;
  const service = details && isRecord(details.service) ? details.service : undefined;
  if (service && nonEmptyString(service.name)) {
    found.push({ name: service.name, cwd: nonEmptyString(service.cwd) ? service.cwd : null });
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      add(part.toolName ?? part.name, part.arguments ?? part.args ?? part.input);
    }
  }
  return found;
}

/** Read named Bash launches from persisted OMP branch entries. */
export function namedBashServicesInBranch(branch: unknown): NamedBashService[] | null {
  if (!Array.isArray(branch)) return null;
  const refs = new Map<string, NamedBashService>();
  for (const entry of branch) {
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    for (const service of serviceFromMessage(entry.message)) {
      refs.set(`${service.name}\\0${service.cwd ?? ""}`, service);
    }
  }
  return [...refs.values()];
}

const ACTIVE_SERVICE_STATES = new Set(["starting", "running", "stopping", "restarting"]);
const STOPPED_SERVICE_STATES = new Set(["stopped", "exited", "failed", "completed", "cancelled"]);


function containsDirectory(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}
/** Classify the public `omp ps list --json --all` result for known service references. */
export function backgroundServiceBlockers(snapshot: unknown, refs: readonly NamedBashService[]): string[] {
  if (refs.length === 0) return [];
  if (!Array.isArray(snapshot)) return ["service_registry_unknown"];
  const projects: Array<{ projectDir: string; daemons: unknown[] }> = [];
  for (const item of snapshot) {
    if (!isRecord(item)) return ["service_registry_unknown"];
    if (item.kind === "global") continue;
    if (item.kind !== "project" || !nonEmptyString(item.projectDir) || !Array.isArray(item.daemons)) {
      return ["service_registry_unknown"];
    }
    projects.push({ projectDir: item.projectDir, daemons: item.daemons });
  }

  const reasons = new Set<string>();
  const inspectDaemon = (daemon: unknown): void => {
    if (!isRecord(daemon) || !nonEmptyString(daemon.state)) {
      reasons.add("service_registry_unknown");
    } else if (ACTIVE_SERVICE_STATES.has(daemon.state)) {
      reasons.add("named_bash_service_running");
    } else if (!STOPPED_SERVICE_STATES.has(daemon.state)) {
      reasons.add("service_registry_unknown");
    }
  };

  for (const ref of refs) {
    if (ref.cwd) {
      const cwd = resolve(ref.cwd);
      for (const project of projects) {
        const projectMatches = containsDirectory(project.projectDir, cwd);
        for (const daemon of project.daemons) {
          const daemonMatches = isRecord(daemon) && typeof daemon.cwd === "string" && resolve(daemon.cwd) === cwd;
          if ((projectMatches || daemonMatches) && isRecord(daemon) && daemon.name === ref.name) inspectDaemon(daemon);
        }
      }
      continue;
    }
    for (const project of projects) {
      for (const daemon of project.daemons) {
        if (isRecord(daemon) && daemon.name === ref.name) inspectDaemon(daemon);
      }
    }
  }
  return [...reasons].sort();
}

export class IdleActivityState {
  readonly hostId: string;
  #sessionId: string | null = null;
  #sessionFile: string | null = null;
  #idleSince: number | null = null;
  #phase: Phase = "open";
  #pendingPrompts = new Set<string>();
  #pendingUnload: { sessionFile: string; idleTimeoutMs: number } | null = null;
  #revision = 0;
  #lastSignature = "";

  constructor(hostId: string) {
    this.hostId = hostId;
  }

  status(observation: IdleHostObservation, now: number): IdleRuntimeStatus {
    const reasons = this.#observe(observation, now);
    if (this.#pendingPrompts.size > 0) reasons.add("prompt_pending");
    if (this.#phase === "unload-pending") reasons.add("unload_pending");
    if (this.#phase === "unloading") reasons.add("unloading");
    return this.#status(reasons);
  }

  /** Record an execution/input edge even if it starts and finishes between polls. */
  noteActivity(): void {
    this.#idleSince = null;
    this.#bump();
  }

  beginPrompt(sessionFile: string, requestId: string, text: string, observation: IdleHostObservation, now: number): IdleTransition {
    this.#observe(observation, now);
    if (this.#phase === "unloading" || this.#phase === "unload-pending") {
      return { kind: "conflict", reason: "unloading" };
    }
    if (!sessionFile || observation.sessionFile !== sessionFile || !observation.sessionId) {
      return { kind: "conflict", reason: "session_changed" };
    }
    if (!text.trim()) return { kind: "conflict", reason: "empty_prompt" };
    this.#pendingPrompts.add(requestId);
    this.#idleSince = null;
    this.#bump();
    return { kind: "accepted" };
  }

  /** Release only this submission after the host dispatches, queues, or rejects it. */
  promptHandedOff(requestId: string): void {
    if (!this.#pendingPrompts.delete(requestId)) return;
    this.#idleSince = null;
    this.#bump();
  }

  beginUnload(
    sessionFile: string,
    idleTimeoutMs: number,
    observation: IdleHostObservation,
    now: number,
  ): IdleTransition {
    const reasons = this.#observe(observation, now);
    if (this.#phase !== "open") return { kind: "conflict", reason: this.#phase.replaceAll("-", "_") };
    if (this.#pendingPrompts.size > 0) return { kind: "conflict", reason: "prompt_pending" };
    if (!sessionFile || observation.sessionFile !== sessionFile || !observation.sessionId) {
      return { kind: "conflict", reason: "session_changed" };
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      return { kind: "conflict", reason: "invalid_idle_timeout" };
    }
    if (reasons.size > 0) return { kind: "conflict", reason: [...reasons].sort()[0]! };
    if (this.#idleSince === null || now - this.#idleSince < idleTimeoutMs) {
      return { kind: "conflict", reason: "idle_timeout_not_elapsed" };
    }
    this.#phase = "unload-pending";
    this.#pendingUnload = { sessionFile, idleTimeoutMs };
    this.#bump();
    return { kind: "accepted" };
  }

  /** Fresh check immediately before invoking the host's graceful shutdown API. */
  completeUnload(observation: IdleHostObservation, now: number): boolean {
    if (this.#phase !== "unload-pending" || !this.#pendingUnload) return false;
    const reasons = this.#observe(observation, now);
    const pending = this.#pendingUnload;
    if (
      reasons.size > 0 || this.#pendingPrompts.size > 0 || observation.sessionFile !== pending.sessionFile ||
      this.#idleSince === null || now - this.#idleSince < pending.idleTimeoutMs
    ) {
      this.#phase = "open";
      this.#pendingUnload = null;
      this.#idleSince = null;
      this.#bump();
      return false;
    }
    this.#phase = "unloading";
    this.#pendingUnload = null;
    this.#bump();
    return true;
  }

  cancelPendingUnload(): void {
    if (this.#phase !== "unload-pending") return;
    this.#phase = "open";
    this.#pendingUnload = null;
    this.#idleSince = null;
    this.#bump();
  }

  #observe(observation: IdleHostObservation, now: number): Set<string> {
    const reasons = new Set(observation.reasons.filter((reason) => typeof reason === "string" && reason.length > 0));
    const hasIdentity = Boolean(observation.sessionFile && observation.sessionId);
    if (!hasIdentity) reasons.add("session_identity_unavailable");
    if (!Number.isFinite(now)) reasons.add("clock_unavailable");

    if (this.#sessionFile !== observation.sessionFile || this.#sessionId !== observation.sessionId) {
      this.#sessionFile = observation.sessionFile;
      this.#sessionId = observation.sessionId;
      this.#idleSince = null;
      this.#bump();
    }

    if (
      reasons.size > 0 || !hasIdentity || this.#pendingPrompts.size > 0 ||
      this.#phase === "unloading"
    ) {
      this.#idleSince = null;
    } else if (this.#idleSince === null) {
      this.#idleSince = now;
    }

    const signature = JSON.stringify([
      this.#sessionFile,
      this.#sessionId,
      this.#idleSince,
      this.#phase,
      this.#pendingPrompts.size,
      [...reasons].sort(),
    ]);
    if (signature !== this.#lastSignature) {
      this.#lastSignature = signature;
      this.#revision++;
    }
    return reasons;
  }

  #status(reasons: Set<string>): IdleRuntimeStatus {
    return {
      hostId: this.hostId,
      sessionId: this.#sessionId,
      sessionFile: this.#sessionFile,
      idleSince: this.#idleSince,
      reasons: [...new Set([...reasons, ...(this.#pendingPrompts.size > 0 ? ["prompt_pending"] : [])])].sort(),
      revision: this.#revision,
      unloading: this.#phase === "unload-pending" || this.#phase === "unloading",
    };
  }

  #bump(): void {
    this.#revision++;
    this.#lastSignature = "";
  }
}

export function isRuntimeId(value: string): boolean {
  return RUNTIME_ID_RE.test(value);
}


/** Finished subagents stay registered; their retained session may still own work. */
export function subagentBlockers(value: unknown): string[] {
  if (!isRecord(value)) return ["subagent_state_unknown"];
  if (value.status === "running") return ["subagent_active"];
  if ((value.status === "parked" || value.status === "aborted") && value.session === null) return [];
  if (value.status !== "idle" || !isRecord(value.session)) return ["subagent_state_unknown"];
  const session = value.session;
  try {
    const agent = isRecord(session.agent) ? session.agent : undefined;
    if (typeof session.isStreaming !== "boolean" || typeof session.hasAdmittedSubmission !== "boolean" ||
        typeof session.hasPendingAsyncWork !== "function" || typeof session.getAsyncJobSnapshot !== "function" ||
        typeof agent?.hasQueuedMessages !== "function") return ["subagent_state_unknown"];
    if (session.isStreaming || session.hasAdmittedSubmission ||
        session.hasPendingAsyncWork.call(session) !== false || agent.hasQueuedMessages.call(agent) !== false) {
      return ["subagent_active"];
    }
    return asyncJobBlockers(session.getAsyncJobSnapshot.call(session)).map((reason) => `subagent_${reason}`);
  } catch {
    return ["subagent_state_unknown"];
  }
}
