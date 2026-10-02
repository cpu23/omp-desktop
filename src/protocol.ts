/** Wire protocol between the daemon and browser clients (P0: one runtime). */

export type RuntimeInfo = {
  id: string;
  alive: boolean;
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: string | null;
  bytesOut: number;
};

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "hello"; runtime: RuntimeInfo; replayBytes: number }
  | { type: "runtime"; runtime: RuntimeInfo }
  | { type: "exit"; exitCode: number | null };

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  if (msg.type === "input" && typeof msg.data === "string") {
    return { type: "input", data: msg.data };
  }
  if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
    const cols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
    const rows = Math.max(2, Math.min(300, Math.floor(msg.rows)));
    if (Number.isFinite(cols) && Number.isFinite(rows)) return { type: "resize", cols, rows };
  }
  return null;
}
