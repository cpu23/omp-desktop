import { describe, expect, test } from "bun:test";
import { imageType } from "@xterm/addon-image/src/IIPMetrics";

// RIFF headers isolate the addon's format/size gate, before browser decoding.
function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
  const data = new Uint8Array(30);
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, 22, true);
  data.set(new TextEncoder().encode(`WEBP${kind}`), 8);
  view.setUint32(16, 10, true);
  if (kind === "VP8 ") {
    data.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else if (kind === "VP8L") {
    data[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    const w = width - 1;
    const h = height - 1;
    data.set([w & 255, (w >>> 8) & 255, w >>> 16, h & 255, (h >>> 8) & 255, h >>> 16], 24);
  }
  return data;
}

describe("inline WebP image metrics", () => {
  for (const kind of ["VP8 ", "VP8L", "VP8X"] as const) {
    test(`recognizes ${kind} dimensions instead of silently discarding the image`, () => {
      expect(imageType(webp(kind, 1280, 720))).toEqual({ mime: "image/webp", width: 1280, height: 720 });
    });

    test(`rejects truncated ${kind} chunks without reading past the payload`, () => {
      const data = webp(kind, 1280, 720);
      for (let length = 0; length < data.length; length++) {
        expect(imageType(data.slice(0, length)).mime).toBe("unsupported");
      }
      new DataView(data.buffer).setUint32(16, 0xffffffff, true);
      expect(imageType(data).mime).toBe("unsupported");
    });
  }

  test("keeps full extended canvas dimensions for the decoder's pixel-limit check", () => {
    expect(imageType(webp("VP8X", 0x1000000, 0x1000000))).toEqual({
      mime: "image/webp", width: 0x1000000, height: 0x1000000,
    });
  });

  test("rejects invalid frame signatures and zero-sized lossy frames", () => {
    const lossy = webp("VP8 ", 1280, 720);
    lossy[23] = 0;
    expect(imageType(lossy).mime).toBe("unsupported");
    const lossless = webp("VP8L", 1280, 720);
    lossless[20] = 0;
    expect(imageType(lossless).mime).toBe("unsupported");
    expect(imageType(webp("VP8 ", 0, 720)).mime).toBe("unsupported");
  });
});
