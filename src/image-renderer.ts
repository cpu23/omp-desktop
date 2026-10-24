import type { ImageAddon } from "@xterm/addon-image";

/** addon-image 0.9 rounds image draws down but clears fractional CSS row
 * coordinates. Use disjoint pixel rows so erasing text cannot leave image
 * pixels behind or erase the edge of an adjacent image row. */
export function repairImageCanvasRows(addon: ImageAddon): void {
  // The pinned dependency does not expose its renderer in its public typings.
  const internals = addon as unknown as { _renderer: {
    _ctx?: CanvasRenderingContext2D | null;
    cellSize: { width: number; height: number };
    canvas?: HTMLCanvasElement;
    clearLines(start: number, end: number): void;
    draw(spec: unknown, tile: number, col: number, row: number, count?: number): void;
    drawPlaceholder(col: number, row: number, count?: number): void;
  } };
  const renderer = internals._renderer;
  renderer.clearLines = (start, end) => {
    const height = renderer.cellSize.height;
    if (height <= 0) return;
    const top = Math.floor(start * height);
    renderer._ctx?.clearRect(0, top, renderer.canvas?.width ?? 0, Math.floor((end + 1) * height) - top);
  };
  const draw = renderer.draw.bind(renderer);
  renderer.draw = (spec, tile, col, row, count) => {
    const height = renderer.cellSize.height;
    const ctx = renderer._ctx;
    if (!ctx || height <= 0 || Number.isInteger(height)) {
      draw(spec, tile, col, row, count);
      return;
    }
    const top = Math.floor(row * height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, renderer.canvas?.width ?? 0, Math.floor((row + 1) * height) - top);
    ctx.clip();
    draw(spec, tile, col, row, count);
    ctx.restore();
  };
  const placeholder = renderer.drawPlaceholder.bind(renderer);
  renderer.drawPlaceholder = (col, row, count) => {
    const height = renderer.cellSize.height;
    const ctx = renderer._ctx;
    if (!ctx || height <= 0 || Number.isInteger(height)) {
      placeholder(col, row, count);
      return;
    }
    const top = Math.floor(row * height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, renderer.canvas?.width ?? 0, Math.floor((row + 1) * height) - top);
    ctx.clip();
    placeholder(col, row, count);
    ctx.restore();
  };
}
