import { spawn, type IPty } from "bun-pty";
import { basename } from "node:path";
import type { RuntimeInfo } from "./protocol";
import { sniffSessionFile } from "./sniff";

export type RuntimeSpec = {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};

export type RuntimeExit = { exitCode: number | null; signal?: number | string };

const DEFAULT_REPLAY_LIMIT = 512 * 1024;
/** Output within this window counts as "streaming" in the sidebar. */
const STREAMING_WINDOW_MS = 1500;

/**
 * One omp TUI process on a PTY. Keeps the tail of raw output so a client that
 * attaches later can reconstruct the screen; live clients get bytes as they come.
 */
export class Runtime {
  readonly id: string;
  readonly spec: RuntimeSpec;
  bytesOut = 0;
  startedAt: Date | null = null;
  /** Absolute session file this process is writing, sniffed from omp's OSC 1337. */
  sessionFile: string | null = null;
  lastActivityAt: number | null = null;

  #pty: IPty | null = null;
  #exit: RuntimeExit | null = null;
  #chunks: string[] = [];
  #chunkBytes = 0;
  #dataSubs = new Set<(data: string) => void>();
  #exitSubs = new Set<(exit: RuntimeExit) => void>();
  #fileSubs = new Set<(sessionFile: string) => void>();
  /** Tail of the last chunk: an OSC sequence can split across PTY reads. */
  #sniffCarry = "";

  constructor(spec: RuntimeSpec) {
    this.id = spec.id;
    this.spec = spec;
  }

  get alive(): boolean {
    return this.#pty !== null;
  }

  get pid(): number | null {
    return this.#pty?.pid ?? null;
  }

  get cols(): number {
    return this.#pty?.cols ?? this.spec.cols;
  }

  get rows(): number {
    return this.#pty?.rows ?? this.spec.rows;
  }

  /** See RuntimeStatus: recent bytes = omp is painting or streaming. */
  get status(): RuntimeInfo["status"] {
    if (!this.alive) return this.#exit ? "exited" : "idle";
    return this.lastActivityAt !== null && Date.now() - this.lastActivityAt < STREAMING_WINDOW_MS
      ? "streaming"
      : "idle";
  }

  /** Pane header label before the client can match the session file to a title. */
  get title(): string {
    const file = this.sessionFile;
    if (file) return basename(file).replace(/\.jsonl$/, "");
    return basename(this.spec.cwd) || this.spec.cwd;
  }

  info(): RuntimeInfo {
    return {
      id: this.id,
      alive: this.alive,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt?.toISOString() ?? null,
      bytesOut: this.bytesOut,
      cwd: this.spec.cwd,
      sessionFile: this.sessionFile,
      title: this.title,
      status: this.status,
      lastActivity: this.lastActivityAt === null ? null : new Date(this.lastActivityAt).toISOString(),
    };
  }

  /** Idempotent: a second call while alive is a no-op. */
  start(): void {
    if (this.#pty) return;
    const pty = spawn(this.spec.file, this.spec.args, {
      name: "xterm-256color",
      cols: this.spec.cols,
      rows: this.spec.rows,
      cwd: this.spec.cwd,
      env: this.spec.env,
    });
    this.#pty = pty;
    this.#exit = null;
    this.startedAt = new Date();
    this.bytesOut = 0;
    this.#chunks = [];
    this.#chunkBytes = 0;
    pty.onData((data) => {
      const bytes = Buffer.byteLength(data);
      this.bytesOut += bytes;
      this.lastActivityAt = Date.now();
      const sniffed = sniffSessionFile(this.#sniffCarry, data);
      this.#sniffCarry = sniffed.carry;
      if (sniffed.sessionFile && sniffed.sessionFile !== this.sessionFile) {
        this.sessionFile = sniffed.sessionFile;
        for (const sub of this.#fileSubs) sub(this.sessionFile);
      }
      this.#pushReplay(data, bytes);
      for (const sub of this.#dataSubs) sub(data);
    });
    pty.onExit((event) => {
      this.#pty = null;
      this.#exit = { exitCode: event.exitCode, signal: event.signal };
      for (const sub of this.#exitSubs) sub(this.#exit);
    });
  }

  replay(): string {
    return this.#chunks.join("");
  }

  subscribeData(sub: (data: string) => void): () => void {
    this.#dataSubs.add(sub);
    return () => this.#dataSubs.delete(sub);
  }

  subscribeExit(sub: (exit: RuntimeExit) => void): () => void {
    this.#exitSubs.add(sub);
    return () => this.#exitSubs.delete(sub);
  }

  /** Fires when the transcript omp is writing becomes known or changes. */
  subscribeSessionFile(sub: (sessionFile: string) => void): () => void {
    this.#fileSubs.add(sub);
    return () => this.#fileSubs.delete(sub);
  }

  write(data: string): void {
    this.#pty?.write(data);
  }

  /** Remember the size even when not running, so the next spawn uses it. */
  resize(cols: number, rows: number): void {
    if (!this.#pty) {
      this.spec.cols = cols;
      this.spec.rows = rows;
      return;
    }
    this.#pty.resize(cols, rows);
  }

  /**
   * Kill the child's whole process group: portable-pty puts the child in its own
   * session, so `-pid` reaps omp's own children (LSP servers, subagents) too.
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const pty = this.#pty;
    if (!pty) return;
    const pid = pty.pid;
    try {
      process.kill(-pid, signal);
    } catch {
      // not a process group leader; the direct kill below still works
    }
    try {
      pty.kill(signal);
    } catch {
      this.#pty = null;
    }
  }

  #pushReplay(data: string, bytes: number): void {
    this.#chunks.push(data);
    this.#chunkBytes += bytes;
    while (this.#chunkBytes > DEFAULT_REPLAY_LIMIT && this.#chunks.length > 1) {
      this.#chunkBytes -= Buffer.byteLength(this.#chunks.shift() as string);
    }
  }
}
