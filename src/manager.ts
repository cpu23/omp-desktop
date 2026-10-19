import { existsSync } from "node:fs";
import { Runtime, type RuntimeSpec } from "./runtime";
import type { RuntimeInfo } from "./protocol";
import type { LiveSession } from "./state";

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
 * A create refused because the saved lower limit that awaits restart is already
 * fully allocated. Distinct from {@link RuntimeCapacityError} so the daemon can
 * explain that the saved limit, not the running one, is what blocks the call.
 */
export class PendingRuntimeCapacityError extends RuntimeCapacityError {
  /** The saved limit this create was checked against. */
  readonly limit: number;

  constructor(limit: number) {
    super(`runtime limit reached after restart (${limit})`);
    this.limit = limit;
  }
}

/** Per-create limits that must be enforced at the allocation point. */
export type CreateOptions = {
  /**
   * A saved runtime limit lower than the one this daemon enforces until it
   * restarts. Checked at the same post-transcript-read boundary as the pool
   * limit, so concurrent requests cannot all pass a pre-check and then exceed it.
   */
  maxRuntimes?: number;
};

/**
 * Why the pool changed. The distinction matters to the durable record: a start
 * or a stop is a deliberate, finished statement and is saved at once, while an
 * exit is a process death whose cause the daemon cannot see — during a unit
 * teardown (systemctl stop, logout, reboot) the children die with the daemon and
 * a naive save would drop sessions that were live a moment ago — so the daemon
 * treats an exit as provisional (see daemon.ts).
 */
export type PoolChange = "started" | "stopped" | "exited";

/**
 * P1: a pool of live omp processes. Runtimes outlive the panes that show them —
 * closing a pane only unbinds it, so a session keeps working (and keeps its
 * scrollback) while the user rearranges the layout.
 */
export class RuntimeManager {
  #runtimes = new Map<string, Runtime>();
  /** Transcripts with a create in flight, so concurrent resumes share one process. */
  #pendingResumes = new Map<string, Promise<Runtime>>();
  /** Notified after any change to the set `liveSessions()` returns. */
  #changeSubs = new Set<(change: PoolChange) => void>();
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

  /**
   * The pool's durable meaning: every process that is running (or waiting to be
   * attached) and has a known transcript, deduplicated by transcript. This is
   * what a daemon restart must bring back, independent of any pane or client.
   */
  liveSessions(): LiveSession[] {
    const seen = new Set<string>();
    const sessions: LiveSession[] = [];
    for (const runtime of this.#runtimes.values()) {
      const sessionFile = runtime.sessionFile;
      if (!sessionFile || runtime.status === "exited" || seen.has(sessionFile)) continue;
      seen.add(sessionFile);
      sessions.push({
        sessionFile,
        cwd: runtime.spec.cwd,
        cols: runtime.cols,
        rows: runtime.rows,
      });
    }
    return sessions;
  }

  /** Run `sub` after every create, exit, kill, and transcript sniff. */
  subscribeChanges(sub: (change: PoolChange) => void): () => void {
    this.#changeSubs.add(sub);
    return () => this.#changeSubs.delete(sub);
  }

