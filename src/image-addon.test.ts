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
  const addonInternals = addon as unknown as { _storage: { addImage(image: unknown): void } };
  const storage = addonInternals._storage;
  return { term, addon, storage };
}

for (const action of ["reset", "dispose"] as const) {
  test(`closes a bitmap when ${action} precedes deferred marker reconciliation`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ImageBitmap: Bitmap,
        document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
      },
    });
    Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
    const { term, addon, storage } = fixture();
    try {
      const image = new Bitmap();
      storage.addImage(image);
      expect(addon.getImageAtBufferCell(0, 0)).toBeTruthy();
      let ran = false;
      const handler = term.parser.registerCsiHandler({ final: "z" }, () => {
        // This runs inside the same parser batch, before onWriteParsed.
        expect(addon.getImageAtBufferCell(0, 0)).toBeTruthy();
        if (action === "reset") addon.reset();
        else addon.dispose();
        ran = true;
        return true;
      });
      await new Promise<void>(resolve => term.write("\x1b[3;1H\x1b[M\x1b[z", resolve));
      expect(ran).toBe(true);
      expect(addon.getImageAtBufferCell(0, 0)).toBeUndefined();
      expect(image.closed).toBe(1);
      addon.reset();
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
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ImageBitmap: Bitmap,
      document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    },
  });
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  const { term, addon, storage } = fixture();
  try {
    const image = new Bitmap();
    storage.addImage(image);
    expect(addon.getImageAtBufferCell(0, 0)).toBeTruthy();
    expect(addon.getImageAtBufferCell(0, 1)).toBeTruthy();
    expect(addon.getImageAtBufferCell(0, 2)).toBeTruthy();

    await new Promise<void>(resolve => term.write("\x1b[3;1Hghi", resolve));
    expect(addon.getImageAtBufferCell(0, 0)).toBeTruthy();
    expect(addon.getImageAtBufferCell(0, 1)).toBeTruthy();
    expect(addon.getImageAtBufferCell(0, 2)).toBeUndefined();
    expect(image.closed).toBe(0);

    await new Promise<void>(resolve => term.write("\x1b[1;1Habc\x1b[2;1Hdef", resolve));

    expect(addon.getImageAtBufferCell(0, 0)).toBeUndefined();
    expect(addon.getImageAtBufferCell(0, 1)).toBeUndefined();
    expect(addon.getImageAtBufferCell(0, 2)).toBeUndefined();
    expect(image.closed).toBe(1);
    addon.reset();
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
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ImageBitmap: Bitmap,
      document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    },
  });
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  const { term, addon, storage } = fixture();
  try {
    const image = new Bitmap();
    await new Promise<void>(resolve => term.write("\x1b[9;1H", resolve));
    storage.addImage(image);

    await new Promise<void>(resolve => term.write("\n\n\n\n\n\n\n\n", resolve));
    expect(term.buffer.active.viewportY).toBeGreaterThan(8);
    expect(addon.getImageAtBufferCell(0, 8)).toBeTruthy();
    await new Promise<void>(resolve => term.write("\x1b[1;1Habc\x1b[2;1Hdef", resolve));

    expect(addon.getImageAtBufferCell(0, 8)).toBeTruthy();
    expect(image.closed).toBe(0);
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

test("reclaims overwritten images before cache eviction within one parser write", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ImageBitmap: Bitmap,
      document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    },
  });
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

    expect(addon.getImageAtBufferCell(0, 0)).toBeTruthy();
    expect(addon.getImageAtBufferCell(0, 13)).toBeTruthy();
    expect(staticImage.closed).toBe(0);
    expect(transientImages.at(-1)?.closed).toBe(0);
    for (const image of transientImages.slice(0, -1)) expect(image.closed).toBe(1);

    addon.dispose();
    expect([staticImage, ...transientImages].map(image => image.closed)).toEqual(
      Array.from({ length: transientImages.length + 1 }, () => 1),
    );
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
