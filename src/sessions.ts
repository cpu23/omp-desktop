/**
 * Index over omp's on-disk session store, used by the sidebar's recent-session
 * list.
 *
 * Layout: `<root>/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, exactly one
 * directory level below the root. Sibling directories with the same
 * timestamp_uuid name are transcript attachments and are ignored.
 *
 * "Last used" comes from the transcript's conversation, not its mtime: every
 * message carries an ISO timestamp, while resuming a session appends only
 * bookkeeping events (`custom`/`session_exit`) that would otherwise make an old
 * chat look freshly used. The last user/assistant message is found by scanning
 * backwards from EOF; a transcript without conversation falls back to stable
 * creation-time sources (the `session` header, the filename timestamp, then
 * birthtime) so a touch or clock skew can never make it look newly used.
 *
 * Listing is a stat-then-read scan: collect and stat every `.jsonl` file, derive
 * each file's activity (with its header prefix), sort by activity, filter, apply
 * the limit, and only then read the survivors' full-file cost sums. Transcripts
 * reach far beyond 8 KiB and this is polled per sidebar refresh, so per-file
 * metadata/cost results are memoized by file identity, timestamps, and size in
 * byte-bounded caches. Every file is considered because mtime cannot bound
 * activity: imported files and clock skew can write messages newer than the
 * file's last touch, and pruning by mtime would hide such (or merely old-mtime
 * matching) sessions.
 *
 * Robustness: a missing/nonexistent root, unreadable file or directory, or a
 * truncated/malformed JSONL line must never abort the listing. The header is
 * parsed best-effort and missing fields fall back to filename/dirname decoding;
 * the backward activity scan skips unparseable lines and retains each split
 * line's pieces as zero-copy fragments until the owning chunk completes it.
 * Activity read failures propagate to the caller as an uncached per-listing
 * fallback, so a transient error is never memoized as "no conversation".
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isRecord } from "./guards";

export type SessionSummary = {
  /** Session uuid (from the `session` event; filename suffix if absent). */
  id: string;
  /** Absolute path of the `.jsonl` transcript. */
  path: string;
  /** Working directory (from the `session` event, else decoded dir name). */
  cwd: string;
  /** Last title/title_change, else history.db, else firstPrompt, else cwd. */
  title: string;
  /** First user message text, whitespace collapsed and cut to 200 chars. */
  firstPrompt: string | null;
  /**
   * ISO 8601 time of the last user/assistant message, not the file mtime, so
   * merely opening a transcript does not make it recent. Transcripts with no
   * conversation fall back to a stable creation time (header, filename, then
   * birthtime), never the mutable mtime.
   */
  updatedAt: string;
  /** Transcript size in bytes. */
  bytes: number;
  /** Conversation timestamp in ms (stable creation time when there is none), for sorting. */
  activityMs: number;
  /** Sum of every `usage.cost.total` in the transcript, USD; 0 when unpriced. */
  costUsd: number;
};

const HEADER_BYTES = 8 * 1024;
const PROMPT_MAX_CHARS = 200;
const DEFAULT_LIMIT = 60;
const MAX_SESSION_LIMIT = 200;
/** Backwards activity scan step; one chunk covers the tail of almost every transcript. */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Roles that form the conversation; tool results and developer context are machinery, not use. */
const CONVERSATION_ROLES: Record<string, true> = { user: true, assistant: true };
/** Bound directory, stat, summary, and cost work to avoid a poll-sized I/O burst. */
const MAX_CONCURRENT_IO = 8;

/** Memory budget for each metadata/cost memo table; oversized entries are skipped. */
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const COST_CARRY_CHARS = 4096;
const COST_ANCHOR_BYTES = 256;

type CacheState = { bytes: number; weights: Map<unknown, number> };
const cacheStates = new WeakMap<object, CacheState>();

/** Approximate retained bytes; these cache values contain only small metadata objects. */
function approximateCacheBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object" || value === null) return 8;
  if (value instanceof Map) {
    let bytes = 24;
    for (const [key, item] of value) bytes += approximateCacheBytes(key) + approximateCacheBytes(item);
    return bytes;
  }
  if (Array.isArray(value)) {
    return 24 + value.reduce((total, item) => total + approximateCacheBytes(item), 0);
  }
  return 64 + Object.values(value).reduce((total, item) => total + approximateCacheBytes(item), 0);
}

