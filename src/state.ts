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
 * The document is owned and versioned by the client (`version: 1`); the daemon
 * only bounds its size and writes it atomically, so the wire format can evolve
 * without a daemon change.
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Serialized workspace documents larger than this are rejected (413). */
export const STATE_LIMIT_BYTES = 1024 * 1024;

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
   * Atomically replaces the document: write a sibling temp file, fsync it, rename
   * over the target, then fsync the parent directory so the new entry itself
   * survives a power cut (Linux desktop target). A crash or power cut leaves
   * either the old or the new document complete, never a truncated one, and a
   * first create is durable too.
   */
  async write(state: unknown): Promise<{ savedAt: string; bytes: number }> {
    const text = JSON.stringify(state);
    const bytes = Buffer.byteLength(text);
    if (bytes > STATE_LIMIT_BYTES) {
      throw new Error(`state document is ${bytes} bytes (limit ${STATE_LIMIT_BYTES})`);
    }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "w", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    // The rename is durable only once the directory entry is on disk; without
    // this a power cut right after a first create can lose the file.
    const dir = await open(dirname(this.file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const savedAt = (await stat(this.file)).mtime.toISOString();
    return { savedAt, bytes };
  }
}
