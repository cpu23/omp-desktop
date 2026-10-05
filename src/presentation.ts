/**
 * Presentation reads for the sidebar: the injected omp-mobile extension serves
 * a small owner-only (0600) unix socket per runtime id and answers `GET /status`
 * with `{ accent, agentActive, completion? }`.
 *
 * This mirrors the mobile gateway's IPC client (omp-mobile/server.ts
 * `ipcRequest`/`readExtensionState`): lstat the socket, require owner-only
 * permissions, speak one HTTP/1.1 request with the shared token. Only the
 * lightweight `/status` projection is used — `/state` materializes the whole
 * transcript, which both wastes work and can exceed any sane byte cap on long
 * sessions. Every failure (missing socket, stale socket, timeout, non-2xx,
 * oversized or malformed body) resolves to `null` = unavailable; callers must
 * not translate that into an inferred working/done state.
 */
import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards";
import { parsePresentation, type RuntimePresentation } from "./protocol";

/** Same runtime-id shape the extension accepts for `OMP_MOBILE_SLOT` (also blocks path traversal). */
const RUNTIME_ID = /^rt-[A-Za-z0-9-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 600;
/** The client polls `/api/runtimes` every 2.5s; these keep one poll from doubling the work. */
const DEFAULT_OK_TTL_MS = 500;
const DEFAULT_FAIL_TTL_MS = 1500;
const MAX_STATUS_BYTES = 16 * 1024;

export type PresentationReaderOptions = {
  /** Directory holding `<runtime-id>.sock` (the extension's OMP_MOBILE_STATE_DIR). */
  dir: string;
  /** Token the extension requires when configured; null/absent sends no auth headers. */
  token?: string | null;
  /** Total budget for one read; the sidebar must never stall on a wedged socket. */
  timeoutMs?: number;
  okTtlMs?: number;
  failTtlMs?: number;
};

type IpcResponse = { status: number; body: string };
type CacheEntry = { at: number; value: RuntimePresentation | null };

export class PresentationReader {
  #dir: string;
  #token: string | null;
  #timeoutMs: number;
  #okTtlMs: number;
  #failTtlMs: number;
  #cache = new Map<string, CacheEntry>();
  #inflight = new Map<string, Promise<RuntimePresentation | null>>();

  constructor(options: PresentationReaderOptions) {
    this.#dir = options.dir;
    this.#token = options.token ?? null;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#okTtlMs = options.okTtlMs ?? DEFAULT_OK_TTL_MS;
    this.#failTtlMs = options.failTtlMs ?? DEFAULT_FAIL_TTL_MS;
  }

  /** Presentation for one runtime; `null` when unavailable. Never throws. */
  read(id: string): Promise<RuntimePresentation | null> {
    const now = Date.now();
    const cached = this.#cache.get(id);
    if (cached && now - cached.at < (cached.value ? this.#okTtlMs : this.#failTtlMs)) {
      return Promise.resolve(cached.value);
    }
    const inflight = this.#inflight.get(id);
    if (inflight) return inflight;
    const run = this.#withDeadline(this.#readFresh(id))
      .then((value) => {
        this.#cache.set(id, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.#inflight.get(id) === run) this.#inflight.delete(id);
      });
    this.#inflight.set(id, run);
    return run;
  }

  /**
   * Drop cached reads for runtimes that left the pool. Runtime ids are never
   * reused, so a stale entry could only waste memory, never serve the wrong
   * runtime; the daemon (which owns the live pool) calls this per list.
   */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.#cache.keys()) {
      if (!ids.has(id)) this.#cache.delete(id);
    }
  }

  /**
   * A wedged extension must not hold the endpoint open: this deadline races the
   * whole attempt (lstat included), and `#request` has its own absolute timer
   * that destroys the socket at the same budget, so a raced-out attempt cannot
   * leak a connection. `#readFresh` never rejects, so the losing promise
   * settles harmlessly.
   */
  async #withDeadline(work: Promise<RuntimePresentation | null>): Promise<RuntimePresentation | null> {
    const expired = Promise.withResolvers<null>();
    const timer = setTimeout(() => expired.resolve(null), this.#timeoutMs);
    try {
      return await Promise.race([work, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #readFresh(id: string): Promise<RuntimePresentation | null> {
    try {
      if (!(await this.#socketAvailable(id))) return null;
      const response = await this.#request(id, "/status", MAX_STATUS_BYTES);
      if (!response || response.status < 200 || response.status >= 300) return null;
      const value: unknown = JSON.parse(response.body);
      return isRecord(value) ? parsePresentation(value) : null;
    } catch {
      return null;
    }
  }

  async #socketAvailable(id: string): Promise<boolean> {
    if (!RUNTIME_ID.test(id)) return false;
    try {
      const stat = await lstat(join(this.#dir, `${id}.sock`));
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      return stat.isSocket() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  #request(id: string, path: string, maxBytes: number): Promise<IpcResponse | null> {
    const { promise, resolve } = Promise.withResolvers<IpcResponse | null>();
    const socket = createConnection({ path: join(this.#dir, `${id}.sock`) });
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const finish = (response: IpcResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    // Absolute deadline, not socket inactivity: a peer trickling bytes must not
    // keep the connection (and this promise) alive past the budget.
    const timer = setTimeout(() => finish(null), this.#timeoutMs);
    socket.once("error", () => finish(null));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) {
        finish(null);
        return;
      }
      const header = raw.slice(0, split);
      const statusMatch = /^HTTP\/1\.1\s+(\d{3})/m.exec(header);
      if (!statusMatch) {
        finish(null);
        return;
      }
      const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(header)?.[1];
      const payload = raw.slice(split + 4);
      if (contentLength !== undefined && Buffer.byteLength(payload) < Number(contentLength)) {
        finish(null);
        return;
      }
      finish({
        status: Number(statusMatch[1]),
        body: contentLength === undefined ? payload : payload.slice(0, Number(contentLength)),
      });
    });
    socket.once("connect", () => {
      const request = [
        `GET ${path} HTTP/1.1`,
        "Host: omp-mobile",
        "Connection: close",
        ...(this.#token
          ? [`Authorization: Bearer ${this.#token}`, `X-OMP-Mobile-Token: ${this.#token}`]
          : []),
        "",
        "",
      ];
      socket.write(request.join("\r\n"));
    });
    return promise;
  }
}
