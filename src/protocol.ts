/** Wire protocol between the daemon and browser clients. */
import { isRecord } from "./guards";
import type { SessionSummary as StoredSessionSummary } from "./sessions";

// Re-exported for the client bundle: `export type` is erased at build time, so
// importing this does not pull the daemon-side session index into the browser.
export type { SessionSummary } from "./sessions";

/**
 * `streaming` = bytes arrived recently. It is a
 * byte-rate heuristic, not knowledge of what omp is doing: omp repaints its
 * status line periodically, so long silences still mean "probably done talking".
 * When `presentation` is present it is authoritative instead: the injected
 * omp-mobile extension reports the agent's own start/end events.
 */
export type RuntimeStatus = "streaming" | "idle" | "exited";

/**
 * Live state reported by the runtime's injected omp-mobile extension over its
 * per-runtime IPC socket. Every field is validated here; `null`/absent on the
 * `RuntimeInfo` means the extension state is unavailable (socket missing,
 * timeout, rejected payload), never "infer it from PTY bytes".
 */
export type RuntimePresentation = {
  /** Session accent hex, as the extension resolved it; null when the theme exposes none. */
  accent: string | null;
  /** True between the agent's start and end events: the turn is still running. */
  agentActive: boolean;
  /** Last finished turn of the currently observed session; null when none is known. */
  completion: { identity: string; completedAt: number } | null;
};

export type RuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: string | null;
  bytesOut: number;
  cwd: string;
  /** Sniffed from omp's OSC 1337 `omp_session_file` (emitted when TERM_PROGRAM=tern). */
  sessionFile: string | null;
  title: string;
  status: RuntimeStatus;
  lastActivity: string | null;
  /**
   * Optional so `Runtime.info()` and older payloads stay valid; enriched on
   * `GET /api/runtimes` from the mobile extension socket. Absent (or null) =
   * unavailable, and consumers must not substitute the `status` heuristic.
   */
  presentation?: RuntimePresentation | null;
};
export type RuntimeScreenSnapshot = { cols: number; rows: number; screen: string };

export const MAX_RUNTIME_INPUT_CODE_UNITS = 16_384;

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "hello"; runtime: RuntimeInfo; replayBytes: number }
  | {
      type: "exit";
      exitCode: number | null;
      /**
       * True when the daemon itself is going away (restart), not when omp
       * exited: a reconnect keeps a pane's resume claim only for a shutdown.
       */
      daemonShutdown: boolean;
    };

export type RuntimesResponse = {
  build: string;
  /** Changes on every daemon start; clients read it to tell restart from stop. */
  generation: string;
  runtimes: RuntimeInfo[];
  defaults: { cwd: string; maxRuntimes: number };
};

/** The client-side view of `GET /api/runtimes`. */
export type RuntimesPayload = { runtimes: RuntimeInfo[]; generation: string | null };

// Everything below crosses a process boundary (HTTP, websocket, localStorage).
// Validate once here instead of casting and trusting reads at the use site.

type RuntimeInfoBase = Omit<RuntimeInfo, "presentation">;

function isRuntimeInfoBase(value: unknown): value is RuntimeInfoBase {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.cwd !== "string") return false;
  // `alive`/`status` drive attach decisions (a reserved runtime is alive:false,
  // status idle, and still attachable; exited is final), so they are required
  // here rather than trusted to be present.
  if (typeof value.alive !== "boolean") return false;
  if (value.status !== "streaming" && value.status !== "idle" && value.status !== "exited") return false;
  if (value.pid !== null && typeof value.pid !== "number") return false;
  if (value.sessionFile !== null && typeof value.sessionFile !== "string") return false;
  return typeof value.cols === "number" && typeof value.rows === "number";
}

/** The UI accepts exactly 6 hex digits, so the daemon publishes nothing else (invalid accents become null). */
const ACCENT_HEX = /^#[0-9a-f]{6}$/i;

/**
 * Validates the optional presentation block (also the body of the extension's
 * `/status` and `/state`). `null` = no trustworthy state: the caller drops the
 * field instead of publishing a guess. A malformed subfield degrades without
 * taking the rest down, except `agentActive`, which has no "unknown" encoding —
 * without a real boolean nothing here may claim the agent is working or done.
 */
