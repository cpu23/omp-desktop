#!/usr/bin/env bun
/** Real xterm image pixels, isolated browsers and loopback-only fixture; no OMP credentials or live daemon. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { TerminalReplay } from "../src/terminal-replay";
import type {} from "./fixtures/image-terminal";

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
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]] as const) {
    const browser = await engine.launch({
      headless: true,
      ...(name === "chromium" ? { args: ["--enable-unsafe-swiftshader"] } : {}),
      env: {
        HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
        ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
      },
    });
    try {
      for (const scale of [1, 1.25, 1.5, 2]) {
        for (const renderer of name === "chromium" ? ["dom", "webgl"] : ["dom"]) {
          const context = await browser.newContext({ viewport: { width: 1020, height: 620 }, deviceScaleFactor: scale });
          const page = await context.newPage();
          try {
            await page.goto(`http://127.0.0.1:${server.port}/?renderer=${renderer}`);
            await page.waitForFunction(() => !!window.imageHarness);
            const cases = await page.evaluate(async () => {
              const h = window.imageHarness;
              const png = h.image();
              const webp = h.image("image/webp");
              await h.write(`\x1bc\x1b[12;1H${png}\x1b[18;1H${webp}`);
              await h.settle();
              if (h.paintedRows().join(",") !== "11,12,13,14,15,17,18,19,20,21") {
                throw new Error("PNG/WebP image placement lost or added rows");
              }
              await h.write("\x1b[12;1Hreplacement");
              await h.assertCleanPaint();
              await h.write("\x1b[12;1H\x1b[2K");
              await h.assertCleanPaint();
              if (h.paintedRows().includes(11)) throw new Error("Erased image row still has pixels");
              await h.write("\x1b[22;1H\x1b[M");
              await h.assertCleanPaint();
              if (!h.addon.getImageAtBufferCell(0, 17)) throw new Error("Deleting an image's end row lost surviving pixels");

              h.addon.storageLimit = 0.5;
              await h.write(`\x1bc\x1b[1;1H${png}\x1b[12;1H${png}`);
              let redraws = "";
              for (let i = 0; i < 12; i++) {
                for (let row = 12; row <= 16; row++) redraws += `\x1b[${row};1H\x1b[2K`;
                redraws += `\x1b[12;1H${png}`;
              }
              await h.write(redraws);
              await h.assertCleanPaint();
              if (!h.addon.getImageAtBufferCell(0, 0) || !h.addon.getImageAtBufferCell(0, 11)) {
                throw new Error("Erased redraws evicted a still-visible image");
              }
              h.addon.storageLimit = 128;
              for (const margin of [6, 14, 24]) {
                await h.write(`\x1b[1;${margin}r\x1b[${margin};1H\r\n`);
                await h.assertCleanPaint();
              }
              await h.write("\x1b[r\x1b[24;1H" + "history\r\n".repeat(30));
              h.term.scrollToTop();
              await h.assertCleanPaint();
              h.term.scrollToBottom();
              await h.assertCleanPaint();
              h.term.resize(100, 28);
              await h.assertCleanPaint();
              h.term.resize(80, 24);
              await h.assertCleanPaint();

              // OMP reserves image rows, saves the cursor below them, then draws upward.
              const table = "\x1b[3;1HCPU-host activity\x1b[4;1HK3 GEMV 31.8%\x1b[5;1HK2 GEMV 18.6%\x1b[6;1HPolling 41.6%";
              const source = `\x1bc${table}\x1b[14;1H\x1b7\x1b[4A${png}\x1b8`;
              await h.write(source);
              await h.assertCleanPaint();
              const cases = [{ source, rows: "9,10,11,12,13" }];
              // Also cover a decoded height larger than the producer's row estimate.
              for (const sized of [false, true]) {
                const clipped = `\x1bc${table}\x1b[2;1H\x1b7\x1b[8A${h.image("image/png", sized ? 10 : 9, sized)}\x1b8`;
                // A split image control must retain its saved-cursor reservation.
                const split = Math.floor(clipped.length / 2);
                await h.write(clipped.slice(0, split));
                await h.write(clipped.slice(split));
                await h.assertCleanPaint();
                if (h.paintedRows().join(",") !== "0,1" || h.addon.getImageAtBufferCell(0, 4)) {
                  throw new Error("Clamped image overpainted unrelated table rows");
                }
                const slice = h.addon.getImageAtBufferCell(0, 0)!;
                const pixel = slice.getContext("2d")!.getImageData(0, 0, 1, 1).data;
                if (pixel[0] !== 0 || pixel[1] !== 180 || pixel[2] !== 255) {
                  throw new Error("Clamped image did not retain its bottom slice");
                }
                cases.push({ source: clipped, rows: "0,1" });
              }
              return cases;
            });
            for (const scenario of cases) {
              const replay = new TerminalReplay(80, 24);
              try {
                await new Promise<void>(resolve => replay.append(scenario.source, resolve));
                const snapshot = await new Promise<{ data: string; cols: number; rows: number }>(resolve => replay.snapshot(resolve));
                await page.evaluate(async ({ data, rows }) => {
                  const h = window.imageHarness;
                  for (let i = 0; i < 3; i++) {
                    await h.write(data);
                    await h.write("\x1b[16;1Hlive continuation");
                    await h.assertCleanPaint();
                    const line = h.term.buffer.active.getLine(h.term.buffer.active.baseY + 4)?.translateToString(true);
                    if (line !== "K2 GEMV 18.6%") throw new Error(`Reconnect damaged the table: ${line}`);
                    if (h.paintedRows().join(",") !== rows) throw new Error("Reconnect duplicated or misplaced chart pixels");
                    if (rows === "0,1") {
                      const slice = h.addon.getImageAtBufferCell(0, 0)!;
                      const pixel = slice.getContext("2d")!.getImageData(0, 0, 1, 1).data;
                      if (pixel[0] !== 0 || pixel[1] !== 180 || pixel[2] !== 255) throw new Error("Replay lost image cropping");
                    }
                  }
                }, { data: snapshot.data, rows: scenario.rows });
              } finally { replay.dispose(); }
            }
            console.log(`ok - ${name} ${renderer} ${scale}x: live erase, partial delete, batched redraw, scroll, resize, replay + continuation`);
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
} finally {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
}