function cacheDelete<K, V>(cache: Map<K, V>, key: K): void {
  const state = cacheStates.get(cache);
  const weight = state?.weights.get(key);
  if (state && weight !== undefined) {
    state.bytes -= weight;
    state.weights.delete(key);
  }
  cache.delete(key);
}

/** Insertion-ordered LRU cache with a per-table byte budget. */
function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  let state = cacheStates.get(cache);
  if (!state) {
    state = { bytes: 0, weights: new Map() };
    cacheStates.set(cache, state);
  }
  cacheDelete(cache, key);
  const weight = 64 + approximateCacheBytes(key) + approximateCacheBytes(value);
  if (weight > CACHE_MAX_BYTES) return;
  while (state.bytes + weight > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheDelete(cache, oldest);
  }
  cache.set(key, value);
  state.weights.set(key, weight);
  state.bytes += weight;
}

/** Refresh an LRU hit without walking its small value to recalculate its weight. */
function cacheTouch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  const state = cacheStates.get(cache);
  if (!state?.weights.has(key)) {
    cacheSet(cache, key, value);
    return;
  }
  cache.delete(key);
  cache.set(key, value);
}

/** Run a collection of I/O tasks with fixed concurrency, preserving input order. */
async function mapConcurrent<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, MAX_CONCURRENT_IO) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

type FileVersion = { mtimeMs: number; bytes: number; ctimeMs: number; ino: number; dev: number };
type SessionFile = FileVersion & { path: string; dir: string; birthtimeMs: number };

function hasSameVersion(cached: FileVersion, file: SessionFile): boolean {
  return (
    cached.mtimeMs === file.mtimeMs &&
    cached.bytes === file.bytes &&
    cached.ctimeMs === file.ctimeMs &&
    cached.ino === file.ino &&
    cached.dev === file.dev
  );
}

/**
 * Usage totals can be scattered throughout a transcript. Keep the scanned byte
 * offset and matcher carry so append-only writes cost only new bytes; replacement,
 * truncation and same-size rewrites with changed metadata are scanned completely
 * again. The warm cache does not reread unchanged versions: an in-place rewrite
 * preserving size, inode and both timestamps is not detectable. Publish full
 * transcript rewrites by atomic replacement, as OMP does.
 */
type CostEntry = FileVersion & {
  costUsd: number;
  pending: string;
  prefix: string;
  tail: string;
};
const costCache = new Map<string, CostEntry>();
const costReadsInFlight = new Map<string, Promise<number>>();

/** Matches a whole usage cost object, so a chunk boundary can never yield a partial number. */
const COST_PATTERN = /"cost":\s*\{[^}]*?"total":\s*([0-9.eE+-]+)\s*\}/g;

function costCacheKey(file: SessionFile): string {
  return JSON.stringify([file.path, file.dev, file.ino, file.bytes, file.mtimeMs, file.ctimeMs]);
}

function consumeCostText(
  pending: string,
  text: string,
  costUsd: number,
): { pending: string; costUsd: number } {
  pending += text;
  let scanned = 0;
  for (const match of pending.matchAll(COST_PATTERN)) {
    const amount = Number(match[1]);
    if (Number.isFinite(amount) && amount > 0) costUsd += amount;
    scanned = (match.index ?? 0) + match[0].length;
  }
  pending = pending.slice(scanned);
  // Keep the established bounded carry for incomplete usage objects/tokens.
  if (pending.length > COST_CARRY_CHARS) pending = pending.slice(-COST_CARRY_CHARS);
  return { pending, costUsd };
}

async function cachedCostAnchorsMatch(file: SessionFile, cached: CostEntry): Promise<boolean> {
  const source = Bun.file(file.path);
  const prefixEnd = Math.min(cached.bytes, COST_ANCHOR_BYTES);
  const tailStart = Math.max(0, cached.bytes - COST_ANCHOR_BYTES);
  const decoder = new TextDecoder("latin1");
  const [prefix, tail] = await Promise.all([
    source.slice(0, prefixEnd).arrayBuffer(),
    source.slice(tailStart, cached.bytes).arrayBuffer(),
  ]);
  return decoder.decode(prefix) === cached.prefix && decoder.decode(tail) === cached.tail;
}