export function parsePresentation(value: unknown): RuntimePresentation | null {
  if (!isRecord(value)) return null;
  if (typeof value.agentActive !== "boolean") return null;
  const accent = typeof value.accent === "string" && ACCENT_HEX.test(value.accent) ? value.accent : null;
  let completion: RuntimePresentation["completion"] = null;
  if (isRecord(value.completion)) {
    const { identity, completedAt } = value.completion;
    if (
      typeof identity === "string" &&
      identity.length > 0 &&
      typeof completedAt === "number" &&
      Number.isFinite(completedAt)
    ) {
      completion = { identity, completedAt };
    }
  }
  return { accent, agentActive: value.agentActive, completion };
}

/**
 * Core runtime fields are mandatory, but the presentation block is an optional
 * enhancement: a malformed one is dropped (unavailable) rather than rejecting
 * the runtime, so one bad extension socket cannot blank the whole sidebar.
 */
export function parseRuntimeInfo(value: unknown): RuntimeInfo | null {
  if (!isRuntimeInfoBase(value)) return null;
  const { presentation: raw, ...core } = value as RuntimeInfoBase & { presentation?: unknown };
  const presentation = parsePresentation(raw);
  return presentation === null ? core : { ...core, presentation };
}

export function parseRuntimesResponse(payload: unknown): RuntimesPayload | null {
  if (!isRecord(payload) || !Array.isArray(payload.runtimes)) return null;
  const runtimes: RuntimeInfo[] = [];
  for (const entry of payload.runtimes) {
    const runtime = parseRuntimeInfo(entry);
    if (!runtime) return null;
    runtimes.push(runtime);
  }
  const generation = typeof payload.generation === "string" && payload.generation.length > 0
    ? payload.generation
    : null;
  return { runtimes, generation };
}

export function parseRuntimeOne(payload: unknown): RuntimeInfo | null {
  if (!isRecord(payload)) return null;
  return parseRuntimeInfo(payload.runtime);
}

/** Path of the stored clipboard image, typed into the pane's prompt. */
export function parsePasteResponse(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.path === "string" && payload.path.length > 0 ? payload.path : null;
}

export function parseSessionList(payload: unknown): SessionSummaryLike[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) return null;
  const sessions: SessionSummaryLike[] = [];
  for (const entry of payload.sessions) {
    if (!isRecord(entry)) return null;
    const { id, path, cwd, title, updatedAt, costUsd } = entry;
    if (typeof id !== "string" || typeof path !== "string" || typeof cwd !== "string") return null;
    if (typeof title !== "string" || typeof updatedAt !== "string") return null;
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return null;
    sessions.push({ id, path, cwd, title, updatedAt, costUsd });
  }
  return sessions;
}

/** The session fields the UI actually reads. */
export type SessionSummaryLike = Pick<
  StoredSessionSummary,
  "id" | "path" | "cwd" | "title" | "updatedAt" | "costUsd"
>;

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "hello") {
    const runtime = parseRuntimeInfo(value.runtime);
    if (!runtime) return null;
    const replayBytes = value.replayBytes;
    return { type: "hello", runtime, replayBytes: typeof replayBytes === "number" ? replayBytes : 0 };
  }
  if (value.type === "exit" && (value.exitCode === null || typeof value.exitCode === "number")) {
    return { type: "exit", exitCode: value.exitCode, daemonShutdown: value.daemonShutdown === true };
  }
  return null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "input" && typeof value.data === "string" && value.data.length <= MAX_RUNTIME_INPUT_CODE_UNITS) {
    return { type: "input", data: value.data };
  }
  if (value.type === "resize" && typeof value.cols === "number" && typeof value.rows === "number") {
    const cols = Math.max(2, Math.min(500, Math.floor(value.cols)));
    const rows = Math.max(2, Math.min(300, Math.floor(value.rows)));
    if (Number.isFinite(cols) && Number.isFinite(rows)) return { type: "resize", cols, rows };
  }
  return null;
}

/**
 * `GET /api/state` response (`{ state, savedAt, corrupt, path }`). The document
 * inside is owned by the client; the version check keeps this build from
 * silently overwriting a newer format with its own.
 */
export type WorkspaceStatePayload =
  | { kind: "none"; corrupt: boolean }
  | { kind: "unsupported"; version: unknown }
  | { kind: "state"; state: Record<string, unknown> };

export function parseStateResponse(payload: unknown): WorkspaceStatePayload | null {
  if (!isRecord(payload)) return null;
  const state = payload.state;
  if (state === null || state === undefined) return { kind: "none", corrupt: payload.corrupt === true };
  if (!isRecord(state)) return null;
  if (state.version !== 1 && state.version !== 2) return { kind: "unsupported", version: state.version };
  return { kind: "state", state };
}
