import { isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { RuntimeManager, RuntimeCapacityError, PendingRuntimeCapacityError, type SpawnRequest } from "./manager";
import { listSessions, readSessionCwd } from "./sessions";
import { SessionTitleStore } from "./session-titles";
import { SessionArchiveStore } from "./session-archives";
import { isRecord } from "./guards";
import { MAX_RUNTIME_INPUT_CODE_UNITS, parseClientMessage, type RuntimeInfo, type RuntimesResponse, type ServerMessage } from "./protocol";
import { PresentationReader } from "./presentation";
import { STATE_LIMIT_BYTES, WorkspaceStateStore, RuntimeLedgerStore, type LiveSession } from "./state";
import {
  DaemonSettingsStore,
  isIdleTimeoutMinutes,
  isPositiveInteger,
  resolveMaxRuntimes,
  resolveIdleTimeoutMinutes,
  settingsPayload,
} from "./settings";
import { activeSystemdUnit } from "./systemd";
import type { Runtime } from "./runtime";
import { createWebAssets } from "./web-assets";
import { conditionalJson, readLimitedBytes, BodyLimitError } from "./http-response";
import { TerminalOutput } from "./terminal-output";
import { IMAGE_FILE_LIMIT, imageExtensionForMime } from "./image-limits";
import { PasteStore, PasteCapacityError } from "./paste-store";
import { renderSessionHistory } from "./session-history";
import { idleRequestTooLarge, IDLE_REQUEST_TOO_LARGE } from "./idle-limits";
import { IdleRuntimeClient, type IdleRuntimeStatus } from "./idle-ipc";

const HOST = process.env.OMP_DESKTOP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OMP_DESKTOP_PORT ?? 4180);
/**
 * Set when POST /api/restart started this process. Consume it before the
 * manager snapshots `process.env` for its children, and wait for the previous
 * daemon to release the port before serving (see waitForPreviousDaemon).
 */
const RESTART_PARENT = process.env.OMP_DESKTOP_RESTART_PARENT;
delete process.env.OMP_DESKTOP_RESTART_PARENT;
const ROOT = join(import.meta.dir, "..");
const OMP_BIN = process.env.OMP_DESKTOP_OMP ?? "omp";
const OMP_ARGS = (process.env.OMP_DESKTOP_OMP_ARGS ?? "").split(" ").filter((part) => part.length > 0);
const CWD = process.env.OMP_DESKTOP_CWD ?? process.env.HOME ?? process.cwd();
// No default overlay: the app runs omp exactly as the user's terminal does, so
// their own config (status glyphs, theme, model roles) applies unchanged. Set
// OMP_DESKTOP_OVERLAY to layer an extra config for experiments. The default used
// to force `symbolPreset: nerd`, which rewrote the status line with PUA icons the
// user never chose.
const OMP_OVERLAY = process.env.OMP_DESKTOP_OVERLAY ?? "";
const SESSIONS_DIR =
  process.env.OMP_DESKTOP_SESSIONS_DIR ?? join(process.env.HOME ?? "", ".omp/agent/sessions");
const SESSIONS_ROOT = resolve(SESSIONS_DIR);
const PASTE_DIR = process.env.OMP_DESKTOP_PASTE_DIR ?? join(tmpdir(), "omp-desktop-pastes");
const pasteStore = new PasteStore(PASTE_DIR);
// Durable workspace state (layout, pins, settings). The client caches it in
// browser storage and mirrors every change here, so a reboot, a cleared browser
// profile or a different port cannot lose the workspace description. Tests and
// secondary daemons must set OMP_DESKTOP_STATE_DIR (or _FILE) to stay off the
// user's real state file.
const STATE_DIR = resolve(
  process.env.OMP_DESKTOP_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local/state"), "omp-desktop"),
);
const STATE_FILE = process.env.OMP_DESKTOP_STATE_FILE ?? join(STATE_DIR, "state.json");
const stateStore = new WorkspaceStateStore(STATE_FILE);
const SESSION_TITLES_FILE =
  process.env.OMP_DESKTOP_SESSION_TITLES_FILE ?? join(STATE_DIR, "session-titles.json");
const sessionTitleStore = new SessionTitleStore(SESSION_TITLES_FILE);
const SESSION_ARCHIVES_FILE =
  process.env.OMP_DESKTOP_SESSION_ARCHIVES_FILE ?? join(STATE_DIR, "session-archives.json");
