import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

type PreparedAsset = {
  bytes: Uint8Array<ArrayBuffer>;
  gzip?: Uint8Array<ArrayBuffer>;
  type: string;
  etag: string;
  gzipEtag?: string;
  version: string;
  immutablePath: boolean;
};

type WebAssets = {
  build: string;
  response(request: Request): Promise<Response | undefined>;
};

const MAX_PUBLIC_ASSET_BYTES = 8 * 1024 * 1024;
const FONT_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ...FONT_TYPES,
};

function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function encodingQuality(header: string | null, encoding: string): number {
  if (!header) return encoding === "identity" ? 1 : 0;
  let explicit: number | undefined;
  let wildcard: number | undefined;
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);
      if (match) quality = Number(match[1]);
    }
    if (name === encoding) explicit = quality;
    else if (name === "*") wildcard = quality;
  }
  if (explicit !== undefined) return explicit;
  if (encoding === "identity") return wildcard === 0 ? 0 : 1;
  return wildcard ?? 0;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value.replace(/^W\//, "") === etag;
  });
}

export async function createWebAssets(root: string): Promise<WebAssets> {
  const projectRoot = resolve(root);
  const publicRoot = join(projectRoot, "public");
  const routes = new Map<string, PreparedAsset>();

  const prepare = (bytes: Uint8Array<ArrayBuffer>, type: string, immutablePath = false): PreparedAsset => {
    const version = createHash("sha256").update(bytes).digest("hex");
    const etag = `"${version}"`;
    const compressible = bytes.byteLength >= 512 && (
      type.startsWith("text/") ||
      type.startsWith("application/javascript") ||
      type.startsWith("application/json") ||
      type === "image/svg+xml"
    );
    const gzip = compressible ? gzipSync(bytes) : undefined;
    return {
      bytes,
      ...(gzip ? { gzip, gzipEtag: `"${createHash("sha256").update(gzip).digest("hex")}"` } : {}),
      type,
      etag,
      version,
      immutablePath,
    };
  };

  const publicFiles = await readdir(publicRoot, { withFileTypes: true });
  for (const entry of publicFiles) {
    if (entry.name === "index.html" || entry.name === "styles.css" || entry.name === "fonts" || !entry.isFile()) continue;
    const path = `/${entry.name}`;
    const absolute = join(publicRoot, entry.name);
    const stat = await lstat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_PUBLIC_ASSET_BYTES) continue;
    routes.set(path, prepare(await readFile(absolute), mimeType(path)));
  }

  const fontRoot = join(publicRoot, "fonts");
  const fonts = await readdir(fontRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of fonts) {
    const extension = extname(entry.name).toLowerCase();
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+$/.test(entry.name) || !(extension in FONT_TYPES)) continue;
    const path = `/fonts/${entry.name}`;
    const absolute = join(fontRoot, entry.name);
    const stat = await lstat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_PUBLIC_ASSET_BYTES) continue;
    routes.set(path, prepare(await readFile(absolute), FONT_TYPES[extension]));
  }

  const stylesPath = join(publicRoot, "styles.css");
  const styles = prepare(await readFile(stylesPath), "text/css; charset=utf-8");
  routes.set("/styles.css", styles);
  const stylesVersionedPath = `/assets/styles-${styles.version}.css`;
  routes.set(stylesVersionedPath, { ...styles, immutablePath: true });

  const xtermPath = join(projectRoot, "node_modules", "@xterm", "xterm", "css", "xterm.css");
  const xtermCss = prepare(await readFile(xtermPath), "text/css; charset=utf-8");
  routes.set("/xterm.css", xtermCss);
  const xtermVersionedPath = `/assets/xterm-${xtermCss.version}.css`;
  routes.set(xtermVersionedPath, { ...xtermCss, immutablePath: true });

  const result = await Bun.build({
    entrypoints: [join(projectRoot, "src", "client.ts")],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    sourcemap: "none",
    publicPath: "/assets/",
    naming: {
      entry: "[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
  });
  if (!result.success) throw new Error(`Desktop client bundle failed: ${result.logs.map((log) => log.message).join("\n")}`);

  let client: PreparedAsset | undefined;
  for (const output of result.outputs) {
    const name = basename(output.path);
    if (name.endsWith(".map")) continue;
    const bytes = new Uint8Array(await output.arrayBuffer());
    const asset = prepare(bytes, mimeType(name), /-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(name));
    routes.set(`/assets/${name}`, asset);
    if (output.kind === "entry-point" && name.endsWith(".js")) client = asset;
  }
  if (!client) throw new Error("Desktop client bundle did not emit its JavaScript entry point");

  const clientPath = `/assets/client-${client.version}.js`;
  routes.set(clientPath, { ...client, immutablePath: true });
  routes.set("/client.js", { ...client, immutablePath: false });

  const originalHtml = await readFile(join(publicRoot, "index.html"), "utf8");
  const html = originalHtml
    .replace(/href=(["'])\/xterm\.css(?:\?[^"']*)?\1/g, `href="${xtermVersionedPath}"`)
    .replace(/href=(["'])\/styles\.css(?:\?[^"']*)?\1/g, `href="${stylesVersionedPath}"`)
    .replace(/src=(["'])\/client\.js(?:\?[^"']*)?\1/g, `src="${clientPath}"`);
  routes.set("/", prepare(new TextEncoder().encode(html), "text/html; charset=utf-8"));

  const buildHash = createHash("sha256");
  for (const [path, asset] of [...routes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    buildHash.update(path).update(asset.bytes);
  }
  const build = buildHash.digest("hex").slice(0, 20);

  return {
    build,
    async response(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname.startsWith("/ws/"))
        return undefined;

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes(".."))
        return new Response("not found", { status: 404 });

      const asset = routes.get(pathname);
      if (!asset) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });

      const gzipQuality = encodingQuality(request.headers.get("accept-encoding"), "gzip");
      const identityQuality = encodingQuality(request.headers.get("accept-encoding"), "identity");
      const useGzip = !!asset.gzip && gzipQuality > 0 && gzipQuality >= identityQuality;
      if (!useGzip && identityQuality <= 0)
        return new Response("not acceptable", { status: 406, headers: { vary: "Accept-Encoding" } });

      const etag = useGzip ? asset.gzipEtag! : asset.etag;
      const requestedVersions = url.searchParams.getAll("v");
      const versionMatches = requestedVersions.length === 1 && requestedVersions[0] === asset.version;
      const matchingHashedPath = asset.immutablePath && requestedVersions.length === 0;
      const cacheControl = !asset.type.startsWith("text/html") && (matchingHashedPath || versionMatches)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      const headers = new Headers({
        "content-type": asset.type,
        "cache-control": cacheControl,
        etag,
        vary: "Accept-Encoding",
      });
      if (useGzip) headers.set("content-encoding", "gzip");
      const body = useGzip ? asset.gzip! : asset.bytes;
      headers.set("content-length", String(body.byteLength));
      if (etagMatches(request.headers.get("if-none-match"), etag)) {
        headers.delete("content-length");
        return new Response(null, { status: 304, headers });
      }
      return new Response(request.method === "HEAD" ? null : body, { headers });
    },
  };
}