  /**
   * Every allocation in the pool whose process has not exited: resumed
   * sessions, fresh sessions whose transcript omp has not announced yet, and
   * idle runtimes waiting for a pane. Unlike `liveSessions()`, this does not
   * dedupe by transcript or drop unbound runtimes, so a capacity guard built on
   * it cannot let two fresh sessions past a lower saved limit.
   */
  allocated(): number {
    let count = 0;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.status !== "exited") count += 1;
    }
    return count;
  }

  #changed(change: PoolChange): void {
    for (const sub of this.#changeSubs) sub(change);
  }

  /** Watch one runtime's process lifecycle for pool changes. */
  #track(runtime: Runtime): void {
    const changed = (change: PoolChange): void => {
      // A runtime already removed by kill() is out of the pool; its later exit
      // must not report one more change for a state that is already recorded.
      if (this.#runtimes.has(runtime.id)) this.#changed(change);
    };
    runtime.subscribeExit(() => changed("exited"));
    runtime.subscribeSessionFile(() => changed("started"));
  }

  async create(request: SpawnRequest = {}, options: CreateOptions = {}): Promise<Runtime> {
    const resume = request.resume;
    if (resume) {
      // Idempotent resume: a transcript already running (or being started right
      // now by another caller, including the daemon's own restart restore) has
      // exactly one process. A second writer would make omp fork to a sibling
      // file, so duplicates are a correctness problem, not just waste.
      const pending = this.#pendingResumes.get(resume);
      if (pending) return pending;
      const existing = [...this.#runtimes.values()].find(
        (runtime) => runtime.sessionFile === resume && runtime.status !== "exited",
      );
      if (existing) {
        existing.start();
        return existing;
      }
    }
    const creation = this.#spawn(request, options.maxRuntimes);
    if (resume) {
      this.#pendingResumes.set(resume, creation);
      // Clear the slot once the attempt settles, failed or not: a later caller
      // must be able to retry a transcript that could not be started.
      void creation
        .catch(() => {})
        .finally(() => {
          if (this.#pendingResumes.get(resume) === creation) this.#pendingResumes.delete(resume);
        });
    }
    return creation;
  }

  async #spawn(request: SpawnRequest, pendingLimit?: number): Promise<Runtime> {
    const cwd = await this.#workingDirectory(request);
    // Check after the async transcript read: concurrent resume requests must
    // not all reserve the same final slot while that read is in flight.
    if (this.#runtimes.size >= this.defaults.maxRuntimes) {
      throw new RuntimeCapacityError(`runtime limit reached (${this.defaults.maxRuntimes})`);
    }
    // A saved lower limit is pending until restart; the check must happen at
    // this same allocation point, or sequential fresh requests could each pass
    // a pre-check and then all reserve slots. Fresh runtimes have no transcript
    // yet, so this counts allocations, not `liveSessions()`.
    if (pendingLimit !== undefined && this.allocated() >= pendingLimit) {
      throw new PendingRuntimeCapacityError(pendingLimit);
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
    // A resumed transcript is the process's identity from its first frame, not
    // only after omp's OSC 1337 sniff: dedupe, the durable ledger, and clients
    // all key sessions by transcript, and a fork to a sibling file (omp's answer
    // to a foreign writer holding the target) still arrives through the sniff.
    if (request.resume) runtime.sessionFile = request.resume;
    this.#runtimes.set(id, runtime);
    this.#track(runtime);
    try {
      // Started on first attach: no client, no process. `resume` must not be delayed
      // forever though, and the sidebar shows runtimes before any pane attaches, so
      // an explicitly requested session starts now.
      if (request.resume) runtime.start();
    } catch (error) {
      // A spawn that threw leaves no process behind; do not report a session
      // that is not running (the ledger would restore a phantom forever).
      this.#runtimes.delete(id);
      throw error;
    }
    this.#changed("started");
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

  /**
   * Kill and forget. An explicit stop: the runtime leaves the pool, so a
   * restart must not bring its session back. Panes bound to it fall back to an
   * exited placeholder (and their binding's resume claim is the client's
   * concern, not the pool's).
   */
  kill(id: string): boolean {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return false;
    this.#runtimes.delete(id);
    runtime.kill();
    this.#changed("stopped");
    return true;
  }

  /**
   * Kill every process. Only a daemon shutdown calls this, and a shutdown is
   * not the sessions ending: this method deliberately emits no change event, so
   * the durable record keeps describing the pool the next daemon start must
   * restore (the daemon freezes that record before calling this).
   */
  killAll(): void {
    for (const runtime of this.#runtimes.values()) runtime.kill();
    this.#runtimes.clear();
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
