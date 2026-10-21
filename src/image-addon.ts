import { ImageAddon } from "@xterm/addon-image";
import type { IMarker, Terminal } from "@xterm/xterm";

type ImageHandler = {
  start(): void;
  put(data: Uint32Array, start: number, end: number): void;
  end(success: boolean): boolean | Promise<boolean>;
  reset(): void;
};

/** addon-image 0.9 requires the exact decoded size although iTerm2 makes
 * `size` optional. Buffer only size-less inline images, within the addon's
 * existing limit, then supply the missing size before invoking its decoder.
 * Explicitly sized images retain the original streaming path. */
export function loadImageAddon(term: Terminal): ImageAddon {
  const addon = new ImageAddon();
  term.loadAddon(addon);
  retainPartiallyDeletedImages(term, addon);
  const internals = addon as unknown as {
    _opts: { iipSizeLimit: number };
    _handlers: Map<string, ImageHandler>;
  };
  const handler = internals._handlers.get("iip")!;
  const start = handler.start.bind(handler);
  const put = handler.put.bind(handler);
  const end = handler.end.bind(handler);
  const reset = handler.reset.bind(handler);
  const encodedLimit = Math.ceil(internals._opts.iipSizeLimit / 3) * 4;
  let mode: "header" | "buffer" | "pass" | "abort" = "header";
  let header: number[] = [];
  let headerText = "";
  let chunks: Uint8Array[] = [];
  let length = 0;
  let previous = 0;
  let last = 0;

  function clear(): void {
    mode = "header";
    header = [];
    headerText = "";
    chunks = [];
    length = 0;
    previous = 0;
    last = 0;
  }

  handler.start = () => {
    clear();
    start();
  };
  handler.reset = () => {
    clear();
    reset();
  };
  handler.put = (data, from, to) => {
    if (mode === "abort") return;
    if (mode === "header") {
      while (from < to) {
        const code = data[from++];
        header.push(code);
        if (code === 0x3a) {
          headerText = String.fromCodePoint(...header.slice(0, -1));
          const fields = headerText.startsWith("File=") ? headerText.slice(5).split(";") : [];
          mode = fields.includes("inline=1") && !fields.some((field) => field.startsWith("size="))
            ? "buffer" : "pass";
          break;
        }
        // Existing header fields are limited to 1024 codepoints apiece. Stop
        // buffering abnormally large headers and let the original parser decide.
        if (header.length >= 16_384) {
          mode = "pass";
          break;
        }
      }
      if (mode === "header") return;
      if (mode === "pass") {
        put(Uint32Array.from(header), 0, header.length);
        header = [];
      }
    }
    if (mode === "pass") {
      if (from < to) put(data, from, to);
      return;
    }
    if (length + to - from > encodedLimit) {
      mode = "abort";
      chunks = [];
      return;
    }
    if (from === to) return;
    const chunk = new Uint8Array(to - from);
    for (let i = from; i < to; i++) {
      const code = data[i];
      if (code > 0x7f) {
        mode = "abort";
        chunks = [];
        return;
      }
      chunk[i - from] = code;
      previous = last;
      last = code;
    }
    chunks.push(chunk);
    length += chunk.length;
  };
  handler.end = (success) => {
    try {
      if (mode === "abort") return end(false);
      if (mode === "header") {
        put(Uint32Array.from(header), 0, header.length);
      } else if (mode === "buffer" && success) {
        const size = (length / 4) * 3 - (last === 0x3d ? 1 : 0) - (previous === 0x3d ? 1 : 0);
        if (!Number.isInteger(size) || size <= 0 || size > internals._opts.iipSizeLimit) return end(false);
        const normalized = Uint32Array.from(`${headerText};size=${size}:`, (char) => char.charCodeAt(0));
        put(normalized, 0, normalized.length);
        for (const chunk of chunks) {
          const points = Uint32Array.from(chunk);
          put(points, 0, points.length);
        }
      }
      return end(success);
    } finally {
      clear();
    }
  };
  return addon;
}

/** addon-image 0.9 anchors ownership to the last image row. Deleting that row
 * must not discard pixels still referenced by earlier rows. Check after parsing,
 * when buffer splices have finished; explicit cache eviction remains immediate.
 * These private hooks are pinned to addon-image 0.9 / xterm 6. */
function retainPartiallyDeletedImages(term: Terminal, addon: ImageAddon): void {
  type Spec = { marker?: IMarker; tileCount: number; bufferType: string };
  // The dependency does not expose its storage lifecycle through its public API.
  const imageInternals = addon as unknown as {
    _storage: {
      _images: Map<number, Spec>;
      _delImg(id: number): void;
      _evictOldest(room: number): number;
      reset(): void;
    };
  };
  const storage = imageInternals._storage;
  const pending = new Set<number>();
  const remove = storage._delImg.bind(storage);
  const evict = storage._evictOldest.bind(storage);
  const reset = storage.reset.bind(storage);
  let forceRemoval = false;
  storage._delImg = (id) => {
    const spec = storage._images.get(id);
    if (!forceRemoval && spec?.marker?.isDisposed && spec.tileCount > 0 && spec.bufferType === "normal") {
      pending.add(id);
      return;
    }
    pending.delete(id);
    remove(id);
  };
  storage._evictOldest = (room) => {
    forceRemoval = true;
    try { return evict(room); } finally { forceRemoval = false; }
  };
  storage.reset = () => {
    forceRemoval = true;
    try {
      // Disposed markers do not fire again during reset. Release deferred
      // bitmaps before upstream reset clears the image map that owns them.
      for (const id of pending) remove(id);
      reset();
    } finally { pending.clear(); forceRemoval = false; }
  };
  const parsed = term.onWriteParsed(() => {
    if (!pending.size) return;
    // xterm's public buffer API omits image-tile extended attributes.
    const terminalInternals = term as unknown as {
      _core: { buffers: { normal: {
        ybase: number; y: number;
        lines: { length: number; get(row: number): {
          getBg(col: number): number;
          _extendedAttrs: Record<number, { imageId?: number }>;
        } };
      } } };
    };
    const buffer = terminalInternals._core.buffers.normal;
    for (const id of pending) {
      if (term.buffer.active.type !== "normal") continue;
      pending.delete(id);
      const spec = storage._images.get(id);
      if (!spec) continue;
      let lastRow = -1;
      for (let row = buffer.lines.length - 1; row >= 0 && lastRow < 0; row--) {
        const line = buffer.lines.get(row);
        for (const col in line._extendedAttrs) {
          // xterm BgFlags.HAS_EXTENDED: stale attribute entries can outlive cells.
          if ((line.getBg(Number(col)) & 0x10000000) && line._extendedAttrs[col].imageId === id) {
            lastRow = row;
            break;
          }
        }
      }
      if (lastRow < 0) {
        remove(id);
        continue;
      }
      const marker = term.registerMarker(lastRow - buffer.ybase - buffer.y);
      if (!marker) {
        remove(id);
        continue;
      }
      spec.marker = marker;
      marker.onDispose(() => storage._delImg(id));
    }
  });
  const dispose = addon.dispose.bind(addon);
  addon.dispose = () => {
    parsed.dispose();
    storage.reset();
    dispose();
  };
}
