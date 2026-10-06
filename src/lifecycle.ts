/**
 * Pane binding lifecycle rules for the desktop client.
 *
 * A binding is the client's record of which runtime shows which transcript. It
 * has to survive two very different kinds of loss:
 *
 * - **the daemon restarted** (new generation): every runtime is gone, but panes
 *   that were live belong to their transcripts and must be reopened;
 * - **the runtime was stopped under a live daemon** (the sidebar kill button,
 *   another client, omp exiting): the session is deliberately not running, and
 *   a later start must not resurrect it.
 *
 * Runtime ids only identify a process inside one daemon generation, so the
 * persisted binding carries the generation it last ran under (`daemonGeneration`)
 * and an explicit resume claim (`autoResume`). These rules are DOM-free so the
 * client and its regression tests agree on the same decisions.
 */
import { isRecord } from "./guards";
import type { RuntimeInfo } from "./protocol";

export type PaneBinding = {
  runtimeId: string | null;
  title: string | null;
  sessionFile: string | null;
  /**
   * True while the pane claims its transcript should be running: set when it
   * binds to a live runtime, kept across a daemon restart, cleared by a
   * deliberate stop (kill button, pane emptied, omp exiting).
   */
  autoResume: boolean;
  /**
   * Daemon generation the binding last ran under. A runtime that vanished while
   * this same generation still answers was stopped on purpose; a different (or
   * unknown) generation means a restart, where the transcript is reopened.
   */
  daemonGeneration: string | null;
  /** Explicitly closed view: retain its placeholder instead of adopting a sidebar runtime. */
  keepEmpty?: true;
};

/** The state of a pane that has no runtime and no session. */
export function emptyBinding(): PaneBinding {
  return { runtimeId: null, title: null, sessionFile: null, autoResume: false, daemonGeneration: null };
}

/** A binding for a live runtime, claimed for automatic resume from now on. */
export function bindingForRuntime(runtime: RuntimeInfo, generation: string | null, title?: string): PaneBinding {
  return {
    runtimeId: runtime.id,
    title: title ?? runtime.title,
    sessionFile: runtime.sessionFile,
    autoResume: true,
    daemonGeneration: generation,
  };
}

/**
 * Parse a stored binding. Documents written before `autoResume` existed are
 * migrated by inference, because the old client cleared `runtimeId` both when a
 * runtime was stopped and when a daemon restart emptied the pool — the two are
 * indistinguishable in the old format. A retained transcript identity
 * (`sessionFile`) therefore keeps the resume claim: those are the panes the
 * update is expected to bring back, and a stop recorded after the update
 * (`autoResume: false`) is honoured forever.
 *
 * Irrecoverable in the old format: a pane that never sniffed a session file has
 * no transcript to reopen, and a pane the user stopped before the update may
 * resume once.
 */
export function bindingFromStored(entry: unknown): PaneBinding | null {
  if (!isRecord(entry)) return null;
  const runtimeId = typeof entry.runtimeId === "string" ? entry.runtimeId : null;
  const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : null;
  return {
    runtimeId,
    title: typeof entry.title === "string" ? entry.title : null,
    sessionFile,
    autoResume: entry.autoResume === true ||
      (entry.autoResume === undefined && (runtimeId !== null || sessionFile !== null)),
    daemonGeneration: typeof entry.daemonGeneration === "string" ? entry.daemonGeneration : null,
    ...(entry.keepEmpty === true && runtimeId === null && sessionFile === null ? { keepEmpty: true as const } : {}),
  };
}

/** What the client currently knows about the daemon answering it. */
export type DaemonView = { up: boolean; generation: string | null };

/**
 * A runtime a pane should still attach to. `alive` alone is not the question:
 * a runtime created without `resume` is reserved and starts its process on the
 * first attach (`Runtime.start` is idempotent), so `alive:false, pid:null,
 * status:"idle"` is a session waiting for a client, not a dead one. Only an
 * exited process is final — attaching would silently start the session again.
 */
export function attachable(runtime: RuntimeInfo): boolean {
  return runtime.alive || runtime.status !== "exited";
}

/**
 * The binding's resume claim after its runtime disappeared from the list. It is
 * kept only when the loss could be a daemon restart: an unreachable daemon, an
 * unknown generation on either side, or a generation change. A runtime that
 * vanished while its own daemon still answers was stopped on purpose.
 */
export function intentAfterRuntimeLoss(binding: PaneBinding, daemon: DaemonView): boolean {
  if (!binding.autoResume || !binding.sessionFile) return false;
  if (!daemon.up) return true;
  if (binding.daemonGeneration === null || daemon.generation === null) return true;
  return binding.daemonGeneration !== daemon.generation;
}

/**
 * The resume claim after the runtime announced its exit. A daemon-wide shutdown
 * is not the session ending: the pane comes back when the daemon does. An
 * ordinary exit (omp quit, crash, a kill that raced this page) ends the claim.
 */
export function intentAfterExit(binding: PaneBinding, daemonShutdown: boolean): boolean {
  return binding.autoResume && daemonShutdown;
}

export type PendingResume = {
  /** Transcript path to reopen. */
  sessionFile: string;
  /** An attachable runtime for this transcript, to adopt instead of spawning. */
  live: RuntimeInfo | null;
};

/**
 * Distinct transcripts that panes claim live but have no runtime for, in pane
 * order. Deduplicated so two panes showing one session reopen it once, and
 * paired with an existing runtime for it so restoration never duplicates a
 * process another pane (or another client) already has — including a reserved
 * runtime that has not been attached yet.
 */
export function pendingResumes(bindings: Iterable<PaneBinding>, runtimes: RuntimeInfo[]): PendingResume[] {
  const wanted = new Map<string, RuntimeInfo | null>();
  for (const binding of bindings) {
    const file = binding.sessionFile;
    if (!binding.autoResume || !file || binding.runtimeId !== null) continue;
    if (wanted.has(file)) continue;
    wanted.set(file, runtimes.find((runtime) => attachable(runtime) && runtime.sessionFile === file) ?? null);
  }
  return [...wanted].map(([sessionFile, live]) => ({ sessionFile, live }));
}