async function scanCost(
  file: SessionFile,
  startOffset: number,
  carry: string,
  initialCost: number,
  initialPrefix: string,
  initialTail: string,
): Promise<CostEntry> {
  const decoder = new TextDecoder("latin1");
  const reader = Bun.file(file.path).slice(startOffset, file.bytes).stream().getReader();
  let pending = carry;
  let costUsd = initialCost;
  let prefix = initialPrefix;
  let tail = initialTail;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    const consumed = consumeCostText(pending, text, costUsd);
    pending = consumed.pending;
    costUsd = consumed.costUsd;
    if (prefix.length < COST_ANCHOR_BYTES) prefix += text.slice(0, COST_ANCHOR_BYTES - prefix.length);
    tail = (tail + text).slice(-COST_ANCHOR_BYTES);
  }
  return {
    mtimeMs: file.mtimeMs,
    bytes: file.bytes,
    ctimeMs: file.ctimeMs,
    ino: file.ino,
    dev: file.dev,
    costUsd,
    pending,
    prefix,
    tail,
  };
}

async function readCostUncached(file: SessionFile): Promise<number> {
  const cached = costCache.get(file.path);
  let startOffset = 0;
  let carry = "";
  let costUsd = 0;
  let prefix = "";
  let tail = "";
  // OMP appends on the same inode; full rewrites publish by atomic replacement.
  // Endpoint anchors detect refills, not arbitrary interior edits followed by growth.
  if (cached && cached.dev === file.dev && cached.ino === file.ino && cached.bytes < file.bytes) {
    try {
      if (await cachedCostAnchorsMatch(file, cached)) {
        startOffset = cached.bytes;
        carry = cached.pending;
        costUsd = cached.costUsd;
        prefix = cached.prefix;
        tail = cached.tail;
      }
    } catch {
      // If the append anchors cannot be checked, recompute from the current file.
    }
  }
  try {
    const next = await scanCost(file, startOffset, carry, costUsd, prefix, tail);
    cacheSet(costCache, file.path, next);
    return next.costUsd;
  } catch {
    // Unreadable files contribute 0 and are retried on the next listing.
    return 0;
  }
}

function readCost(file: SessionFile): Promise<number> {
  const cached = costCache.get(file.path);
  if (cached && hasSameVersion(cached, file)) {
    cacheTouch(costCache, file.path, cached);
    return Promise.resolve(cached.costUsd);
  }
  const key = costCacheKey(file);
  const inFlight = costReadsInFlight.get(key);
  if (inFlight) return inFlight;
  const pending = readCostUncached(file);
  costReadsInFlight.set(key, pending);
  pending.then(
    () => { if (costReadsInFlight.get(key) === pending) costReadsInFlight.delete(key); },
    () => { if (costReadsInFlight.get(key) === pending) costReadsInFlight.delete(key); },
  );
  return pending;
}

/** Everything but cost; costs are summed only for the rows that survive the limit. */
type SessionBase = Omit<SessionSummary, "costUsd">;

/**
 * Last conversation timestamp per transcript, memoized by the same full file
 * version used by the cost cache. `null` means the backwards scan found no
 * conversation, which callers turn into the stable creation-time fallback.
 */
const activityCache = new Map<string, FileVersion & { activityMs: number | null }>();

async function readActivity(file: SessionFile): Promise<number | null> {
  const cached = activityCache.get(file.path);
  if (cached && hasSameVersion(cached, file)) {
    cacheTouch(activityCache, file.path, cached);
    return cached.activityMs;
  }
  // A read failure propagates (never memoized) so callers fall back for this
  // listing only and the next poll retries; `null` means "no conversation".
  const activityMs = await scanActivity(file);
  cacheSet(activityCache, file.path, {
    mtimeMs: file.mtimeMs,
    bytes: file.bytes,
    ctimeMs: file.ctimeMs,
    ino: file.ino,
    dev: file.dev,
    activityMs,
  });
  return activityMs;
}

