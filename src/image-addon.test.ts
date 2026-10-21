import { expect, test } from "bun:test";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import { loadImageAddon } from "./image-addon";

class Bitmap {
  width = 21;
  height = 42;
  closed = 0;
  close(): void { this.closed++; }
}

// Real parser, markers and addon storage; only browser rendering/decoding are
// replaced. A three-row image uses the addon's default 7x14 headless cell size.
function fixture() {
  const term = new HeadlessTerminal({ cols: 20, rows: 10, scrollback: 10, allowProposedApi: true });
  Object.assign(term, { onRender: () => ({ dispose() {} }) });
  const addon = loadImageAddon(term as unknown as Terminal);
  const storage = (addon as unknown as { _storage: {
    addImage(image: unknown): void;
    _images: Map<number, { marker: { isDisposed: boolean } }>;
    reset(): void;
  } })._storage;
  return { term, addon, storage };
}

for (const action of ["reset", "dispose"] as const) {
  test(`closes a bitmap when ${action} precedes deferred marker reconciliation`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ImageBitmap: Bitmap } });
    Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
    const { term, addon, storage } = fixture();
    try {
      const image = new Bitmap();
      storage.addImage(image);
      expect(storage._images.size).toBe(1);
      const marker = storage._images.values().next().value!.marker;
      let ran = false;
      const handler = term.parser.registerCsiHandler({ final: "z" }, () => {
        // This runs inside the same parser batch, before onWriteParsed.
        expect(marker.isDisposed).toBe(true);
        expect(storage._images.size).toBe(1);
        if (action === "reset") storage.reset();
        else addon.dispose();
        ran = true;
        return true;
      });
      await new Promise<void>(resolve => term.write("\x1b[3;1H\x1b[M\x1b[z", resolve));
      expect(ran).toBe(true);
      expect(storage._images.size).toBe(0);
      expect(image.closed).toBe(1);
      storage.reset();
      addon.dispose();
      expect(image.closed).toBe(1);
      handler.dispose();
    } finally {
      addon.dispose();
      term.dispose();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousBitmap) Object.defineProperty(globalThis, "ImageBitmap", previousBitmap);
      else Reflect.deleteProperty(globalThis, "ImageBitmap");
    }
  });
}
