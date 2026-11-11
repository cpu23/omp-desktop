import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  asyncJobBlockers,
  backgroundServiceBlockers,
  IdleActivityState,
  isRuntimeId,
  namedBashServicesInBranch,
  subagentBlockers,
  type IdleHostObservation,
  type IdleRuntimeStatus,
  type NamedBashService,
} from "./idle-state";
import { IMAGE_FILE_LIMIT, imageExtensionForMime } from "./image-limits";
import { MAX_IDLE_REQUEST_BYTES } from "./idle-limits";

const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SHUTDOWN_DELAY_MS = 150;
const SERVICE_REFRESH_MS = 60_000;
const SERVICE_REGISTRY_TIMEOUT_MS = 1_500;
const MAX_SERVICE_REGISTRY_BYTES = 256 * 1024;
const ACTIVITY_POLL_MS = 1_000;
const DIALOG_UI_METHODS = ["approve", "askDialog", "confirm", "custom", "editor", "input", "select"] as const;

type HostSessionManager = {
  getSessionFile?: () => unknown;
  getSessionId?: () => unknown;
  getBranch?: () => unknown;
  getLeafId?: () => unknown;
};

type HostUi = {
  getEditorText?: () => unknown;
  [key: string]: unknown;
};

type HostContext = {
  cwd?: unknown;
  hasUI?: unknown;
  isIdle?: () => unknown;
  hasPendingMessages?: () => unknown;
  getAsyncJobSnapshot?: () => unknown;
  getPendingPlanReview?: () => unknown;
  setInterval?: (callback: () => void, ms: number) => unknown;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  shutdown?: () => unknown;
  sessionManager?: HostSessionManager;
  ui?: HostUi;
};

type AgentRef = {
  id?: unknown;
  parentId?: unknown;
  kind?: unknown;
  status?: unknown;
  session?: unknown;
  sessionFile?: unknown;
};

type AgentRegistry = { list?: () => unknown };

type HostApi = {
  on: (event: string, handler: (event: unknown, ctx?: unknown) => void) => void;
  pi?: { AgentRegistry?: { global?: () => AgentRegistry } };
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
};

