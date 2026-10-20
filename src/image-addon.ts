import { ImageAddon } from "@xterm/addon-image";
import type { Terminal } from "@xterm/xterm";

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
