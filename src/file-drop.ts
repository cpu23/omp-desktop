const NATIVE_FILE_DROP_EVENT = "omp-desktop-file-drop";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type FileDropOptions = {
  /** Receives original filesystem paths, or paths returned by `upload`. */
  onPaths: (paths: readonly string[]) => void;
  /** Existing image-paste upload path; called only when a dropped image has no path. */
  upload: (file: File) => Promise<string | null>;
};

type NativeFileDrop = {
  paths: unknown[];
  x: number;
  y: number;
};

/**
 * Wires browser file drops and the native shell event to one pane. Native drops
 * are hit-tested at their CSS viewport position so each path goes to its target
 * pane, even though the shell does not deliver the OS drop as a DOM `drop` event.
 */
export function wireFileDrop(element: HTMLElement, options: FileDropOptions): () => void {
  const onNativeDrop = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isNativeFileDrop(detail)) return;
    const paths = safePaths(detail.paths);
    if (paths.length === 0) return;

    const target = document.elementFromPoint(detail.x, detail.y);
    if (target && element.contains(target)) options.onPaths(paths);
  };

  const onBrowserDrop = (event: DragEvent): void => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const files = Array.from(transfer.files);
    const uriPaths = pathsFromUriList(transfer, files.length || null);
    if (files.length === 0) {
      if (!uriPaths?.length) return;
      event.preventDefault();
      const paths = safePaths(uriPaths);
      if (paths.length > 0) options.onPaths(paths);
      return;
    }

    event.preventDefault();
    void resolveDroppedPaths(files, uriPaths, options).then((paths) => {
      if (paths.length > 0) options.onPaths(paths);
    });
  };

  window.addEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop);
  element.addEventListener("drop", onBrowserDrop);
  return () => {
    window.removeEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop);
    element.removeEventListener("drop", onBrowserDrop);
  };
}

/** Sends shell-quoted paths as plain terminal input; no newline is ever sent. */
export function insertFilePaths(socket: WebSocket | null, paths: readonly string[]): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const input = safePaths(paths).map((path) => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  if (!input) return false;

  try {
    socket.send(JSON.stringify({ type: "input", data: `${input} ` }));
    return true;
  } catch {
    return false;
  }
}

async function resolveDroppedPaths(
  files: File[],
  uriPaths: string[] | null,
  options: FileDropOptions,
): Promise<string[]> {
  const results = await Promise.all(files.map(async (file, index) => {
    const path = originalFilePath(file) ?? uriPaths?.[index];
    if (path) return path;
    // /api/paste stores images only; other browser File objects have no usable
    // original path and cannot be turned into a filesystem path without reading
    // their bytes into a different upload endpoint.
    if (!file.type.toLowerCase().startsWith("image/")) return null;
    try {
      return await options.upload(file);
    } catch {
      return null;
    }
  }));
  return safePaths(results.filter((path): path is string => typeof path === "string"));
}

function originalFilePath(file: File): string | null {
  try {
    const path = (file as File & { path?: unknown }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

function pathsFromUriList(transfer: DataTransfer, expectedCount: number | null): string[] | null {
  let value: string;
  try {
    value = transfer.getData("text/uri-list");
  } catch {
    return null;
  }
  const uris = value.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (uris.length === 0 || (expectedCount !== null && uris.length !== expectedCount)) return null;

  const paths = uris.map(fileUrlPath);
  return paths.every((path): path is string => path !== null) ? paths : null;
}

function fileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    const localPath = url.hostname && url.hostname.toLowerCase() !== "localhost"
      ? `//${url.hostname}${path}`
      : /^\/[a-zA-Z]:\//.test(path)
        ? path.slice(1)
        : path;
    return localPath.length > 0 ? localPath : null;
  } catch {
    return null;
  }
}

function isNativeFileDrop(value: unknown): value is NativeFileDrop {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Partial<NativeFileDrop>;
  return Array.isArray(detail.paths) && typeof detail.x === "number" && Number.isFinite(detail.x)
    && typeof detail.y === "number" && Number.isFinite(detail.y);
}

function safePaths(value: readonly unknown[]): string[] {
  return value.filter((path): path is string => typeof path === "string" && isSafePath(path));
}

function isSafePath(path: string): boolean {
  return path.length > 0 && !CONTROL_CHARACTERS.test(path);
}

