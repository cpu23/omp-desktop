#!/usr/bin/env bun
/** Real xterm image pixels, isolated browsers and loopback-only fixture; no OMP credentials or live daemon. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit } from "playwright";
import { runImageAssertions } from "./fixtures/image-assertions";

const root = join(import.meta.dir, "..");
const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/image-terminal.ts")], target: "browser" });
if (!build.success) throw new AggregateError(build.logs, "Image fixture build failed");
const script = await build.outputs[0]!.text();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/xterm.css") return new Response(Bun.file(join(root, "node_modules/@xterm/xterm/css/xterm.css")));
    return new Response('<!doctype html><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;background:black}#terminal{width:1000px;height:600px}</style><div id="terminal"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
  },
});
const home = await mkdtemp(join(tmpdir(), "omp-image-smoke-"));
try {
  const browser = await webkit.launch({
    headless: true,
    env: {
      HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    },
  });
  try {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 1020, height: 620 }, deviceScaleFactor: scale });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.port}/?renderer=dom`);
        await runImageAssertions(page);
        console.log(`ok - WebKit DOM ${scale}x: live erase, partial delete, batched redraw, scroll, resize, replay + continuation`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
} finally {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
}
