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
 * activity/cost results are memoized by (mtime, size) in bounded caches. Every
 * file is considered because mtime cannot bound activity: imported files and
 * clock skew can write messages newer than the file's last touch, and pruning by
 * mtime would hide such (or merely old-mtime matching) sessions.
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
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
/** Backwards activity scan step; one chunk covers the tail of almost every transcript. */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Roles that form the conversation; tool results and developer context are machinery, not use. */
const CONVERSATION_ROLES: Record<string, true> = { user: true, assistant: true };
/** Per-file memoization cap: hot sessions survive, long-abandoned paths are evicted. */
const CACHE_MAX_ENTRIES = 1024;

/** Insertion-ordered cache: a write refreshes the key, the oldest entry is evicted beyond the cap. */
function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Cost lives in per-message usage records spread across the whole transcript
 * (session cost is their sum, same accounting as omp's `get_session_stats`), so
 * unlike the 8 KiB header this has to read the file. This listing is polled per
 * sidebar refresh, so each transcript is summed once per (mtime, size) and the
 * result cached; unreadable files contribute 0.
 */
const costCache = new Map<string, { mtimeMs: number; bytes: number; costUsd: number }>();

/** Matches a whole usage cost object, so a chunk boundary can never yield a partial number. */
const COST_PATTERN = /"cost":\s*\{[^}]*?"total":\s*([0-9.eE+-]+)\s*\}/g;

async function readCost(file: SessionFile): Promise<number> {
  const cached = costCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.bytes === file.bytes) {
    cacheSet(costCache, file.path, cached);
    return cached.costUsd;
  }
  let costUsd = 0;
  try {
    const decoder = new TextDecoder();
    const reader = Bun.file(file.path).stream().getReader();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let scanned = 0;
      for (const match of pending.matchAll(COST_PATTERN)) {
        const amount = Number(match[1]);
        if (Number.isFinite(amount) && amount > 0) costUsd += amount;
        scanned = (match.index ?? 0) + match[0].length;
      }
      pending = pending.slice(scanned);
      // A match is far shorter than this, so trimming cannot drop a straddler.
      if (pending.length > 4096) pending = pending.slice(-4096);
    }
  } catch {
    costUsd = 0;
  }
  cacheSet(costCache, file.path, { mtimeMs: file.mtimeMs, bytes: file.bytes, costUsd });
  return costUsd;
}

type SessionFile = { path: string; dir: string; mtimeMs: number; bytes: number; birthtimeMs: number };

/** Everything but cost; costs are summed only for the rows that survive the limit. */
type SessionBase = Omit<SessionSummary, "costUsd">;

/**
 * Last conversation timestamp per transcript, memoized by (mtime, size) like
 * `costCache`. `null` means the backwards scan found no conversation, which
 * callers turn into the stable creation-time fallback.
 */
const activityCache = new Map<string, { mtimeMs: number; bytes: number; activityMs: number | null }>();

async function readActivity(file: SessionFile): Promise<number | null> {
  const cached = activityCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.bytes === file.bytes) {
    cacheSet(activityCache, file.path, cached);
    return cached.activityMs;
  }
  // A read failure propagates (never memoized) so callers fall back for this
  // listing only and the next poll retries; `null` means "no conversation".
  const activityMs = await scanActivity(file);
  cacheSet(activityCache, file.path, { mtimeMs: file.mtimeMs, bytes: file.bytes, activityMs });
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

export async function listSessions(
  options: { limit?: number; search?: string; sessionsRoot?: string } = {},
): Promise<SessionSummary[]> {
  const root =
    options.sessionsRoot ??
    process.env.OMP_DESKTOP_SESSIONS_DIR ??
    join(homedir(), ".omp/agent/sessions");
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;
  const search = options.search?.toLowerCase() ?? "";

  const files = await collectSessionFiles(root);
  const historyTitles = readHistoryTitles(join(dirname(root), "history.db"));
  // Read every transcript: mtime cannot bound activity (imported files and clock
  // skew can write messages newer than the file's last touch), so filtering by
  // mtime first could hide a recent session, and search must see every match.
  const summaries = (
    await Promise.all(files.map((file) => readSummary(file, historyTitles)))
  ).filter((summary): summary is SessionBase => summary !== null);
  summaries.sort(byActivityDesc);

  const matched = search
    ? summaries.filter(
        (summary) =>
          summary.title.toLowerCase().includes(search) ||
          summary.id.toLowerCase().includes(search) ||
          summary.cwd.toLowerCase().includes(search) ||
          (summary.firstPrompt?.toLowerCase().includes(search) ?? false) ||
          summary.path.toLowerCase().includes(search),
      )
    : summaries;

  // A cost sum is a full-file read, unlike the 8 KiB header, so only the rows
  // that actually cross the wire pay for it.
  const byPath = new Map<string, SessionFile>(files.map((file): [string, SessionFile] => [file.path, file]));
  return Promise.all(
    matched.slice(0, limit).map(async (summary) => {
      const file = byPath.get(summary.path);
      return { ...summary, costUsd: file ? await readCost(file) : 0 };
    }),
  );
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
  const files: SessionFile[] = [];
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    dirs.map(async (dir) => {
      if (!dir.isDirectory()) return;
      const dirPath = join(root, dir.name);
      const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.name.endsWith(".jsonl")) return;
          const path = join(dirPath, entry.name);
          const info = await stat(path).catch(() => null); // vanished/unreadable
          if (info?.isFile()) {
            files.push({
              path,
              dir: dir.name,
              mtimeMs: info.mtimeMs,
              bytes: info.size,
              birthtimeMs: info.birthtimeMs,
            });
          }
        }),
      );
    }),
  );
  return files;
}

/** Read one transcript's header prefix and conversation activity; falls back to path-derived values. */
async function readSummary(
  file: SessionFile,
  historyTitles: Map<string, string>,
): Promise<SessionBase | null> {
  const [head, activity] = await Promise.all([
    Bun.file(file.path).slice(0, HEADER_BYTES).text().catch(() => null),
    // A failed activity read is a transient per-listing fallback to creation
    // time; readActivity does not memoize it, so the next poll retries.
    readActivity(file).catch(() => null),
  ]);
  if (head === null) return null; // Unreadable transcript: skip it, don't fail the listing.
  const parsed = parseHead(head);
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

/** Optional title enrichment from history.db; any failure yields no titles. */
function readHistoryTitles(dbPath: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    if (!existsSync(dbPath)) return titles;
    const db = new Database(dbPath, { readonly: true });
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
  } catch {
    // Missing/corrupt/locked history.db is fine: titles are enrichment only.
  }
  return titles;
}
