import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { isRecord } from "./guards";
import { isRuntimeId, type IdleRuntimeStatus } from "./idle-state";
export type { IdleRuntimeStatus } from "./idle-state";


const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;


export type IdleStatusResult =
  | { kind: "available"; status: IdleRuntimeStatus }
  | { kind: "unavailable"; reason: string };

export type IdleCommandResult =
  | { kind: "accepted" }
  | { kind: "conflict"; reason: string }
  | { kind: "unavailable"; reason: string };

export type IdleRuntimeClientOptions = {
  dir: string;
  token: string;
  timeoutMs?: number;
};

type IpcReply = { status: number; body: string };

function statusFrom(value: unknown): IdleRuntimeStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.hostId !== "string" || value.hostId.length === 0 ||
    !(typeof value.sessionId === "string" || value.sessionId === null) ||
    !(typeof value.sessionFile === "string" || value.sessionFile === null) ||
    !(typeof value.idleSince === "number" && Number.isFinite(value.idleSince) || value.idleSince === null) ||
    !Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== "string") ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.unloading !== "boolean"
  ) {
    return undefined;
  }
  return {
    hostId: value.hostId,
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    idleSince: value.idleSince,
    reasons: value.reasons as string[],
    revision: value.revision as number,
    unloading: value.unloading,
  };
}

function jsonFrom(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Authenticated, bounded client for the desktop-owned per-runtime Unix socket. */
export class IdleRuntimeClient {
  #dir: string;
  #token: string;
  #timeoutMs: number;

  constructor(options: IdleRuntimeClientOptions) {
    this.#dir = options.dir;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async status(id: string): Promise<IdleStatusResult> {
    const reply = await this.#request(id, "GET", "/status");
    if (!reply || reply.status !== 200) return { kind: "unavailable", reason: "status_unavailable" };
    const status = statusFrom(jsonFrom(reply.body));
    return status
      ? { kind: "available", status }
      : { kind: "unavailable", reason: "invalid_status" };
  }

  unload(id: string, input: { sessionFile: string; idleTimeoutMs: number }): Promise<IdleCommandResult> {
    return this.#command(id, "/unload", input);
  }

  prompt(id: string, input: { sessionFile: string; text: string; files?: string[] }): Promise<IdleCommandResult> {
    return this.#command(id, "/prompt", input, Math.max(this.#timeoutMs, 15_000));
  }

  async #command(id: string, path: string, body: unknown, timeoutMs = this.#timeoutMs): Promise<IdleCommandResult> {
    const reply = await this.#request(id, "POST", path, body, timeoutMs);
    if (!reply) return { kind: "unavailable", reason: "ipc_unavailable" };
    const value = jsonFrom(reply.body);
    if (reply.status === 202 && isRecord(value) && value.kind === "accepted") {
      return { kind: "accepted" };
    }
    if (reply.status === 409 && isRecord(value)) {
      return {
        kind: "conflict",
        reason: typeof value.reason === "string" ? value.reason : "conflict",
      };
    }
    if (reply.status >= 400 && reply.status < 500 && reply.status !== 401) {
      return {
        kind: "conflict",
        reason: isRecord(value) && typeof value.reason === "string" ? value.reason : "invalid_request",
      };
    }
    return { kind: "unavailable", reason: "ipc_unavailable" };
  }

  async #request(id: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.#timeoutMs): Promise<IpcReply | null> {
    if (
      !isRuntimeId(id) || !this.#dir || !this.#token || /[\r\n]/.test(this.#token) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    ) {
      return null;
    }
    const socketPath = join(this.#dir, `${id}.sock`);
    try {
      const stat = await lstat(socketPath);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    } catch {
      return null;
    }

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    if (payload && payload.byteLength > MAX_REQUEST_BYTES) return null;
    const { promise, resolve } = Promise.withResolvers<IpcReply | null>();
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    const finish = (reply: IpcReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("error", () => finish(null));
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const bytes = Buffer.concat(chunks, totalBytes);
      const delimiter = bytes.indexOf("\r\n\r\n");
      if (delimiter < 0) {
        finish(null);
        return;
      }
      const headerText = bytes.subarray(0, delimiter).toString("latin1");
      const lines = headerText.split("\r\n");
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(lines[0] ?? "");
      if (!statusMatch) {
        finish(null);
        return;
      }
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon <= 0) {
          finish(null);
          return;
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (!name || headers.has(name)) {
          finish(null);
          return;
        }
        headers.set(name, value);
      }
      if (headers.has("transfer-encoding")) {
        finish(null);
        return;
      }
      const bodyBytes = bytes.subarray(delimiter + 4);
      const contentLength = headers.get("content-length");
      if (contentLength !== undefined) {
        if (!/^\d+$/.test(contentLength) || Number(contentLength) !== bodyBytes.byteLength) {
          finish(null);
          return;
        }
      }
      finish({ status: Number(statusMatch[1]), body: bodyBytes.toString("utf8") });
    });
    socket.once("connect", () => {
      const headers = [
        `${method} ${path} HTTP/1.1`,
        "Host: omp-desktop-idle",
        `Authorization: Bearer ${this.#token}`,
        "Connection: close",
      ];
      if (payload) {
        headers.push("Content-Type: application/json", `Content-Length: ${payload.byteLength}`);
      }
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    return promise;
  }
}
