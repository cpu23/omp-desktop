import { join } from "node:path";
import { Runtime } from "./runtime";
import { parseClientMessage, type ServerMessage } from "./protocol";

const HOST = process.env.OMP_DESKTOP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OMP_DESKTOP_PORT ?? 4180);
const ROOT = join(import.meta.dir, "..");
const OMP_BIN = process.env.OMP_DESKTOP_OMP ?? "omp";
const OMP_ARGS = (process.env.OMP_DESKTOP_OMP_ARGS ?? "").split(" ").filter((part) => part.length > 0);
const CWD = process.env.OMP_DESKTOP_CWD ?? process.env.HOME ?? process.cwd();

const runtime = new Runtime({
  id: "main",
  file: OMP_BIN,
  args: OMP_ARGS,
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

const assets = {
  index: await Bun.file(join(ROOT, "public/index.html")).text(),
  styles: await Bun.file(join(ROOT, "public/styles.css")).text(),
  xterm: await Bun.file(join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")).text(),
  client: await clientBundle.text(),
};

type WsData = { unsubData?: () => void; unsubExit?: () => void };

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/term") {
      return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    switch (url.pathname) {
      case "/":
        return new Response(assets.index, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "/client.js":
        return new Response(assets.client, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      case "/styles.css":
        return new Response(assets.styles, { headers: { "content-type": "text/css; charset=utf-8" } });
      case "/xterm.css":
        return new Response(assets.xterm, { headers: { "content-type": "text/css; charset=utf-8" } });
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
