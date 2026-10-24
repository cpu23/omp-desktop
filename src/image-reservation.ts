import type { ImageAddon } from "@xterm/addon-image";
import type { Terminal } from "@xterm/xterm";

/** A saved-cursor image block can straddle the viewport top. CUU clamps there;
 * drawing the full bitmap would shift its hidden top over unrelated text below.
 * Keep only the visible bottom slice, including when a replay names the crop. */
export function clipImageReservations(term: Terminal, addon: ImageAddon): void {
  type Image = HTMLCanvasElement | ImageBitmap;
  // addon-image's decoded-image insertion and header are private in version 0.9.
  const internals = addon as unknown as {
    _renderer: { cellSize: { height: number } };
    _storage: { addImage(image: Image): void };
    _handlers: Map<string, {
      _header?: { desktopImageRows?: Uint32Array };
      end(success: boolean): boolean | Promise<boolean>;
    }>;
  };
  // xterm 6 does not expose its DECSC register through the public buffer API.
  const terminal = term as unknown as { _core: { buffer: { savedY: number; ybase: number; scrollTop: number } } };
  let saved = false;
  let requestedLift = 0;
  let expectedRow = 0;
  let expectedCol = 0;
  let savedType = term.buffer.active.type;
  let iipActive = false;
  let replayRows = 0;
  let disposed = false;
  const hooks = [
    term.parser.registerEscHandler({ final: "7" }, () => {
      saved = true;
      requestedLift = 0;
      expectedRow = term.buffer.active.cursorY;
      expectedCol = term.buffer.active.cursorX;
      savedType = term.buffer.active.type;
      return false;
    }),
    term.parser.registerEscHandler({ final: "8" }, () => { saved = false; requestedLift = 0; return false; }),
    term.parser.registerEscHandler({ final: "c" }, () => { saved = false; requestedLift = 0; return false; }),
    term.parser.registerCsiHandler({ final: "A" }, params => {
      const buffer = term.buffer.active;
      if (buffer.type !== savedType || buffer.cursorY !== expectedRow || buffer.cursorX !== expectedCol) saved = false;
      if (saved && typeof params[0] === "number") {
        const count = params[0] || 1;
        requestedLift += count;
        const top = terminal._core.buffer.scrollTop;
        expectedRow = Math.max(buffer.cursorY >= top ? top : 0, buffer.cursorY - count);
      }
      return false;
    }),
  ];
  const iip = internals._handlers.get("iip")!;
  const end = iip.end.bind(iip);
  iip.end = success => {
    const encoded = iip._header?.desktopImageRows;
    const rows = encoded ? Number(String.fromCodePoint(...encoded)) : 0;
    replayRows = Number.isSafeInteger(rows) && rows > 0 ? rows : 0;
    iipActive = true;
    try {
      const result = end(success);
      if (typeof result !== "boolean") return result.finally(() => { iipActive = false; });
      iipActive = false;
      return result;
    } catch (error) {
      iipActive = false;
      throw error;
    }
  };
  const insert = internals._storage.addImage.bind(internals._storage);
  internals._storage.addImage = image => {
    if (disposed) {
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
      return;
    }
    const height = internals._renderer.cellSize.height;
    let visibleRows = iipActive ? replayRows : 0;
    const active = term.buffer.active;
    if (iipActive && saved && active.type === savedType &&
        active.cursorY === expectedRow && active.cursorX === expectedCol && requestedLift > 0) {
      const buffer = terminal._core.buffer;
      const savedRow = Math.max(0, Math.min(term.rows - 1, buffer.savedY - buffer.ybase));
      const available = Math.max(0, savedRow - active.cursorY);
      if (requestedLift > available) visibleRows = visibleRows ? Math.min(visibleRows, available + 1) : available + 1;
    }
    const top = height > 0 && visibleRows > 0 ? Math.max(0, image.height - Math.floor(visibleRows * height)) : 0;
    if (top === 0) {
      insert(image);
      return;
    }
    try {
      if (top < image.height) {
        const canvas = term.element!.ownerDocument.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height - top;
        canvas.getContext("2d")!.drawImage(image, 0, top, image.width, canvas.height, 0, 0, image.width, canvas.height);
        insert(canvas);
      }
    } finally {
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
    }
  };
  const dispose = addon.dispose.bind(addon);
  addon.dispose = () => {
    disposed = true;
    for (const hook of hooks) hook.dispose();
    dispose();
  };
}
