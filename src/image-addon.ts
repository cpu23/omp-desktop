import { ImageAddon } from "@xterm/addon-image";
import { repairImageCanvasRows } from "./image-renderer";
import { clipImageReservations } from "./image-reservation";
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
  repairImageCanvasRows(addon);
  clipImageReservations(term, addon);
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
 * must not discard pixels still referenced by earlier rows. Reconcile after
 * parsing so erased tiles release storage even when their marker survives.
 * Explicit cache eviction remains immediate. These hooks are pinned to
 * addon-image 0.9 / xterm 6. */
function retainPartiallyDeletedImages(term: Terminal, addon: ImageAddon): void {
  type Spec = { marker?: IMarker; tileCount: number; bufferType: string };
  // The dependency does not expose its storage lifecycle through its public API.
  const imageInternals = addon as unknown as {
    _storage: {
      _images: Map<number, Spec>;
      _delImg(id: number): void;
      _evictOldest(room: number): number;
      _pixelLimit: number;
      _getStoredPixels(): number;
      reset(): void;
    };
  };
  const storage = imageInternals._storage;
  const pending = new Set<number>();
  const remove = storage._delImg.bind(storage);
  const evict = storage._evictOldest.bind(storage);
  const reset = storage.reset.bind(storage);
  let forceRemoval = false;
  let reanchoringId: number | undefined;
  storage._delImg = (id) => {
    if (reanchoringId === id) return;
    const spec = storage._images.get(id);
    if (!forceRemoval && spec?.marker?.isDisposed && spec.tileCount > 0 && spec.bufferType === "normal") {
      pending.add(id);
      return;
    }
    pending.delete(id);
    remove(id);
  };
  storage._evictOldest = (room) => {
    const wasForced = forceRemoval;
    forceRemoval = true;
    try {
      // A write can erase old image cells and add replacements before parsed reconciliation.
      if (storage._pixelLimit < storage._getStoredPixels() + room) pruneUnreferencedImages();
      return evict(room);
    } finally { forceRemoval = wasForced; }
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
  type BufferExt = {
    ybase: number;
    y: number;
    lines: { length: number; get(row: number): {
      getBg(col: number): number;
      _extendedAttrs: Record<number, { imageId?: number } | undefined>;
    } | undefined };
  };
  const terminalInternals = term as unknown as {
    _core: { buffers: { normal: BufferExt; alt: BufferExt } };
  };
  const referenced = new Set<number>();
  const candidates = new Set<number>();
  const lastRows = new Map<number, number>();
  function collectReferencedImages(buffer: BufferExt, start: number, end: number): void {
    for (let row = Math.max(0, start); row < Math.min(end, buffer.lines.length); row++) {
      const line = buffer.lines.get(row);
      if (!line) continue;
      for (const col in line._extendedAttrs) {
        if (!(line.getBg(Number(col)) & 0x10000000)) continue;
        const id = line._extendedAttrs[col]?.imageId;
        if (id === undefined || !storage._images.has(id)) continue;
        referenced.add(id);
        if (pending.has(id) || candidates.has(id)) lastRows.set(id, row);
      }
    }
  }
  function reanchor(id: number, spec: Spec, row: number, buffer: BufferExt): boolean {
    const marker = term.registerMarker(row - buffer.ybase - buffer.y);
    if (!marker) return false;
    reanchoringId = id;
    try { spec.marker?.dispose(); } finally { reanchoringId = undefined; }
    spec.marker = marker;
    marker.onDispose(() => storage._delImg(id));
    return true;
  }
  function discard(id: number, spec: Spec): void {
    const wasForced = forceRemoval;
    forceRemoval = true;
    try {
      spec.marker?.dispose();
      remove(id);
      pending.delete(id);
    } finally { forceRemoval = wasForced; }
  }
  function pruneUnreferencedImages(): void {
    referenced.clear();
    candidates.clear();
    lastRows.clear();
    const buffers = terminalInternals._core.buffers;
    collectReferencedImages(buffers.normal, 0, buffers.normal.lines.length);
    collectReferencedImages(buffers.alt, 0, buffers.alt.lines.length);
    for (const [id, spec] of storage._images) {
      if (!referenced.has(id)) discard(id, spec);
    }
    referenced.clear();
    lastRows.clear();
  }
  const parsed = term.onWriteParsed(() => {
    if (!pending.size && !storage._images.size) return;
    const activeType = term.buffer.active.type;
    const buffer = activeType === "normal"
      ? terminalInternals._core.buffers.normal
      : terminalInternals._core.buffers.alt;
    referenced.clear();
    lastRows.clear();
    let scannedHistory = false;
    if (activeType === "normal" && pending.size) {
      collectReferencedImages(buffer, 0, buffer.lines.length);
      for (const id of pending) {
        pending.delete(id);
        const spec = storage._images.get(id);
        if (!spec) continue;
        const lastRow = lastRows.get(id);
        if (lastRow === undefined || !reanchor(id, spec, lastRow, buffer)) {
          discard(id, spec);
        }
      }
      scannedHistory = true;
    } else {
      const start = activeType === "normal" ? buffer.ybase : 0;
      collectReferencedImages(buffer, start, start + term.rows);
    }

    for (const [id, spec] of storage._images) {
      if (spec.bufferType !== activeType || referenced.has(id)) continue;
      if (activeType === "normal" && spec.marker && !spec.marker.isDisposed && spec.marker.line < buffer.ybase) continue;
      candidates.add(id);
    }
    if (!scannedHistory && activeType === "normal" && candidates.size) {
      lastRows.clear();
      collectReferencedImages(buffer, 0, buffer.ybase);
      scannedHistory = true;
      for (const id of candidates) {
        const spec = storage._images.get(id);
        if (!spec) continue;
        const lastRow = lastRows.get(id);
        if (lastRow === undefined) {
          discard(id, spec);
        } else {
          reanchor(id, spec, lastRow, buffer);
        }
      }
    }
    if (scannedHistory || activeType === "alternate") {
      for (const [id, spec] of storage._images) {
        if (spec.bufferType === activeType && !referenced.has(id)) discard(id, spec);
      }
    }
    candidates.clear();
  });
  const dispose = addon.dispose.bind(addon);
  addon.dispose = () => {
    parsed.dispose();
    storage.reset();
    dispose();
  };
}