/** Complete line bytes: `head` (owned by the chunk whose newline ends the line) followed by later chunks' fragments, newest first. */
function decodeLine(decoder: TextDecoder, head: Uint8Array, fragments: Uint8Array[]): string {
  if (fragments.length === 0) return decoder.decode(head);
  let length = head.length;
  for (const fragment of fragments) length += fragment.length;
  const line = new Uint8Array(length);
  line.set(head, 0);
  let offset = head.length;
  for (let index = fragments.length - 1; index >= 0; index--) {
    line.set(fragments[index], offset);
    offset += fragments[index].length;
  }
  return decoder.decode(line);
}

/**
 * Walk backwards from EOF in fixed chunks until the last user/assistant message
 * with a parseable timestamp is found. Walking from the end means the newest
 * message wins regardless of transcript size, and each raw chunk is read once:
 * lines wholly inside a chunk are decoded and dropped immediately, while a line
 * straddling chunk boundaries keeps one zero-copy fragment per chunk until the
 * chunk holding its terminating newline assembles and decodes it exactly once —
 * so assembly is linear even for a single multi-megabyte tool/image line.
 * Splitting on raw bytes keeps multibyte characters intact: a fragment is never
 * decoded on its own. Malformed lines (half-written appends, truncation) are
 * skipped rather than ending the scan, and a match always comes from a complete
 * line, so no partial value can leak in.
 */
async function scanActivity(file: SessionFile): Promise<number | null> {
  const decoder = new TextDecoder();
  // Leading fragment of each scanned chunk, newest chunk first; only populated
  // while a line crosses a chunk boundary, and cleared once that line completes.
  const fragments: Uint8Array[] = [];
  let end = file.bytes;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK_BYTES);
    const chunk = new Uint8Array(await Bun.file(file.path).slice(start, end).arrayBuffer());
    let lineEnd = chunk.length;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 0x0a) continue;
      const timestamp = conversationTimestamp(decodeLine(decoder, chunk.subarray(i + 1, lineEnd), fragments));
      fragments.length = 0; // The newline completed the pending line, if any.
      if (timestamp !== null) return timestamp;
      lineEnd = i;
    }
    if (start === 0) {
      // The first chunk's leading fragment is a line by itself (file start).
      return conversationTimestamp(decodeLine(decoder, chunk.subarray(0, lineEnd), fragments));
    }
    // The leading fragment starts in an earlier chunk; retain a view, no copy.
    fragments.push(chunk.subarray(0, lineEnd));
    end = start;
  }
  return null;
}

/** ms timestamp of a `message` event that belongs to the conversation, else null. */
function conversationTimestamp(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== "message" || typeof event.timestamp !== "string") return null;
  const message = event.message;
  if (!isRecord(message) || typeof message.role !== "string" || CONVERSATION_ROLES[message.role] !== true) return null;
  const timestamp = Date.parse(event.timestamp);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Newest conversation first; path keeps equal timestamps deterministic. */
