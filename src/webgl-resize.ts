import type { WebglAddon } from "@xterm/addon-webgl";

/** addon-webgl 0.19 updates canvas backing size without updating its viewport
 * or shader resolution. Keep this adapter pinned to that version's internals;
 * remove when its device-pixel resize callback updates both renderers itself. */
export function repairWebglCanvasResize(addon: WebglAddon): void {
  // The pinned addon omits its private renderer from its public declarations.
  const internals = addon as unknown as { _renderer: {
    _canvas: HTMLCanvasElement;
    _setCanvasDevicePixelDimensions(width: number, height: number): void;
    _glyphRenderer: { value?: { handleResize(): void } };
    _rectangleRenderer: { value?: { handleResize(): void } };
    _clearModel(clear: boolean): void;
  } };
  const renderer = internals._renderer;
  const resize = renderer._setCanvasDevicePixelDimensions;
  renderer._setCanvasDevicePixelDimensions = function (width, height): void {
    if (this._canvas.width === width && this._canvas.height === height) return;
    resize.call(this, width, height);
    this._rectangleRenderer.value?.handleResize();
    this._glyphRenderer.value?.handleResize();
    this._clearModel(true);
  };
}