const sessionArchiveStore = new SessionArchiveStore(SESSION_ARCHIVES_FILE);
// Durable record of the live runtime pool, owned by the daemon (see state.ts):
// client documents describe panes, this describes the sessions themselves, so a
// restart restores every session that was live — including ones no pane holds.
const LEDGER_FILE = process.env.OMP_DESKTOP_LEDGER_FILE ?? join(STATE_DIR, "sessions.json");
const ledger = new RuntimeLedgerStore(LEDGER_FILE);
// The runtime limit is daemon-owned so it survives a browser-profile wipe, and
// so the pool (including ledger restore) is bounded before any client connects.
// A saved limit takes precedence over the deployment fallback; both must be
// positive integers. This process enforces EFFECTIVE_MAX_RUNTIMES for its whole
// life: a change through PUT /api/settings is persisted immediately but only
// takes effect after POST /api/restart, which is what `restartRequired` reports.
const SETTINGS_FILE = process.env.OMP_DESKTOP_SETTINGS_FILE ?? join(STATE_DIR, "settings.json");
const settingsStore = new DaemonSettingsStore(SETTINGS_FILE);
// A settings file that cannot be read must not keep the daemon (and the
// sessions it restores) down; fall back to the environment/default limit.
const savedSettings = await settingsStore.read().catch((error: unknown) => {
  console.warn(
    `omp-desktopd: could not read settings ${SETTINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { maxRuntimes: null, idleTimeoutMinutes: null, malformed: false };
});
if (savedSettings.malformed) {
  console.warn(`omp-desktopd: ignoring malformed settings file ${SETTINGS_FILE}`);
}
const initialLimit = resolveMaxRuntimes(savedSettings.maxRuntimes, process.env.OMP_DESKTOP_MAX_RUNTIMES);
const EFFECTIVE_MAX_RUNTIMES = initialLimit.maxRuntimes;
let desiredMaxRuntimes = initialLimit.maxRuntimes;
let idleTimeoutMinutes = resolveIdleTimeoutMinutes(
  savedSettings.idleTimeoutMinutes,
  process.env.OMP_DESKTOP_IDLE_TIMEOUT_MINUTES,
);
let customMaxRuntimes = savedSettings.maxRuntimes;
let customIdleTimeoutMinutes = savedSettings.idleTimeoutMinutes;
/** Partial setting writes must merge against the last committed snapshot. */
let settingsWrite = Promise.resolve();
// Empty OMP_DESKTOP_OVERLAY disables the overlay: non-omp binaries (smoke test's
// bash) reject unknown flags.
const OVERLAY_ARGS = OMP_OVERLAY ? ["--config", OMP_OVERLAY] : [];

/**
 * Mobile gateway integration. Every spawned omp gets the omp-mobile extension
 * (unless OMP_DESKTOP_EXTENSION is empty or missing) plus a per-runtime
 * `OMP_MOBILE_SLOT` env identity minted in RuntimeManager, so the phone talks
 * to the exact process it sees in the desktop sidebar through that runtime's
 * unix socket. The socket directory and IPC token default to the values the
 * mobile gateway itself uses, keeping the two services aligned without any
 * extra configuration.
 */
const MOBILE_IPC_DIR = resolve(
  process.env.OMP_MOBILE_IPC_DIR ?? join(process.env.HOME ?? "", ".local/state/omp-mobile"),
);
const MOBILE_TOKEN_FILE =
  process.env.OMP_MOBILE_TOKEN_FILE ?? join(process.env.HOME ?? "", ".config/zellij/ompbox-mobile.token");
const MOBILE_TOKEN = (() => {
  const explicit = process.env.OMP_MOBILE_IPC_TOKEN ?? process.env.OMP_MOBILE_TOKEN;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  try {
    const value = readFileSync(MOBILE_TOKEN_FILE, "utf8").trim();
    return value.length >= 16 && value.length <= 512 ? value : undefined;
  } catch {
    return undefined;
  }
})();
const EXTENSION_PATH = process.env.OMP_DESKTOP_EXTENSION ?? join(ROOT, "..", "omp-mobile", "extension.ts");
// The extension is optional at runtime: without it the panes still stream, and
// the phone degrades to terminal-only views for these runtimes.
const EXTENSION_ARGS = existsSync(EXTENSION_PATH) ? ["-e", EXTENSION_PATH] : [];
if (EXTENSION_ARGS.length === 0) {
  console.warn(`omp-desktop: omp-mobile extension not found at ${EXTENSION_PATH}; mobile structured state disabled`);
}
if (!MOBILE_TOKEN) {
  console.warn(
    `omp-desktop: no mobile IPC token at ${MOBILE_TOKEN_FILE}; spawned extensions read the file themselves and sockets stay 0600/owner-only, but set the token before spawning runtimes to require it on every call`,
  );
}

// Sidebar presentation (accent/working/done) comes from each runtime's injected
// extension over its own socket; failures are reported as unavailable, never
// inferred from the PTY byte heuristic. Reads are bounded and cached per
// runtime, so `/api/runtimes` (polled every 2.5s per tab) cannot stall on a
// wedged socket.
const presentationReader = new PresentationReader({ dir: MOBILE_IPC_DIR, token: MOBILE_TOKEN ?? null });
const IDLE_IPC_DIR = join(STATE_DIR, "idle");
const IDLE_IPC_TOKEN = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const idleClient = new IdleRuntimeClient({ dir: IDLE_IPC_DIR, token: IDLE_IPC_TOKEN, timeoutMs: 1500 });
const IDLE_EXTENSION = join(ROOT, "src", "idle-extension.ts");

const manager = new RuntimeManager({
  file: OMP_BIN,
  args: [...OVERLAY_ARGS, ...OMP_ARGS, ...EXTENSION_ARGS, "-e", IDLE_EXTENSION],
  cwd: CWD,
  cols: 120,
  rows: 32,
  maxRuntimes: EFFECTIVE_MAX_RUNTIMES,
  // Resume works in the directory recorded in the transcript, never the daemon's
  // launch dir (see RuntimeManager.#workingDirectory).
  readResumeCwd: readSessionCwd,
  env: {
    // process.env values are `string | undefined`; drop the undefined entries so the
    // child inherits exactly the defined parent environment.
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PI_FORCE_IMAGE_PROTOCOL: process.env.PI_FORCE_IMAGE_PROTOCOL ?? "iterm2",
    OMP_MOBILE_STATE_DIR: MOBILE_IPC_DIR,
    OMP_MOBILE_IPC_DIR: MOBILE_IPC_DIR,
    OMP_DESKTOP_IDLE_IPC_DIR: IDLE_IPC_DIR,
    OMP_DESKTOP_IDLE_IPC_TOKEN: IDLE_IPC_TOKEN,
    ...(MOBILE_TOKEN ? { OMP_MOBILE_IPC_TOKEN: MOBILE_TOKEN } : {}),
  },
});

const webAssets = await createWebAssets(ROOT);
const BUILD = webAssets.build;
const NO_STORE = { "cache-control": "no-store" };
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function trustedOrigins(port: number): Set<string> {
  const hosts = new Set(["127.0.0.1", "localhost"]);
  const configuredHost = HOST.toLowerCase().replace(/^\[|\]$/g, "");
  if (configuredHost === "localhost" || configuredHost === "::1" ||
      (isIP(configuredHost) === 4 && configuredHost.startsWith("127."))) {
    hosts.add(configuredHost);
  }
  return new Set([...hosts].map((host) =>
    new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`).origin,
  ));
}

/** Reject browser requests that do not originate from a trusted loopback daemon origin.
 *  Requests without browser provenance headers remain available to local tools. */
function sameOriginRequest(req: Request, requestUrl: URL, port: number): boolean {
  const allowedOrigins = trustedOrigins(port);
  if (!allowedOrigins.has(requestUrl.origin)) return false;
  const origin = req.headers.get("origin");
  if (origin !== null && (origin !== requestUrl.origin || !allowedOrigins.has(origin))) return false;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === null) return true;
  if (fetchSite === "none") return req.method === "GET" && allowedOrigins.has(requestUrl.origin);
  return fetchSite === "same-origin" && allowedOrigins.has(requestUrl.origin);
}


type WsData = {
  runtime?: Runtime;
  output?: TerminalOutput;
  unsubData?: () => void;
  unsubExit?: () => void;
  unsubReady?: () => void;
};


/** Resume is restricted to real session files under the store: the daemon runs
 *  whatever path it is handed as argv, and this endpoint is reachable from any
 *  page in the browser that can hit loopback. */