function byActivityDesc(a: SessionBase, b: SessionBase): number {
  return b.activityMs - a.activityMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

type HeadInfo = {
  id: string | null;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  /** `session` event timestamp in ms: transcript creation, fallback when no conversation exists. */
  startedAtMs: number | null;
};

const headerCache = new Map<string, FileVersion & { info: HeadInfo }>();

/** Drop deleted paths from this root so removed/imported stores release cache entries. */
function pruneCacheForRoot<V>(cache: Map<string, V>, root: string, livePaths: Set<string>): void {
  const absoluteRoot = resolve(root);
  const rootPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  for (const path of cache.keys()) {
    const absolutePath = isAbsolute(root) && isAbsolute(path) ? path : resolve(path);
    if (
      (absolutePath === absoluteRoot || absolutePath.startsWith(rootPrefix)) &&
      !livePaths.has(path)
    ) {
      cacheDelete(cache, path);
    }
  }
}

/** Read and parse one header, retrying failures on the next listing. */
async function readParsedHeader(file: SessionFile): Promise<HeadInfo | null> {
  const cached = headerCache.get(file.path);
  if (cached && hasSameVersion(cached, file)) {
    cacheTouch(headerCache, file.path, cached);
    return cached.info;
  }
  let head: string;
  try {
    head = await Bun.file(file.path).slice(0, HEADER_BYTES).text();
  } catch {
    return null;
  }
  const info = parseHead(head);
  cacheSet(headerCache, file.path, {
    mtimeMs: file.mtimeMs,
    bytes: file.bytes,
    ctimeMs: file.ctimeMs,
    ino: file.ino,
    dev: file.dev,
    info,
  });
  return info;
}

export async function listSessions(
  options: {
    limit?: number;
    search?: string;
    sessionsRoot?: string;
    titleOverrides?: ReadonlyMap<string, string>;
    excludedPaths?: ReadonlySet<string>;
  } = {},
): Promise<SessionSummary[]> {
  const root = resolve(
    options.sessionsRoot ??
      process.env.OMP_DESKTOP_SESSIONS_DIR ??
      join(homedir(), ".omp/agent/sessions"),
  );
  const requestedLimit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;
  const limit = Math.min(requestedLimit, MAX_SESSION_LIMIT);
  const search = options.search?.toLowerCase() ?? "";
  const indexed = await readSessionIndex(root);
  const { files } = indexed;
  const titleOverrides = options.titleOverrides;
  const summaries = titleOverrides
    ? indexed.summaries.map((summary) => {
        const title = titleOverrides.get(summary.path);
        return title ? { ...summary, title } : summary;
      })
    : indexed.summaries;
  const excludedPaths = options.excludedPaths;
  const visible = excludedPaths ? summaries.filter((summary) => !excludedPaths.has(summary.path)) : summaries;
  const matched = search
    ? visible.filter(
        (summary) =>
          summary.title.toLowerCase().includes(search) ||
          summary.id.toLowerCase().includes(search) ||
          summary.cwd.toLowerCase().includes(search) ||
          (summary.firstPrompt?.toLowerCase().includes(search) ?? false) ||
          summary.path.toLowerCase().includes(search),
      )
    : visible;

  // Only rows crossing the response boundary pay the full-transcript cost scan.
  const byPath = new Map<string, SessionFile>(files.map((file): [string, SessionFile] => [file.path, file]));
  return mapConcurrent(matched.slice(0, limit), async (summary) => {
    const file = byPath.get(summary.path);
    return { ...summary, costUsd: file ? await readCost(file) : 0 };
  });
}

type SessionIndex = { files: SessionFile[]; summaries: SessionBase[] };
const indexReadsInFlight = new Map<string, Promise<SessionIndex>>();

/** Coalesce simultaneous polling reads without retaining stale search snapshots. */
function readSessionIndex(root: string): Promise<SessionIndex> {
  const existing = indexReadsInFlight.get(root);
  if (existing) return existing;
  const pending = (async () => {
    const files = await collectSessionFiles(root);
    const livePaths = new Set(files.map((file) => file.path));
    pruneCacheForRoot(costCache, root, livePaths);
    pruneCacheForRoot(activityCache, root, livePaths);
    pruneCacheForRoot(headerCache, root, livePaths);
    const historyTitles = readHistoryTitles(join(dirname(root), "history.db"));
    // Imported files and clock-skewed timestamps remain eligible; search must
    // see every match instead of pruning by file mtime.
    const summaries = (
      await mapConcurrent(files, (file) => readSummary(file, historyTitles))
    ).filter((summary): summary is SessionBase => summary !== null);
    summaries.sort(byActivityDesc);
    return { files, summaries };
  })();
  indexReadsInFlight.set(root, pending);
  pending.then(
    () => { if (indexReadsInFlight.get(root) === pending) indexReadsInFlight.delete(root); },
    () => { if (indexReadsInFlight.get(root) === pending) indexReadsInFlight.delete(root); },
  );
  return pending;
}

/**
 * Working directory recorded in a transcript's `session` header, for resume.
 * This is the session's own project directory; the process launch directory is
 * unrelated — omp switches to the recorded cwd itself when resuming. Returns
 * null for an unreadable file or a transcript predating the header, so callers
 * keep their own fallback.
 */
export async function readSessionCwd(path: string): Promise<string | null> {
  let head: string;
  try {
    head = await Bun.file(path).slice(0, HEADER_BYTES).text();
  } catch {
    return null;
  }
  return parseHead(head).cwd;
}

/** Stat every `.jsonl` one level below `root`; unreadable entries are skipped. */
async function collectSessionFiles(root: string): Promise<SessionFile[]> {
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((dir) => dir.isDirectory());
  const candidatesByDir = await mapConcurrent(dirs, async (dir) => {
    const dirPath = join(root, dir.name);
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.name.endsWith(".jsonl"))
      .map((entry) => ({ path: join(dirPath, entry.name), dir: dir.name }));
  });
  const candidates = candidatesByDir.flat();
  const files = await mapConcurrent(candidates, async (candidate) => {
    const info = await stat(candidate.path).catch(() => null); // vanished/unreadable
    return info?.isFile()
      ? {
          ...candidate,
          mtimeMs: info.mtimeMs,
          bytes: info.size,
          ctimeMs: info.ctimeMs,
          ino: info.ino,
          dev: info.dev,
          birthtimeMs: info.birthtimeMs,
        }
      : null;
  });
  return files.filter((file): file is SessionFile => file !== null);
}

