import { existsSync } from "node:fs";
import { Runtime, type RuntimeSpec } from "./runtime";
import type { RuntimeInfo } from "./protocol";

export type SpawnRequest = {
  /**
   * Working directory for a new session. When resuming, the transcript's
   * recorded cwd wins while it exists; this value is only the fallback for a
   * session whose recorded directory is gone (omp then offers to move it here).
   */
  cwd?: string;
  /** Absolute path of a session file to resume. */
  resume?: string;
  cols?: number;
  rows?: number;
};

export type ManagerDefaults = {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  maxRuntimes: number;
  /**
   * Reads the working directory recorded in a transcript. The manager calls it
   * when resuming so the runtime runs (and is labelled) in the session's own
   * project instead of the daemon's launch directory; the daemon injects
   * sessions.ts's reader, keeping session-store access out of here.
   */
  readResumeCwd?: (path: string) => Promise<string | null>;
};

export class RuntimeCapacityError extends Error {}

/**
 * P1: a pool of live omp processes. Runtimes outlive the panes that show them —
 * closing a pane only unbinds it, so a session keeps working (and keeps its
 * scrollback) while the user rearranges the layout.
 */
export class RuntimeManager {
  #runtimes = new Map<string, Runtime>();
  readonly defaults: ManagerDefaults;

  constructor(defaults: ManagerDefaults) {
    this.defaults = defaults;
  }

  list(): RuntimeInfo[] {
    return [...this.#runtimes.values()].map((runtime) => runtime.info());
  }

  get(id: string): Runtime | undefined {
    return this.#runtimes.get(id);
  }

  async create(request: SpawnRequest = {}): Promise<Runtime> {
    const cwd = await this.#workingDirectory(request);
    // Check after the async transcript read: concurrent resume requests must
    // not all reserve the same final slot while that read is in flight.
    if (this.#runtimes.size >= this.defaults.maxRuntimes) {
      throw new RuntimeCapacityError(`runtime limit reached (${this.defaults.maxRuntimes})`);
    }
    // UUIDs, not a counter: the id is the mobile extension's IPC identity and
    // survives a daemon restart. A reused `rt-1` would let a stale phone page
    // attach to whatever runtime happens to hold that number now.
    const id = `rt-${crypto.randomUUID()}`;
    const spec: RuntimeSpec = {
      id,
      file: this.defaults.file,
      // Resuming pins the exact file: an id prefix could match another session, and
      // omp forks to a sibling file when the target is already being written.
      args: request.resume
        ? [...this.defaults.args, "--resume", request.resume]
        : [...this.defaults.args],
      cwd,
      cols: clamp(request.cols, 2, 500, this.defaults.cols),
      rows: clamp(request.rows, 2, 300, this.defaults.rows),
      env: {
        ...this.defaults.env,
        // omp only emits its OSC 1337 session-file var when it believes it is
        // embedded; that var is how a fresh session's file becomes known.
        TERM_PROGRAM: "tern",
        OMP_DESKTOP_RUNTIME: id,
        // Per-runtime IPC identity: the injected omp-mobile extension serves
        // `<state-dir>/<id>.sock`, so the phone reaches exactly this process.
        OMP_MOBILE_SLOT: id,
      },
    };
    const runtime = new Runtime(spec);
    this.#runtimes.set(id, runtime);
    // Started on first attach: no client, no process. `resume` must not be delayed
    // forever though, and the sidebar shows runtimes before any pane attaches, so
    // an explicitly requested session starts now.
    if (request.resume) runtime.start();
    return runtime;
  }

  /**
   * A resumed session belongs to the directory recorded in its transcript: omp
   * itself switches there, and the sidebar renders this value, so the launch
   * directory must not leak in. Only when the recorded directory is gone (or
   * unreadable) does the request/default cwd remain, which omp uses as the
   * move target for the relocated session.
   */
  async #workingDirectory(request: SpawnRequest): Promise<string> {
    if (request.resume && this.defaults.readResumeCwd) {
      const recorded = await this.defaults.readResumeCwd(request.resume).catch(() => null);
      if (recorded && existsSync(recorded)) return recorded;
    }
    return request.cwd ?? this.defaults.cwd;
  }

  /** Kill and forget. Panes bound to it fall back to an exited placeholder. */
  kill(id: string): boolean {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return false;
    this.#runtimes.delete(id);
    runtime.kill();
    return true;
  }

  killAll(): void {
    for (const runtime of this.#runtimes.values()) runtime.kill();
    this.#runtimes.clear();
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
