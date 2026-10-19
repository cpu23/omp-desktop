import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RuntimeManager, RuntimeCapacityError } from "./manager";
import { listSessions, readSessionCwd } from "./sessions";
import { isRecord } from "./guards";
import { parseClientMessage, type RuntimeInfo, type RuntimesResponse, type ServerMessage } from "./protocol";
import { PresentationReader } from "./presentation";
import { STATE_LIMIT_BYTES, WorkspaceStateStore, RuntimeLedgerStore } from "./state";
import {
  DaemonSettingsStore,
  isPositiveInteger,
  resolveMaxRuntimes,
  settingsPayload,
} from "./settings";
import type { Runtime } from "./runtime";

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
const PASTE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const PASTE_LIMIT = 32 * 1024 * 1024;
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
  return { maxRuntimes: null, malformed: false };
});
if (savedSettings.malformed) {
  console.warn(`omp-desktopd: ignoring malformed settings file ${SETTINGS_FILE}`);
}
const initialLimit = resolveMaxRuntimes(savedSettings.maxRuntimes, process.env.OMP_DESKTOP_MAX_RUNTIMES);
const EFFECTIVE_MAX_RUNTIMES = initialLimit.maxRuntimes;
let desiredMaxRuntimes = initialLimit.maxRuntimes;
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

const manager = new RuntimeManager({
  file: OMP_BIN,
  args: [...OVERLAY_ARGS, ...OMP_ARGS, ...EXTENSION_ARGS],
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
    ...(MOBILE_TOKEN ? { OMP_MOBILE_IPC_TOKEN: MOBILE_TOKEN } : {}),
  },
});

const clientBuild = await Bun.build({
  entrypoints: [join(import.meta.dir, "client.ts")],
  target: "browser",
  sourcemap: "inline",
});
const clientBundle = clientBuild.outputs.find((output) => output.path.endsWith(".js"));
if (!clientBuild.success || !clientBundle) {
  console.error("client bundle failed");
  for (const log of clientBuild.logs) console.error(log);
  process.exit(1);
}

const clientCode = await clientBundle.text();
const stylesCode = await Bun.file(join(ROOT, "public/styles.css")).text();
// Shown in the pane header and polled by the client: an open tab must notice a
// daemon restart with new code, otherwise a stale bundle looks like "nothing
// changed" (the panes are rebuilt on every daemon start). Styles are hashed too:
// a CSS-only change would otherwise stay invisible in an open tab.
const BUILD = createHash("sha1").update(clientCode).update(stylesCode).digest("hex").slice(0, 7);
const NO_STORE = { "cache-control": "no-store" };

/** Static text responses, keyed by the exact pathname they answer. */
const TEXT_ASSETS: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: await Bun.file(join(ROOT, "public/index.html")).text() },
  "/client.js": { type: "text/javascript; charset=utf-8", body: clientCode },
  "/styles.css": { type: "text/css; charset=utf-8", body: stylesCode },
  "/xterm.css": {
    type: "text/css; charset=utf-8",
    body: await Bun.file(join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")).text(),
  },
};

type WsData = { runtime?: Runtime; unsubData?: () => void; unsubExit?: () => void };

const FONT_DIR = join(ROOT, "public/fonts");
const FONT_TYPES: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

async function serveFont(pathname: string): Promise<Response> {
  const name = basename(decodeURIComponent(pathname));
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !(ext in FONT_TYPES)) {
    return new Response("bad font", { status: 400 });
  }
  const file = Bun.file(join(FONT_DIR, name));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, {
    headers: { "content-type": FONT_TYPES[ext], "cache-control": "public, max-age=86400" },
  });
}

/** Resume is restricted to real session files under the store: the daemon runs
 *  whatever path it is handed as argv, and this endpoint is reachable from any
 *  page in the browser that can hit loopback. */
