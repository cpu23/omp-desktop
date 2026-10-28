import { TerminalReplay } from "../../src/terminal-replay";
import type {} from "./image-terminal";

/** The evaluation subset shared by Playwright and the native WebDriver adapter. */
export interface ImageEvaluationPage {
  evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
  evaluate<Arg, Result>(pageFunction: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>;
}

/** Runs the real xterm image pixel, clipping, erasure, pressure, scrollback, resize and replay cases. */
export async function runImageAssertions(page: ImageEvaluationPage): Promise<void> {
  await page.evaluate(async () => {
    const deadline = Date.now() + 30_000;
    while (!window.imageHarness && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!window.imageHarness) throw new Error("Image terminal fixture did not initialize");
  });

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
    const scenarios = [{ source, rows: "9,10,11,12,13" }];
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
      scenarios.push({ source: clipped, rows: "0,1" });
    }
    return scenarios;
  });

  for (const scenario of cases) {
    const replay = new TerminalReplay(80, 24);
    try {
      await new Promise<void>(resolve => replay.append(scenario.source, resolve));
      const snapshot = await new Promise<{ data: string; cols: number; rows: number }>(resolve => replay.snapshot(resolve));
      await page.evaluate(async ({ data, rows }: { data: string; rows: string }) => {
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
    } finally {
      replay.dispose();
    }
  }
}