function validResume(path: string | undefined): string | null {
  if (!path || !isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const absolute = resolve(path);
  if (!absolute.startsWith(`${SESSIONS_ROOT}/`)) return null;
  try {
    const canonicalRoot = realpathSync(SESSIONS_ROOT);
    const canonicalFile = realpathSync(absolute);
    return canonicalFile.startsWith(`${canonicalRoot}/`) && statSync(canonicalFile).isFile() ? absolute : null;
  } catch {
    return null;
  }
}
type UnloadAttempt = { runtime: Runtime; done: Promise<void> };
const unloadingBySession = new Map<string, UnloadAttempt>();
const unloadingRuntimes = new Set<Runtime>();
const requestingSessions = new Map<string, number>();
let idleSweepTimer: Timer | null = null;
let idleSweepBusy = false;

class RuntimeUnavailableError extends Error {}
class SessionIdentityError extends Error {}
class ArchivedSessionError extends Error {}

async function waitForUnload(done: Promise<void>): Promise<void> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new RuntimeUnavailableError("session is still unloading; its transcript is safe to read")),
    15_000,
  );
  try {
    await Promise.race([done, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Requests serialize behind a graceful unload; reads never call this path. */
function createRequestedRuntime(request: SpawnRequest): Promise<Runtime> {
  const file = request.resume;
  if (!file) return allocateRequestedRuntime(request);
  return withSessionOperation(file, async () => {
    if ((await sessionArchiveStore.read()).includes(file)) {
      throw new ArchivedSessionError("archived sessions cannot be resumed");
    }
    return allocateRequestedRuntime(request);
  });
}

async function allocateRequestedRuntime(request: SpawnRequest): Promise<Runtime> {
  const file = request.resume;
  if (file) requestingSessions.set(file, (requestingSessions.get(file) ?? 0) + 1);
  try {
    const unloading = file ? unloadingBySession.get(file) : undefined;
    if (unloading) await waitForUnload(unloading.done);
    if (shuttingDown) throw new RuntimeUnavailableError("daemon shutting down");
    const runtime = await manager.create(
      request,
      desiredMaxRuntimes < EFFECTIVE_MAX_RUNTIMES ? { maxRuntimes: desiredMaxRuntimes } : {},
    );
    runtime.lastInputAt = Date.now();
    return runtime;
  } finally {
    if (file) {
      const remaining = (requestingSessions.get(file) ?? 1) - 1;
      if (remaining === 0) requestingSessions.delete(file);
      else requestingSessions.set(file, remaining);
    }
  }
}

async function waitForActivity(runtime: Runtime, expectedFile?: string): Promise<IdleRuntimeStatus> {
  const deadline = Date.now() + 15_000;
  while (runtime.alive && !shuttingDown && Date.now() < deadline) {
    const result = await idleClient.status(runtime.id);
    if (result.kind === "available") {
      if (result.status.unloading) throw new RuntimeUnavailableError("session is unloading; send again after it closes");
      const file = result.status.sessionFile;
      if (file !== null && file.length > 0) {
        if (expectedFile && file !== expectedFile) {
          throw new SessionIdentityError("the runtime opened a different transcript; the request was not sent");
        }
        if (runtime.ready) return result.status;
      }
    }
    await Bun.sleep(100);
  }
  if (!runtime.ready) {
    throw new RuntimeUnavailableError("terminal did not initialize before the startup timeout; the request was not sent");
  }
  throw new RuntimeUnavailableError(
    "session did not become ready (terminal frame, idle socket, and session file are required); the request was not sent",
  );
}

/**
 * Retire a fresh startup only when the runtime identity and host both prove it
 * is still unadmitted and idle. The host rechecks activity before shutdown.
 */
async function retireUnadmittedFreshRuntime(runtime: Runtime): Promise<void> {
  if (!runtime.alive || runtime.ready || manager.get(runtime.id) !== runtime) return;
  const sessionFile = runtime.sessionFile;
  if (!sessionFile || unloadingBySession.has(sessionFile) || requestingSessions.has(sessionFile)) return;
  const cleanupDeadline = Date.now() + 5_000;

  const settled = Promise.withResolvers<void>();
  const attempt = { runtime, done: settled.promise };
  unloadingBySession.set(sessionFile, attempt);
  unloadingRuntimes.add(runtime);
  let retainFenceUntilExit = false;
  let unloadAttempted = false;
  let cleanupFinished = false;
  let readyDuringCleanup = false;
  let unloadCancelled = false;
  const unloadAttemptId = crypto.randomUUID();
  let unsubscribeExit: (() => void) | undefined;
  let unsubscribeReady: (() => void) | undefined;
  let cancelPromise: Promise<boolean> | undefined;
  const releaseAttempt = () => {
    if (unloadingBySession.get(sessionFile) === attempt) unloadingBySession.delete(sessionFile);
    unloadingRuntimes.delete(runtime);
    unsubscribeExit?.();
    unsubscribeReady?.();
    settled.resolve();
  };
  const cancelAcceptedUnload = async (): Promise<boolean> => {
    const result = await idleClient.cancelUnload(runtime.id, { sessionFile, attemptId: unloadAttemptId });
    // A status read cannot prove cancellation of an in-flight unload. In
    // particular, waiting for one here can consume the host's shutdown grace.
    if (result.kind === "accepted") unloadCancelled = true;
    return result.kind === "accepted";
  };
  const onReady = (): void => {
    readyDuringCleanup = true;
    if (!unloadAttempted) return;
    cancelPromise = cancelAcceptedUnload();
    void cancelPromise.then((outcome) => {
      if (cleanupFinished && outcome && runtime.alive && manager.get(runtime.id) === runtime) {
        retainFenceUntilExit = false;
        releaseAttempt();
      }
    }).catch((error: unknown) => {
      console.warn(`omp-desktopd: ready runtime unload cancellation unavailable: ${String(error)}`);
    });
  };
  unsubscribeReady = runtime.subscribeReady(onReady);
  const keepFenceUntilExit = (): void => {
    if (!runtime.alive) return;
    retainFenceUntilExit = true;
    unsubscribeExit = runtime.subscribeExit(releaseAttempt);
    if (!runtime.alive) releaseAttempt();
  };
  try {
    const before = await idleClient.status(runtime.id);
    if (before.kind !== "available" || before.status.sessionFile !== sessionFile ||
        before.status.unloading || before.status.idleSince === null || before.status.reasons.length !== 0 ||
        !runtime.alive || runtime.ready || runtime.sessionFile !== sessionFile ||
        manager.get(runtime.id) !== runtime || requestingSessions.has(sessionFile) ||
        Date.now() >= cleanupDeadline || readyDuringCleanup) return;

    unloadAttempted = true;
    if (runtime.ready || readyDuringCleanup) return;
    const result = await idleClient.unload(runtime.id, { sessionFile, idleTimeoutMs: 1, attemptId: unloadAttemptId });
    if (runtime.ready || readyDuringCleanup) {
      let cancellation = cancelPromise ? await cancelPromise : false;
      if (!cancellation) cancellation = await cancelAcceptedUnload();
      if (!cancellation) {
        keepFenceUntilExit();
      }
      return;
    }
    let accepted = result.kind === "accepted";
    if (result.kind === "unavailable") {
      // A missing acknowledgement does not prove that the host rejected unload.
      const fresh = await idleClient.status(runtime.id);
      if (fresh.kind === "available" && fresh.status.sessionFile === sessionFile && fresh.status.unloading) {
        accepted = true;
      } else {
        const cancellation = await idleClient.cancelUnload(runtime.id, { sessionFile, attemptId: unloadAttemptId });
        if (cancellation.kind === "accepted") return;
        keepFenceUntilExit();
        return;
      }
    }
    if (!accepted) return;
    while (runtime.alive && !shuttingDown && Date.now() < cleanupDeadline) {
      if (runtime.ready || readyDuringCleanup) {
        let cancellation = cancelPromise ? await cancelPromise : false;
        if (!cancellation) cancellation = await cancelAcceptedUnload();
        if (!cancellation) keepFenceUntilExit();
        return;
      }
      const fresh = await idleClient.status(runtime.id);
      if (runtime.ready || readyDuringCleanup) continue;
      if (fresh.kind === "available") {
        if (fresh.status.sessionFile !== sessionFile) {
          keepFenceUntilExit();
          return;
        }
        if (!fresh.status.unloading) return;
      }
      if (Date.now() < cleanupDeadline) {
        await Bun.sleep(Math.min(250, cleanupDeadline - Date.now()));
      }
    }
    if (shuttingDown) return;
    if (runtime.alive) {
      // Shutdown was accepted but did not settle before the request deadline.
      // Keep prompts and terminal input fenced until the runtime exits.
      keepFenceUntilExit();
      return;
    }
    while (manager.get(runtime.id) === runtime && !shuttingDown && Date.now() < cleanupDeadline) {
      await Bun.sleep(25);
    }
    if (manager.get(runtime.id) === runtime) keepFenceUntilExit();
  } catch (error) {
    if (unloadAttempted) keepFenceUntilExit();
    console.warn(`omp-desktopd: unadmitted startup cleanup unavailable: ${String(error)}`);
  } finally {
    cleanupFinished = true;
    // Cancellation can finish before the final status read crosses its deadline.
    // Its callback cannot release the fence until cleanup has finished.
    if (unloadCancelled && runtime.alive && manager.get(runtime.id) === runtime) {
      retainFenceUntilExit = false;
    }
    // The manager can remove an alive runtime during the precheck or a rejected
    // unload. Keep queued resumes fenced until that runtime exits.
    if (!retainFenceUntilExit && runtime.alive && manager.get(runtime.id) !== runtime) {
      keepFenceUntilExit();
    }
    const retainFence = retainFenceUntilExit && runtime.alive;
    if (!retainFence && !shuttingDown && !runtime.alive && manager.get(runtime.id) !== runtime) {
      // Ledger reconciliation is best-effort persistence, not part of the HTTP
      // startup failure. A slow filesystem must not hold the request open.
      void (async () => {
        await ledgerWrite;
        const previousSessions = await ledger.read();
        if (shuttingDown) return;
        const preserveUnsettledSessions = restoringPool || exitSaveTimer !== null;
        const snapshot = new Map<string, LiveSession>();
        if (preserveUnsettledSessions) {
          for (const session of previousSessions) {
            if (session.sessionFile !== sessionFile) snapshot.set(session.sessionFile, session);
          }
        }
        // The input fence has been released: a newer runtime may now own this
        // same transcript. Reconcile against the current pool, not the retiree.
        for (const session of manager.liveSessions()) {
          snapshot.set(session.sessionFile, session);
        }
        writeLedger([...snapshot.values()]);
      })().catch((error: unknown) => {
        console.warn(`omp-desktopd: startup cleanup ledger reconciliation unavailable: ${String(error)}`);
      });
    }
    if (!retainFence) releaseAttempt();
  }
}


/** The host, not a cached status or terminal-byte heuristic, commits the shutdown. */
function beginIdleUnload(runtime: Runtime, file: string, timeoutMs: number): void {
  const settled = Promise.withResolvers<void>();
  const attempt = { runtime, done: settled.promise };
  unloadingBySession.set(file, attempt);
  unloadingRuntimes.add(runtime);
  void (async () => {
    const inputAt = runtime.lastInputAt ?? runtime.startedAt?.getTime() ?? Date.now();
    if (idleTimeoutMinutes * 60_000 !== timeoutMs ||
        Date.now() - inputAt < timeoutMs || requestingSessions.has(file)) return;
    const result = await idleClient.unload(runtime.id, { sessionFile: file, idleTimeoutMs: timeoutMs });
    let accepted = result.kind === "accepted";
    if (result.kind === "unavailable") {
      // A lost acknowledgement might conceal an accepted shutdown. Keep input
      // fenced until fresh host state proves rejection or the process exits.
      while (runtime.alive && !shuttingDown) {
        const fresh = await idleClient.status(runtime.id);
        if (fresh.kind === "available") {
          accepted = fresh.status.unloading;
          break;
        }
        await Bun.sleep(250);
      }
    }
    if (!accepted) return;
    while (runtime.alive && !shuttingDown) {
      const fresh = await idleClient.status(runtime.id);
      if (fresh.kind === "available" && !fresh.status.unloading) return;
      await Bun.sleep(250);
    }
    if (shuttingDown) return;
    if (exitSaveTimer !== null) {
      clearTimeout(exitSaveTimer);
      exitSaveTimer = null;
    }
    writeLedger();
    await ledgerWrite;
    console.log(`omp-desktopd unloaded idle session ${file}`);
  })().catch((error) => {
    console.warn(`omp-desktopd idle unload failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    if (unloadingBySession.get(file) === attempt) unloadingBySession.delete(file);
    unloadingRuntimes.delete(runtime);
    settled.resolve();
  });
}

async function sweepIdleRuntimes(): Promise<void> {
  if (idleSweepBusy || shuttingDown || idleTimeoutMinutes === 0) return;
  idleSweepBusy = true;
  const timeoutMs = idleTimeoutMinutes * 60_000;
  try {
    for (const info of manager.list()) {
      const runtime = manager.get(info.id);
      const file = runtime?.sessionFile;
      if (!runtime?.alive || !file || unloadingBySession.has(file) || requestingSessions.has(file)) continue;
      const inputAt = runtime.lastInputAt ?? runtime.startedAt?.getTime() ?? Date.now();
      if (Date.now() - inputAt < timeoutMs) continue;
      const state = await idleClient.status(runtime.id);
      if (shuttingDown || idleTimeoutMinutes * 60_000 !== timeoutMs) return;
      if (state.kind !== "available" || state.status.unloading || state.status.sessionFile !== file ||
          state.status.reasons.length !== 0 || state.status.idleSince === null ||
          Date.now() - state.status.idleSince < timeoutMs ||
          !runtime.alive || manager.get(runtime.id) !== runtime) continue;
      beginIdleUnload(runtime, file, timeoutMs);
    }
  } finally {
    idleSweepBusy = false;
  }
}

/**
 * Identity of this daemon process. Every runtime belongs to one generation, so
 * a reconnect that sees a different value knows the daemon restarted (all
 * runtimes are gone) rather than that its runtimes were stopped.
 */
const GENERATION = crypto.randomUUID();

let shuttingDown = false;
/** Set once POST /api/restart accepts; a second request must not spawn a second daemon. */
let restartScheduled = false;

/**
 * Start a replacement daemon process for `POST /api/restart` when this process
 * was not started by systemd. The child waits for this PID to disappear before
 * binding the port (see {@link waitForPreviousDaemon}), so it can be spawned
 * while the request is still being served.
 */
function spawnReplacement(): void {
  const script = process.argv.slice(1);
  if (script.length === 0) throw new Error("cannot determine the daemon entrypoint from process.argv");
  const child = Bun.spawn({
    cmd: [process.execPath, ...script],
    cwd: process.cwd(),
    env: { ...process.env, OMP_DESKTOP_RESTART_PARENT: String(process.pid) },
    stdin: "ignore",
    stdout: "inherit",
    // Keep startup failures and logs visible in the terminal that ran the old
    // daemon; the replacement otherwise runs independently.
    stderr: "inherit",
  });
  child.unref();
}

/**
 * A replacement daemon must not race the old one for the listening port. Wait
 * (bounded) for the recorded parent to exit; the ledger is already on disk, so
 * this delay never affects which sessions come back.
 */
async function waitForPreviousDaemon(): Promise<void> {
  if (!RESTART_PARENT) return;
  const pid = Number(RESTART_PARENT);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // ESRCH is the expected answer once the previous daemon has exited;
      // EPERM means it still exists (and we may not signal it).
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await Bun.sleep(25);
  }
  console.warn(`omp-desktopd: previous daemon ${pid} still appears to be running; starting anyway`);
}

/**
 * Accept a restart. The response is returned first; shutdown (standalone) or
 * `systemctl restart --no-block` (systemd) follows shortly after, so the
 * caller sees the accepted result before the daemon disappears.
 */
function beginRestart(): Response {
  console.log("omp-desktopd: restart requested");
  const unit = activeSystemdUnit();
  if (unit) {
    restartScheduled = true;
    setTimeout(() => {
      try {
        Bun.spawn({
          cmd: ["systemctl", "--user", "--no-block", "restart", unit],
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).unref();
        console.log(`omp-desktopd: restart delegated to systemctl --user restart ${unit}`);
      } catch (error) {
        restartScheduled = false;
        console.warn(
          `omp-desktopd: could not delegate restart to ${unit}: ${error instanceof Error ? error.message : String(error)}; this daemon keeps running`,
        );
      }
    }, 200);
    // A failed systemd job leaves this process alive but does not report back;
    // let the user try again rather than claim "restart in progress" forever.
    setTimeout(() => {
      if (shuttingDown) return;
      restartScheduled = false;
      console.warn(`omp-desktopd: ${unit} did not restart this daemon; a new restart can be requested`);
    }, 10_000);
    return new Response(
      `restarting omp-desktopd (${unit}); live sessions resume from the durable ledger`,
      { status: 202 },
    );
  }
  try {
    spawnReplacement();
  } catch (error) {
    return new Response(
      `restart failed: ${error instanceof Error ? error.message : String(error)}. The daemon is still running.`,
      { status: 500 },
    );
  }
  restartScheduled = true;
  setTimeout(() => shutdown(0), 200);
  return new Response("restarting omp-desktopd; live sessions resume from the durable ledger", {
    status: 202,
  });
}

// Serialize resume and archive through metadata reads, process start/stop and persistence.
const sessionOperations = new Map<string, Promise<unknown>>();
const archivedSessionPaths = new Set<string>();
async function stopSessionRuntimes(path: string): Promise<void> {
  await Promise.all(manager.list()
    .filter((runtime) => runtime.sessionFile === path)
    .map((runtime) => manager.kill(runtime.id)));
}
function withSessionOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionOperations.get(path) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  sessionOperations.set(path, result);
  void result.finally(() => {
    if (sessionOperations.get(path) === result) sessionOperations.delete(path);
  }).catch(() => {});
  return result;
}

await waitForPreviousDaemon();

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const websocketUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const listenPort = server.port;
    const apiRequest = url.pathname.startsWith("/api/");
    if ((apiRequest || MUTATING_METHODS.has(req.method) || websocketUpgrade) &&
        (listenPort === undefined || !sameOriginRequest(req, url, listenPort))) {
      return new Response("cross-origin request rejected", { status: 403 });
    }
    if (
      url.pathname === "/api/runtimes" ||
      url.pathname.startsWith("/api/runtimes/") ||
      url.pathname === "/api/settings" ||
      url.pathname === "/api/restart" ||
      url.pathname === "/api/sessions/request" ||
      url.pathname === "/api/sessions/archive" ||
      url.pathname === "/ws/term"
    ) {
      await poolReady;
      if (shuttingDown) return new Response("daemon shutting down", { status: 503 });
    }
    if (url.pathname === "/ws/term") {
      const runtime = manager.get(url.searchParams.get("runtime") ?? "");
      if (!runtime) return new Response("unknown runtime", { status: 404 });
      return srv.upgrade(req, { data: { runtime } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (!url.pathname.startsWith("/api/")) {
      const asset = await webAssets.response(req);
      if (asset) return asset;
    }
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/settings":
        return conditionalJson(req, settingsPayload(desiredMaxRuntimes, EFFECTIVE_MAX_RUNTIMES, idleTimeoutMinutes));
      case "PUT /api/settings": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body) || (body.maxRuntimes === undefined && body.idleTimeoutMinutes === undefined) ||
            (body.maxRuntimes !== undefined && !isPositiveInteger(body.maxRuntimes)) ||
            (body.idleTimeoutMinutes !== undefined && !isIdleTimeoutMinutes(body.idleTimeoutMinutes))) {
          return new Response(
            "settings require maxRuntimes as a positive integer and/or idleTimeoutMinutes as non-negative whole minutes (0 disables unloading)",
            { status: 400 },
          );
        }
        const previous = settingsWrite;
        const write = Promise.withResolvers<void>();
        settingsWrite = write.promise;
        await previous;
        try {
          const maxRuntimes = (body.maxRuntimes as number | undefined) ?? desiredMaxRuntimes;
          const nextIdleTimeout = (body.idleTimeoutMinutes as number | undefined) ?? idleTimeoutMinutes;
          const nextCustomMax = body.maxRuntimes === undefined ? customMaxRuntimes : maxRuntimes;
          const nextCustomIdle = body.idleTimeoutMinutes === undefined ? customIdleTimeoutMinutes : nextIdleTimeout;
          // A smaller restart pool must still fit every session it would restore.
          const live = manager.liveSessions().length;
          if (body.maxRuntimes !== undefined && maxRuntimes < live) {
            return new Response(
              `cannot set the runtime limit to ${maxRuntimes}: ${live} live session(s) would not fit after a restart. Stop sessions first or choose at least ${live}.`,
              { status: 400 },
            );
          }
          await settingsStore.save({ maxRuntimes: nextCustomMax, idleTimeoutMinutes: nextCustomIdle });
          customMaxRuntimes = nextCustomMax;
          customIdleTimeoutMinutes = nextCustomIdle;
          desiredMaxRuntimes = maxRuntimes;
          idleTimeoutMinutes = nextIdleTimeout;
          return Response.json(settingsPayload(desiredMaxRuntimes, EFFECTIVE_MAX_RUNTIMES, idleTimeoutMinutes), {
            headers: NO_STORE,
          });
        } catch (error) {
          return new Response(
            `settings save failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        } finally {
          write.resolve();
        }
      }
      case "POST /api/restart": {
        if (restartScheduled) {
          return new Response("restart already in progress", { status: 409 });
        }
        // Defense in depth: a restart restores at most the saved limit. Never
        // accept one that would leave live sessions behind.
        const live = manager.liveSessions().length;
        if (desiredMaxRuntimes < live) {
          return new Response(
            `cannot restart with a runtime limit of ${desiredMaxRuntimes}: ${live} live session(s) would not fit. Stop sessions first or raise the runtime limit in Settings.`,
            { status: 409 },
          );
        }
        return beginRestart();
      }
      case "GET /api/build":
        return conditionalJson(req, { build: BUILD });
      case "GET /api/state": {
        try {
          return conditionalJson(req, await stateStore.read());
        } catch (error) {
          return new Response(
            `state read failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
      }
      case "PUT /api/state": {
        if (req.headers.get("x-omp-generation") !== GENERATION) {
          return new Response("daemon generation changed; reconcile workspace before saving", { status: 409 });
        }
        let text: string;
        try {
          text = new TextDecoder().decode(await readLimitedBytes(req, STATE_LIMIT_BYTES));
        } catch (error) {
          if (error instanceof BodyLimitError) return new Response(error.message, { status: 413 });
          return new Response("could not read workspace body", { status: 400 });
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return new Response("state document must be JSON", { status: 400 });
        }
        // The client owns the layout shape; accept supported workspace versions.
        // The daemon never acts on the pane document.
        if (!isRecord(body) || (body.version !== 1 && body.version !== 2) || typeof body.savedAt !== "string") {
          return new Response("state document must be a version 1 or 2 workspace", { status: 400 });
        }
        try {
          return Response.json(
            { ok: true, path: STATE_FILE, ...(await stateStore.write(body)) },
            { headers: NO_STORE },
          );
        } catch (error) {
          return new Response(
            `state save failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
      }
      case "POST /api/paste": {
        // The browser owns the clipboard image; omp's TUI only reads text, so the
        // bytes land in a file and the pane types the path — what a terminal with
        // image paste does.
        const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        const ext = imageExtensionForMime(type);
        if (!ext) return new Response("unsupported image type", { status: 415 });
        let bytes: Uint8Array;
        try {
          bytes = await readLimitedBytes(req, IMAGE_FILE_LIMIT);
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "invalid image body", {
            status: error instanceof BodyLimitError ? 413 : 400,
          });
        }
        if (bytes.byteLength === 0) return new Response("empty body", { status: 400 });
        try {
          return Response.json({ path: await pasteStore.write(bytes, ext) }, { headers: NO_STORE });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "image upload failed", {
            status: error instanceof PasteCapacityError ? 507 : 500,
          });
        }
      }
      case "GET /api/runtimes": {
        // Enrich with extension state in parallel; each read has its own
        // deadline and returns null (unavailable) instead of failing the list.
        const listed = manager.list();
        presentationReader.retain(new Set(listed.map((info) => info.id)));
        const runtimes = await Promise.all(
          listed.map(async (info): Promise<RuntimeInfo> => ({
            ...info,
            presentation: info.alive ? await presentationReader.read(info.id) : null,
          })),
        );
        const body: RuntimesResponse = {
          build: BUILD,
          generation: GENERATION,
          runtimes,
          defaults: { cwd: manager.defaults.cwd, maxRuntimes: manager.defaults.maxRuntimes },
        };
        return conditionalJson(req, body);
      }
      case "POST /api/runtimes": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body)) return new Response("bad request", { status: 400 });
        const cwd = typeof body.cwd === "string" && existsSync(body.cwd) ? body.cwd : undefined;
        let resume: string | undefined;
        if (typeof body.resume === "string") {
          resume = validResume(body.resume) ?? undefined;
          if (!resume) {
            return new Response("resume must be an existing session file under the session store", { status: 400 });
          }
        }
        try {
          // A saved lower limit is pending until restart, while this process
          // still enforces the old, larger one. Do not let the pool grow past
          // the pending limit: otherwise a later restart would restore more
          // sessions than the saved limit allows and silently drop the excess.
          // The manager checks it at allocation time, after any async transcript
          // read, so concurrent requests cannot all pass a pre-check. Resuming a
          // transcript that is already live still reuses that process (and is
          // therefore allowed even at the limit).
          const runtime = await createRequestedRuntime({
            cwd,
            resume,
            cols: typeof body.cols === "number" ? body.cols : undefined,
            rows: typeof body.rows === "number" ? body.rows : undefined,
          });
          return Response.json({ runtime: runtime.info() }, { headers: NO_STORE });
        } catch (error) {
          if (error instanceof PendingRuntimeCapacityError) {
            const inUse = manager.allocated();
            return new Response(
              `session limit reached: ${inUse}/${error.limit} sessions are allowed by the saved limit that takes effect after restart. Stop a session or raise the runtime limit in Settings.`,
              { status: 409 },
            );
          }
          if (error instanceof RuntimeCapacityError) {
            const inUse = manager.list().length;
            return new Response(
              `session limit reached: ${inUse}/${manager.defaults.maxRuntimes} runtime slots are in use. Stop a session or raise the runtime limit in Settings, then apply it with Restart now.`,
              { status: 409 },
            );
          }
          if (error instanceof ArchivedSessionError) return new Response(error.message, { status: 400 });
          if (error instanceof RuntimeUnavailableError) return new Response(error.message, { status: 503 });
          throw error;
        }
      }
      case "POST /api/sessions/request": {
        const contentType = (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (contentType !== "application/json") {
          return new Response("session requests require application/json", { status: 415 });
        }
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(await readLimitedBytes(req, 128 * 1024)));
        } catch (error) {
          return new Response("invalid session request", { status: error instanceof BodyLimitError ? 413 : 400 });
        }
        if (!isRecord(body) || typeof body.text !== "string" || !body.text.trim()) {
          return new Response("a nonempty session request is required", { status: 400 });
        }
        if (body.files !== undefined && (!Array.isArray(body.files) ||
            body.files.some((path) => typeof path !== "string" || !path || /[\u0000-\u001f\u007f]/.test(path)))) {
          return new Response("invalid attachment paths", { status: 400 });
        }
        let resume: string | undefined;
        if (body.path !== undefined) {
          resume = typeof body.path === "string" ? validResume(body.path) ?? undefined : undefined;
          if (!resume) return new Response("request requires an existing transcript under the session store", { status: 400 });
        }
        let cwd: string | undefined;
        if (body.cwd !== undefined) {
          if (typeof body.cwd !== "string" || !isAbsolute(body.cwd)) {
            return new Response("cwd must be an absolute existing directory", { status: 400 });
          }
          try {
            if (!statSync(body.cwd).isDirectory()) {
              return new Response("cwd must be an absolute existing directory", { status: 400 });
            }
          } catch {
            return new Response("cwd must be an absolute existing directory", { status: 400 });
          }
          cwd = body.cwd;
        }
        // A fresh transcript path is only known after startup. The empty path is
        // a lower bound; prompt() checks the final envelope before opening IPC.
        if (idleRequestTooLarge({ sessionFile: resume ?? "", text: body.text, files: body.files })) {
          return new Response(IDLE_REQUEST_TOO_LARGE, { status: 413 });
        }
        let runtime: Runtime | undefined;
        let promptAttempted = false;
        try {
          runtime = await createRequestedRuntime({
            resume,
            cwd,
            cols: typeof body.cols === "number" ? body.cols : undefined,
            rows: typeof body.rows === "number" ? body.rows : undefined,
          });
          runtime.start();
          const ready = await waitForActivity(runtime, resume);
          const file = ready.sessionFile;
          if (file === null) throw new RuntimeUnavailableError("session has no transcript yet; the request was not sent");
          runtime.lastInputAt = Date.now();
          promptAttempted = true;
          const dispatched = await idleClient.prompt(runtime.id, {
            sessionFile: file, text: body.text, files: body.files as string[] | undefined,
          });
          if (dispatched.kind === "conflict" || dispatched.kind === "too_large") {
            if (!resume) {
              // A rejected fresh draft owns this new process, but another client
              // may have started work meanwhile. Let the SDK recheck quiescence;
              // never force-kill on rejection or an ambiguous acknowledgement.
              try {
                const status = await idleClient.status(runtime.id);
                if (status.kind === "available" && status.status.idleSince !== null && status.status.reasons.length === 0) {
                  const remaining = 1 - (Date.now() - status.status.idleSince);
                  if (remaining > 0) await Bun.sleep(remaining);
                }
                const retired = await idleClient.unload(runtime.id, { sessionFile: file, idleTimeoutMs: 1 });
                if (retired.kind === "accepted") {
                  const deadline = Date.now() + 2000;
                  while (runtime.alive && Date.now() < deadline) await Bun.sleep(25);
                }
              } catch (error) {
                console.warn(`omp-desktopd: rejected request cleanup unavailable: ${String(error)}`);
              }
            }
            return new Response(dispatched.reason, { status: dispatched.kind === "too_large" ? 413 : 409 });
          }
          if (dispatched.kind === "unavailable") {
            return new Response("request acknowledgement unavailable; it may have been queued. Check the session before sending again.", { status: 503 });
          }
          return Response.json({ runtime: runtime.info() }, { headers: NO_STORE });
        } catch (error) {
          if (runtime && !runtime.alive && manager.get(runtime.id) === runtime) await manager.kill(runtime.id);
          else if (runtime && !resume && !promptAttempted) await retireUnadmittedFreshRuntime(runtime);
          if (error instanceof ArchivedSessionError) return new Response(error.message, { status: 400 });
          if (error instanceof RuntimeCapacityError) {
            return new Response("session limit reached; stop a session or raise the runtime limit in Settings", { status: 409 });
          }
          if (error instanceof SessionIdentityError) return new Response(error.message, { status: 409 });
          return new Response(error instanceof Error ? error.message : "session request unavailable", { status: 503 });
        }
      }
      case "POST /api/sessions/title": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body) || typeof body.path !== "string" || typeof body.title !== "string") {
          return new Response("path and title must be strings", { status: 400 });
        }
        const path = validResume(body.path);
        if (!path) return new Response("path must be an existing session file under the session store", { status: 400 });
        const title = body.title.trim();
        if (!title) return new Response("title must be nonempty", { status: 400 });
        if (title.length > 1024) return new Response("title must contain at most 1024 characters", { status: 400 });
        try {
          await sessionTitleStore.save(path, title);
          return Response.json({ ok: true, path, title }, { headers: NO_STORE });
        } catch (error) {
          return new Response(
            `session title save failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
      }
      case "POST /api/sessions/archive": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body) || typeof body.path !== "string") {
          return new Response("path must be a string", { status: 400 });
        }
        const path = validResume(body.path);
        if (!path) return new Response("path must be an existing session file under the session store", { status: 400 });
        try {
          return await withSessionOperation(path, async () => {
            // Stop and reap before hiding controls, using Unload's lifecycle
            // path so the restart ledger also drops the runtime.
            await stopSessionRuntimes(path);
            await sessionArchiveStore.archive(path);
            archivedSessionPaths.add(path);
            // A fresh runtime may announce its transcript during the save.
            await stopSessionRuntimes(path);
            return Response.json({ ok: true, path }, { headers: NO_STORE });
          });
        } catch (error) {
          return new Response(
            `session archive save failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
      }
      case "GET /api/sessions": {
        // `listSessions` owns limit validation; archived entries are removed before search/limit.
        const archivedPaths = await sessionArchiveStore.read();
        const sessions = await listSessions({
          limit: Number(url.searchParams.get("limit") ?? 60),
          search: url.searchParams.get("search") ?? undefined,
          titleOverrides: await sessionTitleStore.read(),
          excludedPaths: new Set(archivedPaths),
        });
        return conditionalJson(req, { sessions, archivedPaths });
      }
      case "GET /api/sessions/history": {
        const file = validResume(url.searchParams.get("path") ?? undefined);
        if (!file) return new Response("history requires an existing transcript under the session store", { status: 400 });
        const cols = Number(url.searchParams.get("cols") ?? 120);
        const rows = Number(url.searchParams.get("rows") ?? 32);
        return renderSessionHistory({ file, cols, rows, omp: OMP_BIN, args: OMP_ARGS, signal: req.signal });
      }
      default:
        break;
    }
    const terminalMatch = /^\/api\/runtimes\/([A-Za-z0-9_-]+)\/(screen|input)$/.exec(url.pathname);
    if (terminalMatch) {
      const runtime = manager.get(terminalMatch[1]!);
      if (!runtime) return new Response("unknown runtime", { status: 404 });
      if (terminalMatch[2] === "screen" && req.method === "GET") {
        try {
          runtime.start();
        } catch (error) {
          await manager.kill(runtime.id);
          return new Response(error instanceof Error ? error.message : "runtime unavailable", { status: 503 });
        }
        try {
          return conditionalJson(req, await runtime.screenSnapshot());
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "terminal snapshot unavailable", { status: 503 });
        }
      }
      if (terminalMatch[2] === "input" && req.method === "POST") {
        if (!runtime.alive) return new Response("runtime is not running", { status: 409 });
        if (!runtime.ready) {
          return new Response("terminal is still starting; input was not accepted", { status: 503 });
        }
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(await readLimitedBytes(req, 128 * 1024)));
        } catch (error) {
          return new Response("invalid terminal input body", { status: error instanceof BodyLimitError ? 413 : 400 });
        }
        if (!isRecord(body) || typeof body.data !== "string" || body.data.length > MAX_RUNTIME_INPUT_CODE_UNITS) {
          return new Response(`terminal input must contain at most ${MAX_RUNTIME_INPUT_CODE_UNITS} characters`, { status: 400 });
        }
        if (!runtime.alive || unloadingRuntimes.has(runtime)) {
          return new Response("session is unloading; input was not accepted", { status: 409 });
        }
        runtime.write(body.data);
        return Response.json({ ok: true }, { headers: NO_STORE });
      }
      return new Response("method not allowed", { status: 405 });
    }
    const killMatch = /^\/api\/runtimes\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (killMatch && req.method === "DELETE") {
      return (await manager.kill(killMatch[1]))
        ? Response.json({ ok: true }, { headers: NO_STORE })
        : new Response("unknown runtime", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 128 * 1024,
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: true,
    open(ws) {
      const runtime = ws.data.runtime;
      if (!runtime) {
        ws.close();
        return;
      }
      try {
        runtime.start();
      } catch {
        void manager.kill(runtime.id);
        ws.close(1011, "Runtime could not start");
        return;
      }
      const output = ws.data.output = new TerminalOutput(ws);
      let helloSent = false;
      let readyBeforeHello = false;
      ws.data.unsubReady = runtime.subscribeReady(() => {
        if (!helloSent) {
          readyBeforeHello = true;
          return;
        }
        const message: ServerMessage = { type: "ready", runtime: runtime.info() };
        output.send(JSON.stringify(message));
      });
      ws.data.unsubData = runtime.subscribeOutput((replay, info) => {
        const hello: ServerMessage = {
          type: "hello",
          runtime: info,
          replayBytes: Buffer.byteLength(replay),
        };
        output.send(JSON.stringify(hello));
        if (replay.length > 0) output.replay(replay, hello.replayBytes);
        helloSent = true;
        if (readyBeforeHello && info.status === "starting") {
          const message: ServerMessage = { type: "ready", runtime: runtime.info() };
          output.send(JSON.stringify(message));
        }
        readyBeforeHello = false;
      }, (data) => output.send(data));
      ws.data.unsubExit = runtime.subscribeExit((exit) => {
        const message: ServerMessage = { type: "exit", exitCode: exit.exitCode, daemonShutdown: shuttingDown };
        output.send(JSON.stringify(message));
      });
    },
    async message(ws, raw) {
      const runtime = ws.data.runtime;
      if (!runtime || typeof raw !== "string") return;
      const msg = parseClientMessage(raw);
      if (!msg) return;
      if (msg.type === "input") {
        if (!runtime.ready) {
          ws.close(1013, "Runtime is still starting; input was not accepted");
          return;
        }
        const unloading = runtime.sessionFile ? unloadingBySession.get(runtime.sessionFile) : undefined;
        if (unloading?.runtime === runtime) await unloading.done;
        if (!runtime.alive || unloadingRuntimes.has(runtime) || manager.get(runtime.id) !== runtime) {
          ws.close(1012, "Session unloaded; unacknowledged input remains a draft");
          return;
        }
        runtime.write(msg.data);
        if (msg.id) {
          const ack: ServerMessage = { type: "inputAck", id: msg.id };
          ws.data.output?.send(JSON.stringify(ack));
        }
      } else if (msg.type === "terminalReply") {
        if (!runtime.alive || unloadingRuntimes.has(runtime) || manager.get(runtime.id) !== runtime) {
          ws.close(1012, "Session unavailable");
          return;
        }
        runtime.writeTerminalReply(msg.data);
      } else runtime.resize(msg.cols, msg.rows);
    },
    drain(ws) {
      ws.data.output?.drain();
    },
    close(ws) {
      ws.data.output?.dispose();
      ws.data.unsubData?.();
      ws.data.unsubExit?.();
      ws.data.unsubReady?.();
    },
  },
});