function validResume(path: string | undefined): string | null {
  if (!path || !isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const absolute = resolve(path);
  if (!absolute.startsWith(`${SESSIONS_ROOT}/`)) return null;
  return existsSync(absolute) ? absolute : null;
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
 * The systemd user unit this process is the main program of, if any.
 *
 * `INVOCATION_ID` is inherited by every descendant of a unit, so finding it is
 * not enough: a daemon started from a terminal inside a session has it too, and
 * restarting that session's unit would be destructive. Auto-detection therefore
 * requires the cgroup's own `.service` component *and* a matching
 * `InvocationID` from systemd. `OMP_DESKTOP_SYSTEMD_UNIT` is the explicit
 * escape hatch for unusual unit names or non-user services.
 */
function activeSystemdUnit(): string | null {
  const explicit = process.env.OMP_DESKTOP_SYSTEMD_UNIT?.trim();
  if (explicit) return explicit;
  const invocation = process.env.INVOCATION_ID;
  if (!invocation) return null;
  let unit: string | null = null;
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    for (const line of cgroup.split("\n")) {
      if (line.trim().length === 0) continue;
      // cgroup v2 is `0::/path`; v1 lines end in `:<controller>:/path`.
      const path = line.slice(line.lastIndexOf(":") + 1);
      const candidate = path
        .split("/")
        .filter((part) => part.endsWith(".service") && !part.startsWith("user@") && !part.startsWith("systemd-"))
        .at(-1);
      if (candidate) {
        unit = candidate;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!unit) return null;
  try {
    const shown = Bun.spawnSync(["systemctl", "--user", "show", "-p", "InvocationID", "--value", unit], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (shown.exitCode !== 0 || shown.stdout.toString().trim() !== invocation) return null;
  } catch {
    return null;
  }
  return unit;
}

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

await waitForPreviousDaemon();

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (
      url.pathname === "/api/runtimes" ||
      url.pathname === "/api/settings" ||
      url.pathname === "/api/restart" ||
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
    if (url.pathname.startsWith("/fonts/")) return serveFont(url.pathname);
    const asset = TEXT_ASSETS[url.pathname];
    if (req.method === "GET" && asset) {
      return new Response(asset.body, { headers: { "content-type": asset.type, ...NO_STORE } });
    }
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/settings":
        return Response.json(settingsPayload(desiredMaxRuntimes, EFFECTIVE_MAX_RUNTIMES), {
          headers: NO_STORE,
        });
      case "PUT /api/settings": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body) || !isPositiveInteger(body.maxRuntimes)) {
          return new Response(
            "maxRuntimes must be a positive integer (for example 16); the current limit was not changed",
            { status: 400 },
          );
        }
        const maxRuntimes = body.maxRuntimes;
        // Restore is bounded by the limit, so accepting a lower limit than the
        // sessions that would come back would silently drop them on restart.
        // Reject the save instead of letting a restart lose work.
        const live = manager.liveSessions().length;
        if (maxRuntimes < live) {
          return new Response(
            `cannot set the runtime limit to ${maxRuntimes}: ${live} live session(s) would not fit after a restart. Stop sessions first or choose at least ${live}.`,
            { status: 400 },
          );
        }
        try {
          await settingsStore.save(maxRuntimes);
        } catch (error) {
          return new Response(
            `settings save failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
        desiredMaxRuntimes = maxRuntimes;
        return Response.json(settingsPayload(desiredMaxRuntimes, EFFECTIVE_MAX_RUNTIMES), {
          headers: NO_STORE,
        });
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
        return Response.json({ build: BUILD }, { headers: NO_STORE });
      case "GET /api/state": {
        try {
          return Response.json(await stateStore.read(), { headers: NO_STORE });
        } catch (error) {
          return new Response(
            `state read failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500 },
          );
        }
      }
      case "PUT /api/state": {
        const declared = Number(req.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > STATE_LIMIT_BYTES) {
          return new Response("state document too large", { status: 413 });
        }
        const text = await req.text();
        if (Buffer.byteLength(text) > STATE_LIMIT_BYTES) {
          return new Response("state document too large", { status: 413 });
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
        const ext = PASTE_TYPES[type];
        if (!ext) return new Response("unsupported image type", { status: 415 });
        const bytes = await req.arrayBuffer();
        if (bytes.byteLength === 0) return new Response("empty body", { status: 400 });
        if (bytes.byteLength > PASTE_LIMIT) return new Response("image too large", { status: 413 });
        await mkdir(PASTE_DIR, { recursive: true });
        const path = join(PASTE_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
        await Bun.write(path, bytes);
        return Response.json({ path }, { headers: NO_STORE });
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
        return Response.json(body, { headers: NO_STORE });
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
          // A saved lower limit is pending until restart, but the running daemon
          // still has the old, larger allocation. Do not let the pool grow past
          // the pending limit: otherwise a later restart would restore more
          // sessions than the saved limit allows and silently drop the excess.
          // Resuming a transcript that is already live is still allowed (it
          // reuses that process, and manager.create dedupes it).
          if (desiredMaxRuntimes < EFFECTIVE_MAX_RUNTIMES) {
            const alreadyLive =
              resume !== undefined &&
              manager.list().some((info) => info.sessionFile === resume && info.status !== "exited");
            const live = manager.liveSessions().length;
            if (!alreadyLive && live >= desiredMaxRuntimes) {
              return new Response(
                `session limit reached: ${live}/${desiredMaxRuntimes} sessions are allowed by the saved limit that takes effect after restart. Stop a session or raise the runtime limit in Settings.`,
                { status: 409 },
              );
            }
          }
          const runtime = await manager.create({
            cwd,
            resume,
            cols: typeof body.cols === "number" ? body.cols : undefined,
            rows: typeof body.rows === "number" ? body.rows : undefined,
          });
          return Response.json({ runtime: runtime.info() }, { headers: NO_STORE });
        } catch (error) {
          if (error instanceof RuntimeCapacityError) {
            const inUse = manager.list().length;
            return new Response(
              `session limit reached: ${inUse}/${manager.defaults.maxRuntimes} runtime slots are in use. Stop a session or raise the runtime limit in Settings, then apply it with Restart now.`,
              { status: 409 },
            );
          }
          throw error;
        }
      }
      case "GET /api/sessions": {
        // `listSessions` owns limit validation; forwarding keeps one policy.
        const sessions = await listSessions({
          limit: Number(url.searchParams.get("limit") ?? 60),
          search: url.searchParams.get("search") ?? undefined,
        });
        return Response.json({ sessions }, { headers: NO_STORE });
      }
      default:
        break;
    }
    const killMatch = /^\/api\/runtimes\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (killMatch && req.method === "DELETE") {
      return manager.kill(killMatch[1])
        ? Response.json({ ok: true }, { headers: NO_STORE })
        : new Response("unknown runtime", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const runtime = ws.data.runtime;
      if (!runtime) {
        ws.close();
        return;
      }
      runtime.start();
      const replay = runtime.replay();
      const hello: ServerMessage = {
        type: "hello",
        runtime: runtime.info(),
        replayBytes: Buffer.byteLength(replay),
      };
      ws.send(JSON.stringify(hello));
      if (replay.length > 0) ws.send(Buffer.from(replay, "utf8"));
      ws.data.unsubData = runtime.subscribeData((data) => ws.send(Buffer.from(data, "utf8")));
      ws.data.unsubExit = runtime.subscribeExit((exit) => {
        const message: ServerMessage = { type: "exit", exitCode: exit.exitCode, daemonShutdown: shuttingDown };
        ws.send(JSON.stringify(message));
      });
    },
    message(ws, raw) {
      const runtime = ws.data.runtime;
      if (!runtime || typeof raw !== "string") return;
      const msg = parseClientMessage(raw);
      if (!msg) return;
      if (msg.type === "input") runtime.write(msg.data);
      else runtime.resize(msg.cols, msg.rows);
    },
    close(ws) {
      ws.data.unsubData?.();
      ws.data.unsubExit?.();
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

function writeLedger(): void {
  ledgerWrite = ledger.save(manager.liveSessions()).catch((error) => {
    console.warn(`omp-desktopd: runtime ledger not saved: ${error instanceof Error ? error.message : String(error)}`);
  });
}

manager.subscribeChanges((change) => {
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
    const records = await ledger.read();
    if (records.length === 0) return;
    let restored = 0;
    for (const record of records) {
      if (shuttingDown) break;
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
  if (exitSaveTimer !== null) {
    clearTimeout(exitSaveTimer);
    exitSaveTimer = null;
  }
  manager.killAll();
  server.stop(true);
  // Exit only once a write already in flight has landed; the ceiling keeps a
  // wedged filesystem from hanging the shutdown, and the timer also gives the
  // SIGTERMed children a moment to go.
  void Promise.race([ledgerWrite, Bun.sleep(1000)]).then(() => setTimeout(() => process.exit(code), 100));
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => manager.killAll());

const poolReady = restorePool();
