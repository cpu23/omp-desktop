import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { Runtime } from "./runtime";
import { parseClientMessage, type ServerMessage } from "./protocol";

const HOST = process.env.OMP_DESKTOP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OMP_DESKTOP_PORT ?? 4180);
const ROOT = join(import.meta.dir, "..");
const OMP_BIN = process.env.OMP_DESKTOP_OMP ?? "omp";
const OMP_ARGS = (process.env.OMP_DESKTOP_OMP_ARGS ?? "").split(" ").filter((part) => part.length > 0);
const CWD = process.env.OMP_DESKTOP_CWD ?? process.env.HOME ?? process.cwd();
const OMP_OVERLAY = process.env.OMP_DESKTOP_OVERLAY ?? join(ROOT, "config/session.yml");
// Empty OMP_DESKTOP_OVERLAY disables the overlay: non-omp binaries (smoke test's
// bash) reject unknown flags.
const OVERLAY_ARGS = OMP_OVERLAY ? ["--config", OMP_OVERLAY] : [];

const runtime = new Runtime({
  id: "main",
  file: OMP_BIN,
  args: [...OVERLAY_ARGS, ...OMP_ARGS],
  cwd: CWD,
  cols: 120,
  rows: 32,
  env: {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PI_FORCE_IMAGE_PROTOCOL: process.env.PI_FORCE_IMAGE_PROTOCOL ?? "iterm2",
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
// Shown in the pane header and polled by the client: an open tab must notice a
// daemon restart with new code, otherwise a stale bundle looks like "nothing
// changed" (the pane is rebuilt on every daemon start).
const BUILD = createHash("sha1").update(clientCode).digest("hex").slice(0, 7);
const NO_STORE = { "cache-control": "no-store" };

const assets = {
  index: await Bun.file(join(ROOT, "public/index.html")).text(),
  styles: await Bun.file(join(ROOT, "public/styles.css")).text(),
  xterm: await Bun.file(join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")).text(),
  client: clientCode,
};

type WsData = { unsubData?: () => void; unsubExit?: () => void };

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

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/term") {
      return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/fonts/")) return serveFont(url.pathname);
    switch (url.pathname) {
      case "/":
        return new Response(assets.index, {
          headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
        });
      case "/client.js":
        return new Response(assets.client, {
          headers: { "content-type": "text/javascript; charset=utf-8", ...NO_STORE },
        });
      case "/styles.css":
        return new Response(assets.styles, {
          headers: { "content-type": "text/css; charset=utf-8", ...NO_STORE },
        });
      case "/xterm.css":
        return new Response(assets.xterm, {
          headers: { "content-type": "text/css; charset=utf-8", ...NO_STORE },
        });
      case "/api/build":
        return Response.json({ build: BUILD }, { headers: NO_STORE });
      case "/api/state":
        return Response.json({ runtime: runtime.info() });
      default:
        return new Response("not found", { status: 404 });
    }
  },
  websocket: {
    open(ws) {
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
    message(_ws, raw) {
      if (typeof raw !== "string") return;
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
  runtime.kill();
  server.stop(true);
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => runtime.kill());
