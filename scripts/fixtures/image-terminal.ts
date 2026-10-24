import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { loadImageAddon } from "../../src/image-addon";

const term = new Terminal({
  cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true,
  fontSize: 15, fontFamily: "monospace", theme: { background: "#000000" },
});
const host = document.querySelector<HTMLElement>("#terminal");
if (!host) throw new Error("Missing terminal host");
term.open(host);
if (new URLSearchParams(location.search).get("renderer") === "webgl") {
  term.loadAddon(new WebglAddon());
}
const addon = loadImageAddon(term);
// CSS screen/canvas sizes are rounded; image tile boundaries use xterm's
// unrounded cell metrics, which are private in the pinned xterm 6 renderer.
const internals = term as unknown as {
  _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
};

async function write(data: string): Promise<void> {
  await new Promise<void>(resolve => term.write(data, resolve));
}
async function settle(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function image(format: "image/png" | "image/webp" = "image/png", rows = 5, sized = false): string {
  const cell = internals._core._renderService.dimensions.css.cell;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(cell.width * 40);
  canvas.height = Math.floor(cell.height * rows);
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = ["#00b4ff", "#ff8800", "#55dd66", "#aa66ee"][i];
    ctx.fillRect(Math.floor(i * canvas.width / 4), 0, Math.ceil(canvas.width / 4), canvas.height);
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, Math.floor(cell.height));
  const payload = canvas.toDataURL(format).split(",")[1];
  return `\x1b]1337;File=inline=1${sized ? `;size=${atob(payload).length}` : ""}:${payload}\x07`;
}
async function assertCleanPaint(): Promise<void> {
  await settle();
  const canvas = host!.querySelector<HTMLCanvasElement>(".xterm-image-layer");
  const before = canvas?.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  term.refresh(0, term.rows - 1);
  await settle();
  const current = host!.querySelector<HTMLCanvasElement>(".xterm-image-layer");
  const after = current?.getContext("2d")!.getImageData(0, 0, current.width, current.height);
  if (!before && !after) return;
  if (!before || !after || before.width !== after.width || before.height !== after.height) {
    throw new Error("Incremental image paint disagrees with a complete repaint");
  }
  for (let i = 0; i < before.data.length; i++) {
    if (before.data[i] !== after.data[i]) {
      throw new Error(`Stale image pixel at ${Math.floor(i / 4) % before.width},${Math.floor(i / 4 / before.width)}`);
    }
  }
}
function paintedRows(): number[] {
  const canvas = host!.querySelector<HTMLCanvasElement>(".xterm-image-layer");
  if (!canvas) return [];
  const height = internals._core._renderService.dimensions.css.cell.height;
  const ctx = canvas.getContext("2d")!;
  const rows: number[] = [];
  for (let row = 0; row < term.rows; row++) {
    const top = Math.floor(row * height);
    const pixels = ctx.getImageData(0, top, canvas.width, Math.floor((row + 1) * height) - top).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]) { rows.push(row); break; }
    }
  }
  return rows;
}

export const imageHarness = { term, addon, write, settle, image, assertCleanPaint, paintedRows };
declare global {
  interface Window { imageHarness: typeof imageHarness }
}
window.imageHarness = imageHarness;
