import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RuntimeManager, RuntimeCapacityError } from "./manager";
import { listSessions } from "./sessions";
import { isRecord } from "./guards";
import { parseClientMessage, type RuntimesResponse, type ServerMessage } from "./protocol";
import type { Runtime } from "./runtime";

const HOST = process.env.OMP_DESKTOP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OMP_DESKTOP_PORT ?? 4180);
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
const MAX_RUNTIMES = Number(process.env.OMP_DESKTOP_MAX_RUNTIMES ?? 8);
const SESSIONS_DIR =
  process.env.OMP_DESKTOP_SESSIONS_DIR ?? join(process.env.HOME ?? "", ".omp/agent/sessions");
const PASTE_DIR = process.env.OMP_DESKTOP_PASTE_DIR ?? join(tmpdir(), "omp-desktop-pastes");
const PASTE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const PASTE_LIMIT = 32 * 1024 * 1024;
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

const manager = new RuntimeManager({
  file: OMP_BIN,
  args: [...OVERLAY_ARGS, ...OMP_ARGS, ...EXTENSION_ARGS],
  cwd: CWD,
  cols: 120,
  rows: 32,
  maxRuntimes: Number.isFinite(MAX_RUNTIMES) && MAX_RUNTIMES > 0 ? MAX_RUNTIMES : 8,
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

const assets = {
  index: await Bun.file(join(ROOT, "public/index.html")).text(),
  styles: stylesCode,
  xterm: await Bun.file(join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")).text(),
  client: clientCode,
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
  if (!absolute.startsWith(resolve(SESSIONS_DIR) + "/")) return null;
  if (!existsSync(absolute)) return null;
  return absolute;
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/term") {
      const runtime = manager.get(url.searchParams.get("runtime") ?? "");
      if (!runtime) return new Response("unknown runtime", { status: 404 });
      return srv.upgrade(req, { data: { runtime } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/fonts/")) return serveFont(url.pathname);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        return new Response(assets.index, {
          headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
        });
      case "GET /client.js":
        return new Response(assets.client, {
          headers: { "content-type": "text/javascript; charset=utf-8", ...NO_STORE },
        });
      case "GET /styles.css":
        return new Response(assets.styles, {
          headers: { "content-type": "text/css; charset=utf-8", ...NO_STORE },
        });
      case "GET /xterm.css":
        return new Response(assets.xterm, {
          headers: { "content-type": "text/css; charset=utf-8", ...NO_STORE },
        });
      case "GET /api/build":
        return Response.json({ build: BUILD }, { headers: NO_STORE });
      case "POST /api/paste": {
        // The browser owns the clipboard image; omp's TUI only reads text, so the
        // bytes land in a file and the pane types the path — what a terminal with
        // image paste does.
        const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
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
        const body: RuntimesResponse = {
          build: BUILD,
          runtimes: manager.list(),
          defaults: { cwd: manager.defaults.cwd, maxRuntimes: manager.defaults.maxRuntimes },
        };
        return Response.json(body, { headers: NO_STORE });
      }
      case "POST /api/runtimes": {
        const body: unknown = await req.json().catch(() => null);
        if (!isRecord(body)) return new Response("bad request", { status: 400 });
        const cwd = typeof body.cwd === "string" && existsSync(body.cwd) ? body.cwd : undefined;
        const resumeRaw = typeof body.resume === "string" ? body.resume : undefined;
        const resume = resumeRaw === undefined ? undefined : validResume(resumeRaw);
        if (resumeRaw !== undefined && resume === null) {
          return new Response("resume must be an existing session file under the session store", { status: 400 });
        }
        try {
          const runtime = manager.create({
            cwd,
            resume: resume ?? undefined,
            cols: typeof body.cols === "number" ? body.cols : undefined,
            rows: typeof body.rows === "number" ? body.rows : undefined,
          });
          return Response.json({ runtime: runtime.info() }, { headers: NO_STORE });
        } catch (error) {
          if (error instanceof RuntimeCapacityError) return new Response(error.message, { status: 409 });
          throw error;
        }
      }
      case "GET /api/sessions": {
        const limit = Number(url.searchParams.get("limit") ?? 60);
        const sessions = await listSessions({
          limit: Number.isFinite(limit) && limit > 0 ? limit : 60,
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
        const message: ServerMessage = { type: "exit", exitCode: exit.exitCode };
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

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  manager.killAll();
  server.stop(true);
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => manager.killAll());
