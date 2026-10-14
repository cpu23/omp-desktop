/**
 * Durable workspace state for the desktop client.
 *
 * The client keeps its layout/pins/settings in browser storage for instant boot,
 * but browser storage is per-origin, can be cleared, and is invisible to a fresh
 * profile; after a daemon/machine restart the panes it described are also the
 * only record of which transcripts the workspace held. This store mirrors the
 * client's workspace document to one small JSON file on disk so a restart — or
 * a wiped browser profile — cannot lose the workspace description.
 *
 * The document is owned and versioned by the client (`version: 2`); the daemon
 * only bounds its size and writes it atomically, so the wire format can evolve
 * without a daemon change.
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards";

/** Serialized workspace documents larger than this are rejected (413). */
export const STATE_LIMIT_BYTES = 1024 * 1024;

/** Serialized runtime ledgers larger than this are refused on read and write. */
export const LEDGER_LIMIT_BYTES = 1024 * 1024;

/**
 * Atomically replaces a (small) JSON file: write a sibling temp file, fsync it,
 * rename over the target, then fsync the parent directory so the new entry
 * itself survives a power cut (Linux desktop target). A crash or power cut
 * leaves either the old or the new document complete, never a truncated one,
 * and a first create is durable too.
 */
async function writeTextAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  // The rename is durable only once the directory entry is on disk; without
  // this a power cut right after a first create can lose the file.
  const dir = await open(dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export type StateSnapshot = {
  /** The stored document, or null when no state has been saved yet. */
  state: unknown | null;
  /** File mtime of the stored document, ISO, or null when absent. */
  savedAt: string | null;
  /** True when the file exists but is not parseable JSON (the client will repair it). */
  corrupt: boolean;
  path: string;
};

export class WorkspaceStateStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Reads the current document. A missing file is `state: null`, not an error. */
  async read(): Promise<StateSnapshot> {
    let text: string;
    let mtime: Date;
    try {
      text = await readFile(this.file, "utf8");
      mtime = (await stat(this.file)).mtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: null, savedAt: null, corrupt: false, path: this.file };
      }
      throw error;
    }
    try {
      return { state: JSON.parse(text) as unknown, savedAt: mtime.toISOString(), corrupt: false, path: this.file };
    } catch {
      // The bytes are useless without a rewrite; report rather than fail so the
      // client can publish its live workspace over the damaged file.
      return { state: null, savedAt: mtime.toISOString(), corrupt: true, path: this.file };
    }
  }

  /**
   * Atomically replaces the document. A crash or power cut leaves either the
   * old or the new document complete, never a truncated one.
   */
  async write(state: unknown): Promise<{ savedAt: string; bytes: number }> {
    const text = JSON.stringify(state);
    const bytes = Buffer.byteLength(text);
    if (bytes > STATE_LIMIT_BYTES) {
      throw new Error(`state document is ${bytes} bytes (limit ${STATE_LIMIT_BYTES})`);
    }
    await writeTextAtomically(this.file, text);
    const savedAt = (await stat(this.file)).mtime.toISOString();
    return { savedAt, bytes };
  }
}

/**
 * One live process in the daemon's pool, recorded so a daemon restart can bring
 * the session back. Field values come from the running process, never from a
 * client document.
 */
export type LiveSession = {
  /** Absolute transcript under the session store the process is writing. */
  sessionFile: string;
  /** Process working directory; the fallback when the transcript's recorded cwd is gone. */
  cwd: string;
  cols?: number;
  rows?: number;
};

/**
 * Durable record of the live runtime pool.
 *
 * The daemon owns the pool — processes outlive panes, and a session can be live
 * with no pane (or no client) attached at all. Restoration therefore belongs to
 * the daemon too: it writes a snapshot here whenever the pool changes, and on
 * start it resumes every recorded transcript that still exists. A session that
 * the user stopped (DELETE /api/runtimes/:id) drops its entry at that moment,
 * and one whose process exited on its own drops it once the daemon has stayed
 * alive briefly afterwards — an exit carries no reason, and on a unit teardown
 * (systemctl stop, logout, reboot) systemd kills the PTY children together with
 * the daemon, so an exit seen in its last moments must not erase a session that
 * was live a moment ago (see daemon.ts's settle window).
 *
 * This file is daemon-owned and separate from the client's workspace document
 * (`state.json`): neither side can overwrite the other's record, and a client
 * that is not running cannot be a prerequisite for restoring a session.
 */
export class RuntimeLedgerStore {
  readonly file: string;
  /** Serializes writes: concurrent saves land in call order, so the last snapshot wins. */
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /**
   * The last recorded snapshot. A missing, corrupt, oversized, or malformed file
   * yields `[]`: an unreadable record must not fail daemon startup, and it must
   * not be half-trusted either. Individual malformed records are skipped.
   */
  async read(): Promise<LiveSession[]> {
    let text: string;
    try {
      const info = await stat(this.file);
      if (info.size > LEDGER_LIMIT_BYTES) return [];
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return [];
    const sessions: LiveSession[] = [];
    for (const entry of value.sessions) {
      if (!isRecord(entry)) continue;
      const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : null;
      const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
      if (!sessionFile || cwd === null) continue;
      const cols = typeof entry.cols === "number" && Number.isFinite(entry.cols) ? entry.cols : undefined;
      const rows = typeof entry.rows === "number" && Number.isFinite(entry.rows) ? entry.rows : undefined;
      sessions.push({ sessionFile, cwd, cols, rows });
    }
    return sessions;
  }

  /**
   * Replaces the snapshot. Writes are serialized; a failed write rejects only
   * its own caller and leaves the queue usable for later snapshots. The caller
   * decides whether a rejection is fatal (it never is for the pool).
   */
  save(sessions: LiveSession[]): Promise<void> {
    const text = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), sessions });
    const bytes = Buffer.byteLength(text);
    // Deferred, not started here: two saves must not race each other's rename,
    // or an older snapshot could land after (and overwrite) a newer one.
    const write = (): Promise<void> =>
      bytes > LEDGER_LIMIT_BYTES
        ? Promise.reject(new Error(`runtime ledger is ${bytes} bytes (limit ${LEDGER_LIMIT_BYTES})`))
        : writeTextAtomically(this.file, text);
    this.#writing = this.#writing.catch(() => {}).then(write);
    return this.#writing;
  }
}
