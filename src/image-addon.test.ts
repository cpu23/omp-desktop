import { expect, test } from "bun:test";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import { loadImageAddon } from "./image-addon";

class Bitmap {
  closed = 0;
  constructor(public width = 21, public height = 42) {}
  close(): void { this.closed++; }
}

// Real parser, markers and addon storage; only browser rendering/decoding are
// replaced. A three-row image uses the addon's default 7x14 headless cell size.
function fixture(rows = 10) {
  const term = new HeadlessTerminal({ cols: 20, rows, scrollback: 10, allowProposedApi: true });
  Object.assign(term, { onRender: () => ({ dispose() {} }) });
  const addon = loadImageAddon(term as unknown as Terminal);
  const storage = (addon as unknown as { _storage: {
    addImage(image: unknown): void;
    _images: Map<number, { marker: { isDisposed: boolean; line: number }; orig: unknown }>;
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

test("releases a bitmap when text overwrites every image tile", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ImageBitmap: Bitmap } });
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  const { term, addon, storage } = fixture();
  try {
    const image = new Bitmap();
    storage.addImage(image);
    const marker = storage._images.values().next().value!.marker;
    expect(marker.isDisposed).toBe(false);

    await new Promise<void>(resolve => term.write("\x1b[3;1Hghi", resolve));
    expect(storage._images.size).toBe(1);
    expect(image.closed).toBe(0);

    await new Promise<void>(resolve => term.write("\x1b[1;1Habc\x1b[2;1Hdef", resolve));

    expect(marker.isDisposed).toBe(true);
    expect(storage._images.size).toBe(0);
    expect(image.closed).toBe(1);
    storage.reset();
    addon.dispose();
    expect(image.closed).toBe(1);
  } finally {
    addon.dispose();
    term.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousBitmap) Object.defineProperty(globalThis, "ImageBitmap", previousBitmap);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
});

test("retains image pixels in scrollback after its visible tiles are overwritten", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ImageBitmap: Bitmap } });
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  const { term, addon, storage } = fixture();
  try {
    const image = new Bitmap();
    await new Promise<void>(resolve => term.write("\x1b[9;1H", resolve));
    storage.addImage(image);

    await new Promise<void>(resolve => term.write("\n\n\n\n\n\n\n\n", resolve));
    const marker = storage._images.values().next().value!.marker;
    // Verify that the image marker remains in the viewport while its first row is in scrollback.
    const terminalInternals = term as unknown as { _core: { buffers: { normal: { ybase: number } } } };
    const normal = terminalInternals._core.buffers.normal;
    expect(normal.ybase).toBeGreaterThan(8);
    expect(marker.line).toBeGreaterThanOrEqual(normal.ybase);
    await new Promise<void>(resolve => term.write("\x1b[1;1Habc\x1b[2;1Hdef", resolve));

    expect(storage._images.size).toBe(1);
    expect(image.closed).toBe(0);
  } finally {
    addon.dispose();
    term.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousBitmap) Object.defineProperty(globalThis, "ImageBitmap", previousBitmap);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
});

test("reclaims overwritten images before cache eviction within one parser write", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ImageBitmap: Bitmap } });
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  const { term, addon, storage } = fixture(25);
  const transientImages: Bitmap[] = [];
  const insertion = term.parser.registerCsiHandler({ final: "z" }, () => {
    const image = new Bitmap(475, 70);
    transientImages.push(image);
    storage.addImage(image);
    return true;
  });
  try {
    addon.storageLimit = 0.5;
    await new Promise<void>(resolve => term.write("\x1b[1;1H", resolve));
    const staticImage = new Bitmap(475, 70);
    storage.addImage(staticImage);

    let data = "";
    for (let i = 0; i < 12; i++) {
      for (let row = 13; row <= 17; row++) data += `\x1b[${row};1H\x1b[2K`;
      data += "\x1b[13;1H\x1b[z";
    }
    await new Promise<void>(resolve => term.write(data, resolve));

    expect(storage._images.size).toBe(2);
    expect(staticImage.closed).toBe(0);
    expect(transientImages[transientImages.length - 1]!.closed).toBe(0);
    expect([...storage._images.values()].some(spec => spec.orig === staticImage)).toBe(true);
    expect([...storage._images.values()].some(spec => spec.orig === transientImages[transientImages.length - 1])).toBe(true);
    for (const image of transientImages.slice(0, -1)) expect(image.closed).toBe(1);
  } finally {
    insertion.dispose();
    addon.dispose();
    term.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousBitmap) Object.defineProperty(globalThis, "ImageBitmap", previousBitmap);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
});
