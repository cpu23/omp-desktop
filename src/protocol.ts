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
 */
export type RuntimeStatus = "streaming" | "idle" | "exited";

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
};

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "hello"; runtime: RuntimeInfo; replayBytes: number }
  | { type: "exit"; exitCode: number | null };

export type RuntimesResponse = {
  build: string;
  runtimes: RuntimeInfo[];
  defaults: { cwd: string; maxRuntimes: number };
};

// Everything below crosses a process boundary (HTTP, websocket, localStorage).
// Validate once here instead of casting and trusting reads at the use site.

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.cwd !== "string") return false;
  if (value.pid !== null && typeof value.pid !== "number") return false;
  if (value.sessionFile !== null && typeof value.sessionFile !== "string") return false;
  return typeof value.cols === "number" && typeof value.rows === "number" && typeof value.status === "string";
}

export function parseRuntimeList(payload: unknown): RuntimeInfo[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.runtimes)) return null;
  const runtimes: RuntimeInfo[] = [];
  for (const entry of payload.runtimes) {
    if (!isRuntimeInfo(entry)) return null;
    runtimes.push(entry);
  }
  return runtimes;
}

export function parseRuntimeOne(payload: unknown): RuntimeInfo | null {
  if (!isRecord(payload) || !isRuntimeInfo(payload.runtime)) return null;
  return payload.runtime;
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
  if (value.type === "hello" && isRuntimeInfo(value.runtime)) {
    const replayBytes = value.replayBytes;
    return { type: "hello", runtime: value.runtime, replayBytes: typeof replayBytes === "number" ? replayBytes : 0 };
  }
  if (value.type === "exit" && (value.exitCode === null || typeof value.exitCode === "number")) {
    return { type: "exit", exitCode: value.exitCode };
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
  if (value.type === "input" && typeof value.data === "string") {
    return { type: "input", data: value.data };
  }
  if (value.type === "resize" && typeof value.cols === "number" && typeof value.rows === "number") {
    const cols = Math.max(2, Math.min(500, Math.floor(value.cols)));
    const rows = Math.max(2, Math.min(300, Math.floor(value.rows)));
    if (Number.isFinite(cols) && Number.isFinite(rows)) return { type: "resize", cols, rows };
  }
  return null;
}