console.log(`omp-desktopd listening on http://${HOST}:${server.port}`);
console.log(`omp-desktopd workspace state: ${STATE_FILE}`);
console.log(`omp-desktopd runtime ledger: ${LEDGER_FILE}`);
console.log(`omp-desktopd settings: ${SETTINGS_FILE}`);
console.log(
  `omp-desktopd runtime limit: ${EFFECTIVE_MAX_RUNTIMES} (${
    initialLimit.source === "saved"
      ? "saved settings"
      : initialLimit.source === "env"
        ? "OMP_DESKTOP_MAX_RUNTIMES fallback"
        : "default"
  })`,
);

/**
 * Every pool change is a durable statement of what is running. The ledger is
 * rewritten from the live pool (not accumulated), so a runtime that is stopped
 * disappears from it at that moment and the next start does not bring its
 * session back.
 *
 * An *exit* is provisional, though: a process death carries no reason, and in
 * the case this ledger exists for — a unit teardown (systemctl stop/restart,
 * logout, reboot) SIGTERMs the daemon and its PTY children together — a child's
 * death is often processed before this process's own signal handler runs. A
 * snapshot wired straight to the exit event would then erase sessions that were
 * live a moment ago, which is exactly the "only some sessions came back" bug.
 * Exit-driven saves are therefore held back; if the daemon stays alive for the
 * settle window, the exit was an ordinary one (omp quit, crash) and is recorded
 * then. A start or a stop cancels the pending write, since their snapshot
 * already includes every exit so far.
 */
