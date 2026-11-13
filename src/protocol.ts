/** Wire protocol between the daemon and browser clients. */
import { isRecord } from "./guards";
import type { SessionSummary as StoredSessionSummary } from "./sessions";

// Re-exported for the client bundle: `export type` is erased at build time, so
// importing this does not pull the daemon-side session index into the browser.
export type { SessionSummary } from "./sessions";

/**
 * `starting` means the process exists but its first real terminal frame has
 * not yet been parsed. `streaming` is the recent-byte heuristic; `idle` and
 * `exited` retain their existing meanings.
 */
export type RuntimeStatus = "starting" | "streaming" | "idle" | "exited";

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
  /** An outstanding user interaction from the extension's lightweight status. */
  pendingAction?: { id: string; kind: "approval" | "ask" | "plan" | "dialog"; title: string };
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
  | { type: "input"; data: string; id?: string }
  | { type: "terminalReply"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "hello"; runtime: RuntimeInfo; replayBytes: number }
  | { type: "ready"; runtime: RuntimeInfo }
  | { type: "inputAck"; id: string }
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
export type RuntimesPayload = { runtimes: RuntimeInfo[]; generation: string | null; defaultCwd: string | null };

const CSI_DA = /\x1b\[(?:[?>])?\d+(?:;\d+)*c/y;
const CSI_DSR = /\x1b\[(?:\?)?(?:0|3)n/y;
const CSI_CPR = /\x1b\[(?:\?)?\d+(?:;\d+)*R/y;
const CSI_DECRPM = /\x1b\[\?\d+;[0-4]\$y/y;
const CSI_KEYBOARD = /\x1b\[\?\d+(?:;\d+)*u/y;
const CSI_WINDOW = /\x1b\[\d+(?:;\d+)*t/y;
const OSC_COLOR = /\x1b\](?:10|11);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/iy;
const TERMINAL_REPLY_PATTERNS = [CSI_DA, CSI_DSR, CSI_CPR, CSI_DECRPM, CSI_KEYBOARD, CSI_WINDOW, OSC_COLOR];

/**
 * Only accept complete terminal capability/status replies generated in
 * response to queries. These may be concatenated, but no user text or other
 * escape sequence can be smuggled through the terminalReply channel.
 */
export function isTerminalReply(data: string): boolean {
  if (data.length === 0 || data.length > MAX_RUNTIME_INPUT_CODE_UNITS) return false;
  let offset = 0;
  while (offset < data.length) {
    let matched = false;
    for (const pattern of TERMINAL_REPLY_PATTERNS) {
      pattern.lastIndex = offset;
      if (pattern.exec(data)) {
        offset = pattern.lastIndex;
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

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
  if (value.pid !== null && typeof value.pid !== "number") return false;
  if (value.sessionFile !== null && typeof value.sessionFile !== "string") return false;
  if (
    value.status !== "starting" &&
    value.status !== "streaming" &&
    value.status !== "idle" &&
    value.status !== "exited"
  ) return false;
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
  const action = value.pendingAction;
  const pendingAction: RuntimePresentation["pendingAction"] = isRecord(action) &&
    typeof action.id === "string" && action.id.length > 0 &&
    (action.kind === "approval" || action.kind === "ask" || action.kind === "plan" || action.kind === "dialog") &&
    typeof action.title === "string"
    ? { id: action.id, kind: action.kind, title: action.title }
    : undefined;
  return { accent, agentActive: value.agentActive, completion, ...(pendingAction ? { pendingAction } : {}) };
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
  const defaultCwd = isRecord(payload.defaults) && typeof payload.defaults.cwd === "string"
    ? payload.defaults.cwd
    : null;
  return { runtimes, generation, defaultCwd };
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
  if (value.type === "ready") {
    const runtime = parseRuntimeInfo(value.runtime);
    return runtime ? { type: "ready", runtime } : null;
  }
  if (value.type === "hello") {
    const runtime = parseRuntimeInfo(value.runtime);
    if (!runtime) return null;
    const replayBytes = value.replayBytes;
    return { type: "hello", runtime, replayBytes: typeof replayBytes === "number" ? replayBytes : 0 };
  }
  if (value.type === "inputAck" && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 64) {
    return { type: "inputAck", id: value.id };
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
    if (value.id !== undefined &&
        (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64)) return null;
    return { type: "input", data: value.data, ...(typeof value.id === "string" ? { id: value.id } : {}) };
  }
  if (value.type === "terminalReply" && typeof value.data === "string" && isTerminalReply(value.data)) {
    return { type: "terminalReply", data: value.data };
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