/** Read one transcript's header prefix and conversation activity; falls back to path-derived values. */
async function readSummary(
  file: SessionFile,
  historyTitles: Map<string, string>,
): Promise<SessionBase | null> {
  const [parsed, activity] = await Promise.all([
    readParsedHeader(file),
    // A failed activity read is a transient per-listing fallback to creation
    // time; readActivity does not memoize it, so the next poll retries.
    readActivity(file).catch(() => null),
  ]);
  if (parsed === null) return null; // Unreadable transcript: skip it, don't fail the listing.
  const id = parsed.id ?? idFromFilename(file.path);

  const cwd = parsed.cwd ?? decodeDirName(file.dir);
  const firstPrompt = parsed.firstPrompt;
  const title = parsed.title ?? historyTitles.get(id) ?? firstPrompt ?? basename(cwd);
  // No conversation (a just-created chat, or a legacy/malformed transcript) must
  // not inherit the mtime a resume touches: use stable creation-time sources.
  const activityMs = activity ?? parsed.startedAtMs ?? filenameStartedAtMs(file.path) ?? file.birthtimeMs;
  return {
    id,
    path: file.path,
    cwd,
    title: title || cwd || file.path,
    firstPrompt,
    updatedAt: new Date(activityMs).toISOString(),
    bytes: file.bytes,
    activityMs,
  };
}

/** Parse the JSONL prefix line by line; stop at the first truncated line. */
function parseHead(head: string): HeadInfo {
  const info: HeadInfo = { id: null, cwd: null, title: null, firstPrompt: null, startedAtMs: null };
  if (!head) return info;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      break; // Truncated final line (or corruption): nothing further is usable.
    }
    if (!isRecord(event)) continue;
    switch (event.type) {
      case "session":
        if (info.id === null && typeof event.id === "string" && event.id) info.id = event.id;
        if (info.cwd === null && typeof event.cwd === "string" && event.cwd) info.cwd = event.cwd;
        if (info.startedAtMs === null && typeof event.timestamp === "string") {
          const startedAt = Date.parse(event.timestamp);
          if (Number.isFinite(startedAt)) info.startedAtMs = startedAt;
        }
        break;
      case "title":
      case "title_change": {
        // Later titles win; empty/whitespace titles don't count.
        const title = typeof event.title === "string" ? event.title.trim() : "";
        if (title) info.title = title;
        break;
      }
      case "message": {
        if (info.firstPrompt !== null) break;
        const message = event.message;
        if (!isRecord(message) || message.role !== "user") break;
        const text = extractText(message.content);
        if (text) info.firstPrompt = text;
        break;
      }
    }
  }
  return info;
}

