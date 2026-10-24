import { spawn, type IPty } from "bun-pty";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import type { RuntimeInfo, RuntimeScreenSnapshot } from "./protocol";
import { sniffSessionFile } from "./sniff";
import { RuntimeResourceBudget, type RuntimeResourceLease } from "./resource-budget";
import { TerminalReplay } from "./terminal-replay";

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

type ProcessGroupIdentity = { pid: number; startTime: string };

const STREAMING_WINDOW_MS = 1500;
/** Give interactive shells a short chance to handle a stop before forcing the PTY group down. */
const TERMINATION_GRACE_MS = 500;

/**
 * One omp TUI process on a PTY. Mirrors terminal state for complete snapshots;
 * live clients get the original bytes after the mirror has parsed them.
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
  #replay: TerminalReplay;
  #resources: RuntimeResourceLease;
  #dataSubs = new Set<(data: Uint8Array) => void>();
  #pendingDataSubscribers = 0;
  #exitSubs = new Set<(exit: RuntimeExit) => void>();
  #fileSubs = new Set<(sessionFile: string) => void>();
  #terminationTimer: Timer | null = null;
  #terminating = false;
  #disposed = false;
  #processGroupIdentity: ProcessGroupIdentity | null = null;
  #terminationPromise: Promise<void> | null = null;
  #resolveTermination: (() => void) | null = null;
  #terminationExitObserved = false;
  #terminationEscalationComplete = false;
  /** Tail of the last chunk: an OSC sequence can split across PTY reads. */
  #sniffCarry = "";

  constructor(spec: RuntimeSpec, resources?: RuntimeResourceLease) {
    this.id = spec.id;
    this.spec = spec;
    this.#resources = resources ?? new RuntimeResourceBudget().createLease(spec.cols, spec.rows);
    this.#replay = new TerminalReplay(spec.cols, spec.rows, this.#resources);
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
    if (this.#pty || this.#terminating || this.#disposed) return;
    const pty = spawn(this.spec.file, this.spec.args, {
      name: "xterm-256color",
      cols: this.spec.cols,
      rows: this.spec.rows,
      cwd: this.spec.cwd,
      env: this.spec.env,
    });
    this.#processGroupIdentity = readProcessGroupIdentity(pty.pid);
    this.#pty = pty;
    this.#exit = null;
    this.startedAt = new Date();
    this.bytesOut = 0;
    pty.onData((data) => {
      let liveBytes = this.#dataSubs.size + this.#pendingDataSubscribers > 0
        ? Buffer.from(data, "utf8")
        : undefined;
      this.bytesOut += liveBytes?.byteLength ?? Buffer.byteLength(data);
      this.lastActivityAt = Date.now();
      const sniffed = sniffSessionFile(this.#sniffCarry, data);
      this.#sniffCarry = sniffed.carry;
      if (sniffed.sessionFile && sniffed.sessionFile !== this.sessionFile) {
        this.sessionFile = sniffed.sessionFile;
        for (const sub of this.#fileSubs) sub(this.sessionFile);
      }
      this.#replay.append(data, () => {
        const bytes = liveBytes;
        liveBytes = undefined;
        if (!bytes) return;
        for (const sub of this.#dataSubs) sub(bytes);
      });
    });
    pty.onExit((event) => {
      const exit = { exitCode: event.exitCode, signal: event.signal };
      this.#replay.append("", () => {
        this.#pty = null;
        this.#exit = exit;
        if (this.#terminationPromise) {
          this.#terminationExitObserved = true;
          this.#finishTermination();
        }
        try {
          for (const sub of this.#exitSubs) sub(exit);
        } finally {
          this.dispose();
        }
      });
    });
  }

  /** Snapshot and subscribe at the same parser boundary; no bytes can fall
   * between the captured screen and the live subscription. */
  subscribeOutput(
    replay: (data: string, info: RuntimeInfo) => void,
    data: (data: Uint8Array) => void,
  ): () => void {
    if (this.#disposed) return () => {};
    let cancelled = false;
    let waitingForSnapshot = true;
    this.#pendingDataSubscribers += 1;
    this.#replay.snapshot((snapshot) => {
      if (!waitingForSnapshot) return;
      waitingForSnapshot = false;
      this.#pendingDataSubscribers -= 1;
      if (cancelled || this.#disposed) return;
      replay(snapshot.data, { ...this.info(), cols: snapshot.cols, rows: snapshot.rows });
      if (!cancelled && !this.#disposed) this.#dataSubs.add(data);
    });
    return () => {
      cancelled = true;
      if (waitingForSnapshot) {
        waitingForSnapshot = false;
        if (!this.#disposed) this.#pendingDataSubscribers -= 1;
      }
      this.#dataSubs.delete(data);
    };
  }

  screenSnapshot(): Promise<RuntimeScreenSnapshot> {
    return this.#replay.screenSnapshot();
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
    if (this.#disposed) return;
    const pty = this.#pty;
    if ((!pty && cols === this.spec.cols && rows === this.spec.rows) ||
        (pty && cols === pty.cols && rows === pty.rows)) {
      return;
    }
    if (!this.#resources.setGeometry(cols, rows)) return;
    this.#replay.resize(cols, rows);
    if (!pty) {
      this.spec.cols = cols;
      this.spec.rows = rows;
      return;
    }
    pty.resize(cols, rows);
  }

  /** Release replay, image, snapshot, and subscriber ownership exactly once. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#replay.dispose();
    this.#resources.release();
    this.#pendingDataSubscribers = 0;
    this.#dataSubs.clear();
    this.#exitSubs.clear();
    this.#fileSubs.clear();
  }
  /**
   * Stop the PTY's dedicated process group. Keep the PTY reader open so its
   * onExit event can reap the direct child; bun-pty's kill() closes that reader
   * and synthesizes an exit event before the OS process is necessarily gone.
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.#terminationPromise) {
      if (signal === "SIGKILL" && !this.#terminationEscalationComplete) this.#escalateTermination();
      return this.#terminationPromise;
    }
    const pty = this.#pty;
    if (!pty) {
      this.#terminating = true;
      return Promise.resolve();
    }
    this.#terminating = true;
    const pid = pty.pid;
    this.#terminationEscalationComplete = signal === "SIGKILL";
    const { promise: termination, resolve } = Promise.withResolvers<void>();
    this.#resolveTermination = resolve;
    this.#terminationPromise = termination;

    // bun-pty starts the command in its own session, making its PID the
    // process-group ID. Signalling that group cleans up shell descendants
    // without searching for or signalling unrelated processes.
    // Verify the saved Linux PID identity before using its numeric PGID. If
    // /proc cannot prove it, terminate only through the PTY's bound child handle.
    const identity = this.#processGroupIdentity;
    if (identity === null || !processGroupIdentityMatches(identity) || !signalProcessGroup(pid, signal)) {
      this.#terminationEscalationComplete = true;
      this.#killPty(pty, signal);
      return termination;
    }
    if (signal !== "SIGKILL") {
      // Interactive Bash can ignore SIGTERM. Escalate while /proc still proves
      // the original process-group leader identity.
      this.#terminationTimer = setTimeout(() => this.#escalateTermination(), TERMINATION_GRACE_MS);
    }
    return termination;
  }

  #escalateTermination(): void {
    if (this.#terminationEscalationComplete) return;
    if (this.#terminationTimer !== null) {
      clearTimeout(this.#terminationTimer);
      this.#terminationTimer = null;
    }
    const identity = this.#processGroupIdentity;
    const pty = this.#pty;
    // The direct child may exit on SIGTERM while same-session descendants
    // survive it. A remaining group member preserves the original PGID; if the
    // leader PID already exists with a different identity, it has been reused.
    const groupSignalled =
      identity !== null && processGroupIdentityStillExists(identity) && signalProcessGroup(identity.pid, "SIGKILL");
    if (!groupSignalled && pty) this.#killPty(pty, "SIGKILL");
    this.#terminationEscalationComplete = true;
    this.#finishTermination();
  }

  #finishTermination(): void {
    if (!this.#terminationExitObserved || !this.#terminationEscalationComplete) return;
    const resolve = this.#resolveTermination;
    this.#resolveTermination = null;
    resolve?.();
  }

  #killPty(pty: IPty, signal: NodeJS.Signals): void {
    try {
      pty.kill(signal);
    } catch {
      if (this.#pty === pty) this.#pty = null;
      this.#terminationExitObserved = true;
      this.#finishTermination();
    }
  }

}

type LinuxProcessStat = { processGroup: number; session: number; startTime: string };

function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    // After comm: state is field 3, pgrp is 5, session is 6, starttime is 22.
    const processGroup = Number(fields[2]);
    const session = Number(fields[3]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(processGroup) || !Number.isSafeInteger(session) || !startTime) return null;
    return { processGroup, session, startTime };
  } catch {
    return null;
  }
}

function readProcessGroupIdentity(pid: number): ProcessGroupIdentity | null {
  const stat = readLinuxProcessStat(pid);
  if (stat === null || stat.processGroup !== pid || stat.session !== pid) return null;
  return { pid, startTime: stat.startTime };
}

function processGroupIdentityMatches(identity: ProcessGroupIdentity): boolean {
  const current = readLinuxProcessStat(identity.pid);
  return (
    current !== null &&
    current.processGroup === identity.pid &&
    current.session === identity.pid &&
    current.startTime === identity.startTime
  );
}

function processGroupIdentityStillExists(identity: ProcessGroupIdentity): boolean {
  const leader = readLinuxProcessStat(identity.pid);
  if (leader !== null) {
    return (
      leader.processGroup === identity.pid &&
      leader.session === identity.pid &&
      leader.startTime === identity.startTime
    );
  }
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const member = readLinuxProcessStat(Number(entry));
      if (member?.processGroup === identity.pid && member.session === identity.pid) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
