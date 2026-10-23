import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const representations = new Map<string, { gzip: Uint8Array<ArrayBuffer>; bytes: number }>();
let cacheBytes = 0;

/** Polling responses stay private and revalidate without retransferring unchanged data. */
export function conditionalJson(request: Request, value: unknown): Response {
  const text = JSON.stringify(value);
  const hash = createHash("sha256").update(text).digest("hex");
  const etag = `W/"${hash}"`;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-cache",
    etag,
    vary: "Accept-Encoding",
  });
  const validators = request.headers.get("if-none-match")?.split(",");
  if (validators?.some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag.slice(2);
  })) return new Response(null, { status: 304, headers });

  let gzipQuality: number | undefined;
  let wildcardQuality = 0;
  for (const entry of request.headers.get("accept-encoding")?.split(",") ?? []) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(.*)$/.exec(parameter.trim());
      if (match) quality = Number(match[1]);
    }
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) quality = 0;
    if (name === "gzip") gzipQuality = quality;
    else if (name === "*") wildcardQuality = quality;
  }
  const acceptsGzip = (gzipQuality ?? wildcardQuality) > 0;
  if (!acceptsGzip || text.length < 1024) return new Response(text, { headers });

  let cached = representations.get(hash);
  if (cached) {
    representations.delete(hash);
    representations.set(hash, cached);
  } else {
    const gzip = gzipSync(text);
    cached = { gzip, bytes: gzip.byteLength };
    if (cached.bytes <= MAX_CACHE_BYTES) {
      while (cacheBytes + cached.bytes > MAX_CACHE_BYTES || representations.size >= MAX_CACHE_ENTRIES) {
        const oldest = representations.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= representations.get(oldest)!.bytes;
        representations.delete(oldest);
      }
      representations.set(hash, cached);
      cacheBytes += cached.bytes;
    }
  }
  headers.set("content-encoding", "gzip");
  return new Response(cached.gzip, { headers });
}

export class BodyLimitError extends Error {}

/** Bound allocation even when the sender omits Content-Length. */
export async function readLimitedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new BodyLimitError("request body too large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new BodyLimitError("request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}