/** First text of a string- or parts-shaped message content, normalized. */
function extractText(content: unknown): string | null {
  let raw: string | null = null;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string" && part.text) parts.push(part.text);
    }
    raw = parts.length > 0 ? parts.join("\n") : null;
  }
  const collapsed = raw?.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, PROMPT_MAX_CHARS) : null;
}

/** `<timestamp>_<uuid>.jsonl` -> uuid; a missing underscore keeps the stem. */
function idFromFilename(path: string): string {
  const stem = basename(path).replace(/\.jsonl$/i, "");
  const cut = stem.lastIndexOf("_");
  const id = cut >= 0 ? stem.slice(cut + 1) : stem;
  return id || stem;
}

/**
 * omp names transcripts `2026-07-01T10-00-00-000Z_<uuid>.jsonl`; recover that
 * creation time for transcripts whose header has no usable timestamp, so a
 * no-message or legacy file still has a stable, touch-proof recency.
 */
function filenameStartedAtMs(path: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(basename(path));
  if (!match) return null;
  const startedAt = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(startedAt) ? startedAt : null;
}

/**
 * Best-effort reversal of omp's cwd encoding (`-home-user-dev`). Dashes that
 * were part of a path segment are indistinguishable from separators, so this
 * only serves as a fallback when the transcript has no `session` event.
 */
function decodeDirName(dir: string): string {
  const decoded = dir.replace(/-/g, "/").replace(/\/{2,}/g, "/");
  const rooted = decoded.startsWith("/") ? decoded : `/${decoded}`;
  return rooted.length > 1 ? rooted.replace(/\/$/, "") : rooted;
}

/** Optional title enrichment from history.db, cached against the main file and WAL. */
type HistoryFileVersion = { mtimeMs: number; bytes: number; ctimeMs: number; ino: number; dev: number };
type HistoryVersion = { main: HistoryFileVersion | null; wal: HistoryFileVersion | null };
type HistoryTitlesEntry = { version: HistoryVersion; titles: Map<string, string> };
const historyTitlesCache = new Map<string, HistoryTitlesEntry>();

function historyFileVersion(path: string): HistoryFileVersion | null {
  try {
    const info = statSync(path);
    return {
      mtimeMs: info.mtimeMs,
      bytes: info.size,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
      dev: info.dev,
    };
  } catch {
    return null;
  }
}

function sameHistoryVersion(a: HistoryVersion, b: HistoryVersion): boolean {
  const mainMatches =
    a.main === null
      ? b.main === null
      : b.main !== null &&
        a.main.mtimeMs === b.main.mtimeMs &&
        a.main.bytes === b.main.bytes &&
        a.main.ctimeMs === b.main.ctimeMs &&
        a.main.ino === b.main.ino &&
        a.main.dev === b.main.dev;
  const walMatches =
    a.wal === null
      ? b.wal === null
      : b.wal !== null &&
        a.wal.mtimeMs === b.wal.mtimeMs &&
        a.wal.bytes === b.wal.bytes &&
        a.wal.ctimeMs === b.wal.ctimeMs &&
        a.wal.ino === b.wal.ino &&
        a.wal.dev === b.wal.dev;
  return mainMatches && walMatches;
}

function readHistoryTitles(dbPath: string): Map<string, string> {
  const cacheKey = resolve(dbPath);
  const version: HistoryVersion = {
    main: historyFileVersion(cacheKey),
    wal: historyFileVersion(`${cacheKey}-wal`),
  };
  const cached = historyTitlesCache.get(cacheKey);
  if (cached && sameHistoryVersion(cached.version, version)) {
    cacheTouch(historyTitlesCache, cacheKey, cached);
    return cached.titles;
  }
  const titles = new Map<string, string>();
  try {
    if (version.main !== null) {
      const db = new Database(cacheKey, { readonly: true });
      try {
        const rows: unknown[] = db.query("SELECT session_id, title FROM session_titles").all();
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const { session_id, title } = row;
          if (typeof session_id === "string" && typeof title === "string" && title.trim()) {
            titles.set(session_id, title.trim());
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // Missing/corrupt/locked history.db is fine: titles are enrichment only.
    return titles;
  }
  const updated = { version, titles };
  cacheSet(historyTitlesCache, cacheKey, updated);
  return titles;
}