const EXIT_SETTLE_MS = 3000;
/** Handle of the pending exit-settle write; a start/stop/shutdown clears it. */
let exitSaveTimer: Timer | null = null;
let ledgerWrite: Promise<void> = Promise.resolve();
/**
 * True until the startup restore has settled the pool. While it is set, the
 * on-disk snapshot is still the only complete record of what must come back, so
 * pool-change saves are suppressed: writing a partial pool over it would drop
 * the sessions the restore had not reached yet.
 */
let restoringPool = true;

function writeLedger(sessions: LiveSession[] = manager.liveSessions()): void {
  ledgerWrite = ledger.save(sessions).catch((error) => {
    console.warn(`omp-desktopd: runtime ledger not saved: ${error instanceof Error ? error.message : String(error)}`);
  });
}

manager.subscribeChanges((change) => {
  if (change === "started") {
    // New sessions acquire their transcript identity asynchronously through PTY
    // output. Apply archive intent when that identity first becomes known.
    for (const runtime of manager.list()) {
      if (runtime.sessionFile && archivedSessionPaths.has(runtime.sessionFile)) {
        void manager.kill(runtime.id).catch((error) => {
          console.warn(`omp-desktopd: archived runtime cleanup failed: ${String(error)}`);
        });
      }
    }
  }
  if (shuttingDown || restoringPool) return;
  if (change === "exited") {
    exitSaveTimer ??= setTimeout(() => {
      exitSaveTimer = null;
      writeLedger();
    }, EXIT_SETTLE_MS);
    return;
  }
  if (exitSaveTimer !== null) {
    clearTimeout(exitSaveTimer);
    exitSaveTimer = null;
  }
  writeLedger();
});

