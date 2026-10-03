/**
 * Index over omp's on-disk session store, used by the sidebar's recent-session
 * list.
 *
 * Layout: `<root>/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, exactly one
 * directory level below the root. Sibling directories with the same
 * timestamp_uuid name are transcript attachments and are ignored.
 *
 * Listing is a two-phase scan: collect and stat every `.jsonl` file first
 * (cheap), sort by mtime, then read only the first 8 KiB of the newest files
 * to recover identity/title/first prompt — transcripts reach beyond 1 MB and
 * this is polled. Header data is read fresh each call; only the per-transcript
 * cost sums are memoized, keyed by (mtime, size) — see `costCache`.
 *
 * Robustness: a missing/nonexistent root, unreadable file or directory, or a
 * truncated JSONL line must never abort the listing. The header is parsed
 * best-effort and missing fields fall back to filename/dirname decoding.
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
  /** ISO 8601, from the transcript file mtime. */
  updatedAt: string;
  /** Transcript size in bytes. */
  bytes: number;
  /** Transcript mtime in ms, for sorting. */
  mtimeMs: number;
  /** Sum of every `usage.cost.total` in the transcript, USD; 0 when unpriced. */
  costUsd: number;
};

const HEADER_BYTES = 8 * 1024;
const PROMPT_MAX_CHARS = 200;
const DEFAULT_LIMIT = 60;
/** Read at least this many headers so a narrow `limit` still sees a useful window. */
const MIN_SCAN = 120;

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
  if (cached && cached.mtimeMs === file.mtimeMs && cached.bytes === file.bytes) return cached.costUsd;
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
  costCache.set(file.path, { mtimeMs: file.mtimeMs, bytes: file.bytes, costUsd });
  return costUsd;
}

type SessionFile = { path: string; dir: string; mtimeMs: number; bytes: number };

type HeadInfo = {
  id: string | null;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
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
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const newest = files.slice(0, Math.max(limit, MIN_SCAN));
  const historyTitles = readHistoryTitles(join(dirname(root), "history.db"));
  const summaries = (
    await Promise.all(newest.map((file) => readSummary(file, historyTitles)))
  ).filter((summary): summary is SessionSummary => summary !== null);

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
  return matched.slice(0, limit);
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
            files.push({ path, dir: dir.name, mtimeMs: info.mtimeMs, bytes: info.size });
          }
        }),
      );
    }),
  );
  return files;
}

/** Read one transcript's header prefix; falls back to path-derived values. */
async function readSummary(
  file: SessionFile,
  historyTitles: Map<string, string>,
): Promise<SessionSummary | null> {
  let head: string;
  try {
    head = await Bun.file(file.path).slice(0, HEADER_BYTES).text();
  } catch {
    return null; // Unreadable transcript: skip it, don't fail the listing.
  }
  const parsed = parseHead(head);
  const id = parsed.id ?? idFromFilename(file.path);
  const cwd = parsed.cwd ?? decodeDirName(file.dir);
  const firstPrompt = parsed.firstPrompt;
  const title = parsed.title ?? historyTitles.get(id) ?? firstPrompt ?? basename(cwd);
  return {
    id,
    path: file.path,
    cwd,
    title: title || cwd || file.path,
    firstPrompt,
    updatedAt: new Date(file.mtimeMs).toISOString(),
    bytes: file.bytes,
    mtimeMs: file.mtimeMs,
    costUsd: await readCost(file),
  };
}

/** Parse the JSONL prefix line by line; stop at the first truncated line. */
function parseHead(head: string): HeadInfo {
  const info: HeadInfo = { id: null, cwd: null, title: null, firstPrompt: null };
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
 * Best-effort reversal of omp's cwd encoding (`-home-mrw-dev`). Dashes that
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