type SocketServer = { stop(closeActiveConnections?: boolean): void };
type SocketIdentity = { dev: number; ino: number };
type RegistryCache = { at: number; key: string; reasons: string[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmptyText(value: unknown): value is string {
  return text(value) && value.length > 0;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function sessionFileOf(ctx: HostContext): string | null {
  try {
    const value = ctx.sessionManager?.getSessionFile?.();
    return nonEmptyText(value) ? value : null;
  } catch {
    return null;
  }
}

function sessionIdOf(ctx: HostContext): string | null {
  try {
    const value = ctx.sessionManager?.getSessionId?.();
    return nonEmptyText(value) ? value : null;
  } catch {
    return null;
  }
}

function agentSessionMatches(ref: AgentRef, sessionFile: string | null, sessionId: string | null): boolean {
  const session = record(ref.session);
  const manager = record(session?.sessionManager);
  const sessionManagerId = manager?.getSessionId;
  const sessionManagerFile = manager?.getSessionFile;
  try {
    if (
      nonEmptyText(sessionFile) &&
      (ref.sessionFile === sessionFile || (typeof sessionManagerFile === "function" && sessionManagerFile.call(manager) === sessionFile))
    ) {
      return true;
    }
    return sessionId !== null &&
      ((typeof sessionManagerId === "function" && sessionManagerId.call(manager) === sessionId) || session?.sessionId === sessionId);
  } catch {
    return false;
  }
}

function eventArguments(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolCall = record(event.toolCall);
  return parseArguments(event.args ?? event.arguments ?? event.input ?? toolCall?.arguments);
}

function serviceReferenceFromEvent(event: unknown, ctx: HostContext): NamedBashService | undefined {
  const input = record(event);
  if (!input || input.toolName !== "bash") return undefined;
  const args = eventArguments(input);
  if (!args || !nonEmptyText(args.name)) return undefined;
  const cwd = nonEmptyText(args.cwd)
    ? isAbsolute(args.cwd) ? resolve(args.cwd) : resolve(text(ctx.cwd) ? ctx.cwd : process.cwd(), args.cwd)
    : text(ctx.cwd) ? resolve(ctx.cwd) : null;
  return { name: args.name, cwd };
}

function claimSocketOwnership(path: string, hostId: string): boolean {
  const ownerPath = `${path}.owner`;
  const ownerContent = `${JSON.stringify({ pid: process.pid, hostId })}\n`;
  const writeOwner = (): boolean => {
    try {
      writeFileSync(ownerPath, ownerContent, { encoding: "utf8", mode: SOCKET_MODE, flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (writeOwner()) return true;

  let current: { pid?: unknown; hostId?: unknown };
  try {
    const ownerStat = lstatSync(ownerPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!ownerStat.isFile() || (uid !== undefined && ownerStat.uid !== uid) || (ownerStat.mode & 0o077) !== 0) return false;
    const parsed: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
    const value = record(parsed);
    if (!value) return false;
    current = { pid: value.pid, hostId: value.hostId };
  } catch {
    return false;
  }
  if (current.hostId === hostId || typeof current.pid !== "number" || !Number.isSafeInteger(current.pid) || current.pid <= 0) {
    return false;
  }
  try {
    process.kill(current.pid, 0);
    return false;
  } catch (error) {
    if (record(error)?.code !== "ESRCH") return false;
  }
  try {
    const stat = lstatSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) return false;
    unlinkSync(path);
  } catch (error) {
    if (record(error)?.code !== "ENOENT") return false;
  }
  try {
    unlinkSync(ownerPath);
  } catch {
    return false;
  }
  return writeOwner();
}

function releaseSocketOwnership(path: string, hostId: string, identity: SocketIdentity | undefined): void {
  const ownerPath = `${path}.owner`;
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (record(parsed)?.hostId !== hostId) return;
    removeOwnedSocket(path, identity);
    unlinkSync(ownerPath);
  } catch {
    // Never unlink a socket whose owner record cannot be proven.
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readJsonBody(request: Request): Promise<{ value?: unknown; error?: "too_large" | "invalid_json" }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_IDLE_REQUEST_BYTES) {
    return { error: "too_large" };
  }
  if (!request.body) return { error: "invalid_json" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IDLE_REQUEST_BYTES) {
        await reader.cancel();
        return { error: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "invalid_json" };
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { error: "invalid_json" };
  }
}

function sameToken(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function identityOf(stat: { dev: number; ino: number }): SocketIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function removeOwnedSocket(path: string, identity: SocketIdentity | undefined): void {
  if (!identity) return;
  try {
    const stat = lstatSync(path);
    if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) unlinkSync(path);
  } catch {
    // Already removed during host shutdown.
  }
}

function serviceRefsSignature(refs: readonly NamedBashService[]): string {
  return JSON.stringify(refs.map((ref) => [ref.name, ref.cwd]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

type PromptImage = { type: "image"; mimeType: string; data: string };

export async function readPromptImages(paths: string[]): Promise<PromptImage[]> {
  const images: PromptImage[] = [];
  const imagePaths = [...new Set(paths)].filter((path) => imageExtensionForMime(Bun.file(path).type));
  if (imagePaths.length > 16) throw new Error("A request may include at most 16 image attachments");
  let totalBytes = 0;
  for (const path of imagePaths) {
    const mimeType = Bun.file(path).type;
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > IMAGE_FILE_LIMIT) {
        throw new Error("Image attachments must be regular files of at most 32 MiB");
      }
      totalBytes += stat.size;
      if (totalBytes > IMAGE_FILE_LIMIT) throw new Error("Image attachments must fit within 32 MiB total per request");
      const bytes = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error("Image attachment changed while reading");
        offset += read.bytesRead;
      }
      images.push({ type: "image", mimeType, data: bytes.toString("base64") });
    } finally {
      await handle.close();
    }
  }
  return images;
}

export default function registerDesktopIdleExtension(host: HostApi): void {
  const runtimeId = process.env.OMP_MOBILE_SLOT ?? "";
  const dir = process.env.OMP_DESKTOP_IDLE_IPC_DIR ?? "";
  const token = process.env.OMP_DESKTOP_IDLE_IPC_TOKEN ?? "";
  const state = new IdleActivityState(randomUUID());
  const pendingApprovals = new Set<string>();
  const activeTools = new Set<string>();
  const activeWork = new Set<string>();
  const serviceRefs = new Map<string, NamedBashService>();
  const runningServiceCalls = new Map<string, NamedBashService>();
  let currentContext: HostContext | undefined;
  let server: SocketServer | undefined;
  let socketPath: string | undefined;
  let socketIdentity: SocketIdentity | undefined;
  let pollHandle: unknown;
  let pendingUnloadTimer: { sessionFile: string; attemptId: string | undefined; context: HostContext; handle: unknown } | undefined;
  const unloadAttempts = new Map<string, "pending" | "cancelled">();
  let branchSessionKey: string | null = null;
  let branchBlockers: string[] = ["session_branch_unavailable"];
  let registryCache: RegistryCache | undefined;
  const pendingDialogs = new Set<string>();
  const trackedUiMethods = new WeakSet<(...args: unknown[]) => unknown>();
  let interactionTrackingUnavailable = false;

  const logError = (message: string): void => host.logger?.error?.(`OMP desktop idle IPC: ${message}`);
  const logInfo = (message: string): void => host.logger?.info?.(`OMP desktop idle IPC: ${message}`);

  function trackUiInteractions(ctx: HostContext): void {
    if (ctx.hasUI !== true) return;
    const ui = ctx.ui;
    if (!ui || typeof ui !== "object") {
      interactionTrackingUnavailable = true;
      return;
    }
    for (const name of DIALOG_UI_METHODS) {
      const descriptor = Object.getOwnPropertyDescriptor(ui, name);
      const current: unknown = descriptor?.value;
      if (typeof current !== "function" || descriptor?.writable !== true) {
        interactionTrackingUnavailable = true;
        continue;
      }
      const original = current as (...args: unknown[]) => unknown;
      if (trackedUiMethods.has(original)) continue;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const result = Reflect.apply(original, this, args);
        try {
          if (
            result !== null && (typeof result === "object" || typeof result === "function") &&
            typeof (result as PromiseLike<unknown>).then === "function"
          ) {
            const id = randomUUID();
            pendingDialogs.add(id);
            state.noteActivity();
            return Promise.resolve(result).finally(() => {
              pendingDialogs.delete(id);
              state.noteActivity();
            });
          }
        } catch {
          interactionTrackingUnavailable = true;
          state.noteActivity();
        }
        return result;
      };
      try {
        // Handler UI proxies override reads; descriptors address their shared backing UI.
        Object.defineProperty(ui, name, { ...descriptor, value: wrapped });
        if (Object.getOwnPropertyDescriptor(ui, name)?.value !== wrapped) interactionTrackingUnavailable = true;
        else trackedUiMethods.add(wrapped);
      } catch {
        interactionTrackingUnavailable = true;
      }
    }
  }

  function addServiceReference(ref: NamedBashService): void {
    const cwd = ref.cwd && isAbsolute(ref.cwd) ? resolve(ref.cwd) : null;
    const normalized = { name: ref.name, cwd };
    if (cwd) {
      serviceRefs.delete(`${ref.name}\0`);
    } else if ([...serviceRefs.values()].some((item) => item.name === ref.name && item.cwd !== null)) {
      return;
    }
    const key = `${ref.name}\0${cwd ?? ""}`;
    if (serviceRefs.has(key)) return;
    serviceRefs.set(key, normalized);
    registryCache = undefined;
  }

  function refreshBranchEvidence(ctx: HostContext, sessionFile: string | null, sessionId: string | null): string[] {
    const sessionKey = `${sessionFile ?? ""}\0${sessionId ?? ""}`;
    if (branchSessionKey === sessionKey) return branchBlockers;
    const manager = ctx.sessionManager;
    if (typeof manager?.getBranch !== "function") return ["session_branch_unavailable"];
    let branch: unknown;
    try {
      branch = manager.getBranch();
    } catch {
      return ["session_branch_unavailable"];
    }
    if (!Array.isArray(branch)) return ["session_branch_unknown"];
    const refs = namedBashServicesInBranch(branch);
    if (!refs) return ["session_branch_unknown"];
    for (const ref of refs) addServiceReference(ref);
    branchSessionKey = sessionKey;
    branchBlockers = [];
    return branchBlockers;
  }

  function ownedSession(ctx: HostContext): Record<string, unknown> | undefined {
    try {
      const refs = host.pi?.AgentRegistry?.global?.().list?.();
      if (!Array.isArray(refs)) return;
      let found: Record<string, unknown> | undefined;
      let matched = false;
      for (const raw of refs) {
        const ref = record(raw) as AgentRef | undefined;
        if (ref?.kind !== "main" || !agentSessionMatches(ref, sessionFileOf(ctx), sessionIdOf(ctx))) continue;
        if (matched) return;
        matched = true;
        found = record(ref.session);
      }
      return found;
    } catch {
      return;
    }
  }

  function serviceRegistryReasons(ctx: HostContext, force: boolean): string[] {
    const refs = [...serviceRefs.values()];
    if (refs.length === 0) return [];
    const now = Date.now();
    const key = serviceRefsSignature(refs);
    if (!force && registryCache?.key === key && now - registryCache.at < SERVICE_REFRESH_MS) {
      return registryCache.reasons;
    }
    const cwd = text(ctx.cwd) && isAbsolute(ctx.cwd) ? ctx.cwd : process.cwd();
    const ompBin = process.env.OMP_DESKTOP_OMP ?? "omp";
    const ompArgs = (process.env.OMP_DESKTOP_OMP_ARGS ?? "").split(" ").filter((part) => part.length > 0);
    const result = spawnSync(ompBin, [...ompArgs, "ps", "list", "--json", "--all"], {
      cwd,
      encoding: "utf8",
      timeout: SERVICE_REGISTRY_TIMEOUT_MS,
      maxBuffer: MAX_SERVICE_REGISTRY_BYTES,
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    let reasons: string[];
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      reasons = ["service_registry_unavailable"];
    } else {
      try {
        reasons = backgroundServiceBlockers(JSON.parse(result.stdout) as unknown, refs);
      } catch {
        reasons = ["service_registry_unknown"];
      }
    }
    registryCache = { at: now, key, reasons };
    return reasons;
  }

  function observeHost(ctx: HostContext, forceServiceRefresh = false): IdleHostObservation {
    const reasons = new Set<string>();
    const sessionFile = sessionFileOf(ctx);
    const sessionId = sessionIdOf(ctx);
    if (!sessionFile) reasons.add("session_file_unavailable");
    if (!sessionId) reasons.add("session_id_unavailable");
    if (typeof ctx.isIdle !== "function") reasons.add("idle_state_unavailable");
    else {
      try {
        if (ctx.isIdle() !== true) reasons.add("agent_active");
      } catch {
        reasons.add("idle_state_unknown");
      }
    }
    if (typeof ctx.hasPendingMessages !== "function") reasons.add("pending_message_state_unavailable");
    else {
      try {
        if (ctx.hasPendingMessages() !== false) reasons.add("pending_messages");
      } catch {
        reasons.add("pending_message_state_unknown");
      }
    }
    if (typeof ctx.getAsyncJobSnapshot !== "function") reasons.add("async_job_state_unavailable");
    else {
      try {
        for (const reason of asyncJobBlockers(ctx.getAsyncJobSnapshot())) reasons.add(reason);
      } catch {
        reasons.add("async_job_state_unknown");
      }
    }

    const module = host.pi;
    const registryCtor = module?.AgentRegistry;
    if (typeof registryCtor?.global !== "function") reasons.add("agent_registry_unavailable");
    else {
      try {
        const registry = registryCtor.global();
        const refs = registry?.list?.();
        if (!Array.isArray(refs)) reasons.add("agent_registry_unknown");
        else {
          const mainIds = new Set<string>();
          const knownIds = new Set<string>();
          for (const raw of refs) {
            const ref = record(raw) as AgentRef | undefined;
            if (!ref || typeof ref.kind !== "string" || typeof ref.status !== "string" || !nonEmptyText(ref.id)) {
              reasons.add("agent_registry_unknown");
              continue;
            }
            knownIds.add(ref.id);
            if (ref.kind === "main" && agentSessionMatches(ref, sessionFile, sessionId)) {
              mainIds.add(ref.id);
              const session = record(ref.session);
              if (typeof session?.hasAdmittedSubmission !== "boolean") reasons.add("submission_state_unavailable");
              else if (session.hasAdmittedSubmission) reasons.add("submission_pending");
              const hasAsync = session?.hasPendingAsyncWork;
              if (typeof hasAsync !== "function") reasons.add("async_work_state_unavailable");
              else if (hasAsync.call(session) !== false) reasons.add("async_work_pending");
            }
          }
          if (mainIds.size === 0) reasons.add("agent_registry_session_unknown");
          const ownedIds = new Set(mainIds);
          let ownershipChanged = true;
          while (ownershipChanged) {
            ownershipChanged = false;
            for (const raw of refs) {
              const ref = record(raw) as AgentRef | undefined;
              if (!ref || ref.kind !== "sub") continue;
              const parentOwned = nonEmptyText(ref.parentId) && ownedIds.has(ref.parentId);
              const sessionOwned = agentSessionMatches(ref, sessionFile, sessionId);
              if (!parentOwned && !sessionOwned) continue;
              if (nonEmptyText(ref.id) && !ownedIds.has(ref.id)) {
                ownedIds.add(ref.id);
                ownershipChanged = true;
              }
            }
          }
          for (const raw of refs) {
            const ref = record(raw) as AgentRef | undefined;
            if (ref?.kind !== "sub") continue;
            const blockers = subagentBlockers(ref);
            if (blockers.length === 0) continue;
            if (ownedIds.has(ref.id as string) || agentSessionMatches(ref, sessionFile, sessionId)) {
              for (const reason of blockers) reasons.add(reason);
              continue;
            }
            const parentKnown = nonEmptyText(ref.parentId) && knownIds.has(ref.parentId);
            if (!ownedIds.has(ref.id as string) && !agentSessionMatches(ref, sessionFile, sessionId) && !parentKnown) {
              reasons.add("subagent_ownership_unknown");
            }
          }
        }
      } catch {
        reasons.add("agent_registry_unknown");
      }
    }

    if (typeof ctx.getPendingPlanReview !== "function") reasons.add("interaction_state_unavailable");
    else {
      try {
        const plan = ctx.getPendingPlanReview();
        if (plan !== undefined && plan !== null) reasons.add("plan_review_pending");
      } catch {
        reasons.add("interaction_state_unknown");
      }
    }
    if (pendingApprovals.size > 0) reasons.add("tool_approval_pending");
    if (activeTools.size > 0) reasons.add("tool_execution_active");
    for (const work of activeWork) reasons.add(`${work}_active`);
    if (pendingDialogs.size > 0) reasons.add("dialog_pending");
    if (interactionTrackingUnavailable) reasons.add("dialog_tracking_unavailable");

    if (ctx.hasUI === true) {
      if (typeof ctx.ui?.getEditorText !== "function") reasons.add("draft_state_unavailable");
      else {
        try {
          const draft = ctx.ui.getEditorText();
          if (typeof draft !== "string") reasons.add("draft_state_unknown");
          else if (draft.length > 0) reasons.add("draft_present");
        } catch {
          reasons.add("draft_state_unknown");
        }
      }
    } else if (ctx.hasUI !== false) {
      reasons.add("ui_state_unknown");
    }

    for (const reason of refreshBranchEvidence(ctx, sessionFile, sessionId)) reasons.add(reason);
    for (const reason of serviceRegistryReasons(ctx, forceServiceRefresh)) reasons.add(reason);

    if (typeof ctx.shutdown !== "function" || typeof ctx.setTimeout !== "function") {
      reasons.add("graceful_shutdown_unavailable");
    }
    return { sessionFile, sessionId, reasons: [...reasons].sort() };
  }

  function status(ctx: HostContext): IdleRuntimeStatus {
    return state.status(observeHost(ctx), Date.now());
  }

  function stopServer(ctx?: HostContext): void {
    if (pendingUnloadTimer) {
      state.cancelPendingUnload(pendingUnloadTimer.sessionFile);
      if (typeof pendingUnloadTimer.context.clearTimer === "function") {
        try { pendingUnloadTimer.context.clearTimer(pendingUnloadTimer.handle); } catch {}
      }
      pendingUnloadTimer = undefined;
    }
    if (pollHandle !== undefined && ctx && typeof ctx.clearTimer === "function") {
      try {
        ctx.clearTimer(pollHandle);
      } catch {
        // The host may already have cleared its session timers.
      }
    }
    pollHandle = undefined;
    server?.stop(true);
    server = undefined;
    if (socketPath) releaseSocketOwnership(socketPath, state.hostId, socketIdentity);
    socketIdentity = undefined;
    socketPath = undefined;
  }

  function startServer(ctx: HostContext): void {
    stopServer(currentContext);
    currentContext = ctx;
    trackUiInteractions(ctx);
    if (!isRuntimeId(runtimeId) || !dir || !token || /[\r\n]/.test(token)) {
      logError("runtime identity or IPC configuration is missing; activity IPC is unavailable");
      return;
    }
    if (typeof ctx.setInterval !== "function" || typeof ctx.setTimeout !== "function") {
      logError("host timer APIs are unavailable; activity IPC is unavailable");
      return;
    }

    const path = join(dir, `${runtimeId}.sock`);
    try {
      mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
      const directoryStat = lstatSync(dir);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!directoryStat.isDirectory() || (uid !== undefined && directoryStat.uid !== uid)) {
        throw new Error("IPC directory must be a real directory owned by the runtime user");
      }
      chmodSync(dir, DIRECTORY_MODE);
      if ((lstatSync(dir).mode & 0o077) !== 0) throw new Error("IPC directory must be owner-only");
      if (!claimSocketOwnership(path, state.hostId)) throw new Error("runtime IPC socket is already owned");
      socketPath = path;
      const serverInstance = Bun.serve({
        unix: path,
        fetch: async (request) => {
          if (!sameToken(request, token)) return response({ kind: "unavailable", reason: "unauthorized" }, 401);
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/status") {
            return response(status(currentContext ?? ctx));
          }
          if (request.method !== "POST" ||
              (url.pathname !== "/unload" && url.pathname !== "/cancel-unload" && url.pathname !== "/prompt")) {
            return response({ kind: "unavailable", reason: "not_found" }, 404);
          }
          const parsed = await readJsonBody(request);
          if (parsed.error === "too_large") return response({ kind: "unavailable", reason: "body_too_large" }, 413);
          const input = record(parsed.value);
          if (parsed.error || !input) return response({ kind: "conflict", reason: "invalid_json" }, 400);
          const sessionFile = input.sessionFile;
          if (!nonEmptyText(sessionFile)) return response({ kind: "conflict", reason: "invalid_session_file" }, 400);
          const activeContext = currentContext ?? ctx;

          if (url.pathname === "/cancel-unload") {
            const attemptId = input.attemptId;
            if (!nonEmptyText(attemptId) || attemptId.length > 128) {
              return response({ kind: "conflict", reason: "invalid_attempt_id" }, 400);
            }
            // Never forget an acknowledged cancellation: a delayed request must
            // not become eligible again. Refuse new entries at the bound.
            if (!unloadAttempts.has(attemptId) && unloadAttempts.size >= 128) {
              return response({ kind: "unavailable", reason: "cancellation_capacity" }, 503);
            }
            const pending = pendingUnloadTimer;
            if (pending?.sessionFile === sessionFile && pending.attemptId === attemptId) {
              if (!state.cancelPendingUnload(sessionFile)) {
                return response({ kind: "conflict", reason: "unload is already committing" }, 409);
              }
              if (typeof pending.context.clearTimer === "function") {
                try { pending.context.clearTimer(pending.handle); } catch {}
              }
              pendingUnloadTimer = undefined;
            } else {
              try {
                if (state.status(observeHost(activeContext, true), Date.now()).unloading) {
                  return response({ kind: "conflict", reason: "unload is already committing" }, 409);
                }
              } catch {
                return response({ kind: "unavailable", reason: "unload_state_unavailable" }, 503);
              }
            }
            unloadAttempts.set(attemptId, "cancelled");
            return response({ kind: "accepted" }, 202);
          }

          if (url.pathname === "/prompt") {
            if (!nonEmptyText(input.text)) return response({ kind: "conflict", reason: "invalid_prompt" }, 400);
            if (input.files !== undefined && (!Array.isArray(input.files) ||
                input.files.some((path) => !nonEmptyText(path) || /[\u0000-\u001f\u007f]/.test(path)))) {
              return response({ kind: "conflict", reason: "invalid_attachment_paths" }, 400);
            }
            const session = ownedSession(activeContext);
            const prompt = session?.prompt;
            if (typeof prompt !== "function") {
              return response({ kind: "unavailable", reason: "prompt_api_unavailable" }, 503);
            }
            const observation = observeHost(activeContext);
            const requestId = randomUUID();
            const transition = state.beginPrompt(sessionFile, requestId, input.text, observation, Date.now());
            if (transition.kind === "conflict") return response(transition, 409);
            try {
              const images = Array.isArray(input.files) && input.files.length
                ? await readPromptImages(input.files as string[])
                : undefined;
              const admission = Promise.withResolvers<{ kind: "accepted" } | { kind: "conflict"; reason: string }>();
              const pending: unknown = Reflect.apply(prompt, session, [input.text, {
                expandPromptTemplates: false,
                streamingBehavior: "followUp",
                images: images?.length ? images : undefined,
                onPromptAdmitted: () => {
                  state.promptHandedOff(requestId);
                  admission.resolve({ kind: "accepted" });
                },
              }]);
              void Promise.resolve(pending).then(
                () => {
                  state.promptHandedOff(requestId);
                  admission.resolve({ kind: "conflict", reason: "Request was not admitted; your draft was not submitted." });
                },
                (error: unknown) => {
                  state.promptHandedOff(requestId);
                  const message = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
                  logError(message);
                  admission.resolve({ kind: "conflict", reason: message });
                  const notify = activeContext.ui?.notify;
                  if (typeof notify === "function") Reflect.apply(notify, activeContext.ui, [message, "error"]);
                },
              );
              const result = await admission.promise;
              return response(result, result.kind === "accepted" ? 202 : 409);
            } catch (error) {
              state.promptHandedOff(requestId);
              return response({ kind: "conflict", reason: error instanceof Error ? error.message : "Could not prepare request" }, 409);
            }
          }

          const attemptId = input.attemptId;
          if (attemptId !== undefined && (!nonEmptyText(attemptId) || attemptId.length > 128)) {
            return response({ kind: "conflict", reason: "invalid_attempt_id" }, 400);
          }
          if (nonEmptyText(attemptId) && unloadAttempts.get(attemptId) === "cancelled") {
            return response({ kind: "conflict", reason: "unload_cancelled" }, 409);
          }
          if (nonEmptyText(attemptId) && !unloadAttempts.has(attemptId) && unloadAttempts.size >= 128) {
            return response({ kind: "unavailable", reason: "cancellation_capacity" }, 503);
          }

          const idleTimeoutMs = input.idleTimeoutMs;
          if (typeof idleTimeoutMs !== "number" || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
            return response({ kind: "conflict", reason: "invalid_idle_timeout" }, 400);
          }
          const observation = observeHost(activeContext, true);
          const transition = state.beginUnload(sessionFile, idleTimeoutMs, observation, Date.now());
          if (transition.kind === "conflict") return response(transition, 409);
          // Reserve the cancellation entry before admitting shutdown. Later
          // cancellations cannot consume the space this attempt requires.
          if (nonEmptyText(attemptId)) unloadAttempts.set(attemptId, "pending");
          if (typeof activeContext.setTimeout !== "function") {
            state.cancelPendingUnload(sessionFile);
            return response({ kind: "unavailable", reason: "shutdown_schedule_unavailable" }, 503);
          }
          try {
            const scheduled = { sessionFile, attemptId: nonEmptyText(attemptId) ? attemptId : undefined, context: activeContext, handle: undefined as unknown };
            const timerHandle = activeContext.setTimeout.call(activeContext, () => {
              const pending = pendingUnloadTimer;
              // A cancelled callback may already be queued; it must not commit
              // a subsequent unload, even if the host reuses timer handles.
              if (pending !== scheduled) return;
              pendingUnloadTimer = undefined;
              try {
                const shutdownContext = currentContext ?? activeContext;
                const fresh = observeHost(shutdownContext, true);
                if (!state.completeUnload(fresh, Date.now())) return;
                const result = shutdownContext.shutdown?.();
                if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                  void Promise.resolve(result).catch(() => logError("host graceful shutdown rejected"));
                }
              } catch {
                // Keep the irreversible unload fence if shutdown state is uncertain.
                logError("host graceful shutdown failed");
              }
            }, SHUTDOWN_DELAY_MS);
            scheduled.handle = timerHandle;
            pendingUnloadTimer = scheduled;
          } catch {
            state.cancelPendingUnload(sessionFile);
            return response({ kind: "unavailable", reason: "shutdown_schedule_failed" }, 503);
          }
          return response({ kind: "accepted" }, 202);
        },
      });
      server = serverInstance;
      const boundStat = lstatSync(path);
      socketIdentity = identityOf(boundStat);
      chmodSync(path, SOCKET_MODE);
      const socketStat = lstatSync(path);
      if (
        !socketStat.isSocket() || socketStat.dev !== socketIdentity.dev || socketStat.ino !== socketIdentity.ino ||
        (uid !== undefined && socketStat.uid !== uid) || (socketStat.mode & 0o077) !== 0
      ) {
        throw new Error("IPC socket is not owner-only");
      }
      pollHandle = ctx.setInterval(() => {
        try {
          const observationContext = currentContext ?? ctx;
          state.status(observeHost(observationContext), Date.now());
        } catch {
          state.noteActivity();
        }
      }, ACTIVITY_POLL_MS);
      logInfo(`listening on ${path}`);
    } catch (error) {
      server?.stop(true);
      server = undefined;
      releaseSocketOwnership(path, state.hostId, socketIdentity);
      socketIdentity = undefined;
      socketPath = undefined;
      logError(error instanceof Error ? error.message : "socket startup failed");
    }
  }

  host.on("session_start", (_event, ctx) => {
    if (!ctx) return;
    startServer(ctx as HostContext);
  });
  host.on("session_switch", (_event, ctx) => {
    state.noteActivity();
    branchSessionKey = null;
    branchBlockers = ["session_branch_unavailable"];
    if (ctx) {
      currentContext = ctx as HostContext;
      trackUiInteractions(currentContext);
    }
  });
  host.on("session_shutdown", (_event, ctx) => stopServer(ctx as HostContext | undefined));
  host.on("tool_approval_requested", (event) => {
    const input = record(event);
    pendingApprovals.add(nonEmptyText(input?.toolCallId) ? input.toolCallId : `unknown-approval-${randomUUID()}`);
    state.noteActivity();
  });
  host.on("tool_approval_resolved", (event) => {
    const input = record(event);
    if (nonEmptyText(input?.toolCallId)) pendingApprovals.delete(input.toolCallId);
    state.noteActivity();
  });
  host.on("tool_execution_start", (event, ctx) => {
    const input = record(event);
    const id = nonEmptyText(input?.toolCallId) ? input.toolCallId : `unknown-tool-${randomUUID()}`;
    activeTools.add(id);
    state.noteActivity();
    if (ctx) {
      const context = ctx as HostContext;
      const ref = serviceReferenceFromEvent(event, context);
      if (ref) {
        addServiceReference(ref);
        runningServiceCalls.set(id, ref);
      }
    }
  });
  host.on("tool_execution_end", (event) => {
    const input = record(event);
    const id = nonEmptyText(input?.toolCallId) ? input.toolCallId : `unknown-tool-${randomUUID()}`;
    activeTools.delete(id);
    const previous = runningServiceCalls.get(id);
    runningServiceCalls.delete(id);
    const result = record(input?.result);
    const details = record(result?.details);
    const service = record(details?.service);
    if (service && nonEmptyText(service.name)) {
      addServiceReference({
        name: service.name,
        cwd: nonEmptyText(service.cwd) ? service.cwd : previous?.cwd ?? null,
      });
    }
    if (input?.toolName === "bash" || service) registryCache = undefined;
    state.noteActivity();
  });
  host.on("message_start", () => state.noteActivity());
  host.on("message_update", () => state.noteActivity());
  host.on("message_end", () => state.noteActivity());
  host.on("agent_start", () => state.noteActivity());
  host.on("agent_end", () => state.noteActivity());
  host.on("auto_retry_start", () => {
    activeWork.add("retry");
    state.noteActivity();
  });
  host.on("auto_retry_end", () => {
    activeWork.delete("retry");
    state.noteActivity();
  });
  host.on("auto_compaction_start", () => {
    activeWork.add("compaction");
    state.noteActivity();
  });
  host.on("auto_compaction_end", () => {
    activeWork.delete("compaction");
    state.noteActivity();
  });
  host.on("context", (_event, ctx) => {
    if (ctx) {
      currentContext = ctx as HostContext;
      trackUiInteractions(currentContext);
    }
  });
}