/**
 * Bring back the pool a previous daemon left behind. Sessions are restored by
 * the daemon, before and independently of any client: the pool outlives panes
 * and windows, so a session with no pane bound (or no app open at all) comes
 * back exactly like a visible one. Explicit stops and ordinary exits already
 * dropped their ledger entry, so nothing stopped is resurrected. Replays whose
 * transcript no longer exists — or that no longer fit under the runtime limit —
 * are logged and forgotten; their data is still on disk.
 *
 * Until this finishes, the on-disk snapshot is still the only complete record of
 * what must come back, so pool changes are not written through: a daemon that
 * dies mid-restore retries the whole pool instead of only the sessions it had
 * reached when its partial pool was saved over the record.
 */
async function restorePool(): Promise<void> {
  try {
    for (const path of await sessionArchiveStore.read()) archivedSessionPaths.add(path);
    const records = await ledger.read();
    if (records.length === 0) return;
    // Older versions archived without stopping, and a crash can leave a stale
    // ledger. Persistent archive intent wins over either runtime snapshot.
    let restored = 0;
    for (const record of records) {
      if (shuttingDown) break;
      if (archivedSessionPaths.has(record.sessionFile)) continue;
      const resume = validResume(record.sessionFile);
      if (!resume) {
        console.warn(`omp-desktopd: not restoring ${record.sessionFile}: no such transcript under ${SESSIONS_ROOT}`);
        continue;
      }
      try {
        const runtime = await manager.create({ resume, cwd: record.cwd, cols: record.cols, rows: record.rows });
        if (shuttingDown) {
          runtime.kill();
          break;
        }
        restored += 1;
        console.log(`omp-desktopd restored session ${resume} as ${runtime.id}`);
      } catch (error) {
        console.warn(
          `omp-desktopd: could not restore ${record.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (restored > 0) console.log(`omp-desktopd pool restored: ${restored} session(s)`);
  } finally {
    restoringPool = false;
  }
  // The ledger now describes this daemon's pool (including anything clients
  // started while the restore ran), so stale entries do not retry forever.
  if (!shuttingDown) writeLedger();
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  // Freeze the durable record first: the snapshot on disk describes the pool
  // this daemon owned, and the SIGTERMs below are this teardown killing it, not
  // the sessions ending. A pending exit save is a child death that the same
  // teardown caused, so it must not land either.
  shuttingDown = true;
  if (idleSweepTimer !== null) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  if (exitSaveTimer !== null) {
    clearTimeout(exitSaveTimer);
    exitSaveTimer = null;
  }
  const childrenStopped = manager.killAll();
  server.stop(true);
  // Wait for the ledger and PTY exit/reaping (including bounded escalation).
  // A wedged filesystem or child must not hang daemon shutdown indefinitely.
  void Promise.race([
    Promise.all([ledgerWrite, childrenStopped]),
    Bun.sleep(1000),
  ]).then(() => setTimeout(() => process.exit(code), 100));
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => { void manager.killAll("SIGKILL"); });

const poolReady = restorePool();
void poolReady.then(() => {
  if (shuttingDown) return;
  idleSweepTimer = setInterval(() => {
    void sweepIdleRuntimes().catch((error) => {
      console.warn(`omp-desktopd idle sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000);
  idleSweepTimer.unref();
});
