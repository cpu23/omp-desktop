/**
 * Persistent desktop-only titles for OMP sessions. Transcript files remain
 * owned by OMP; this daemon-side index stores display names by transcript path.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards";

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
  const dir = await open(dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Daemon-owned, atomically persisted session title overrides. */
export class SessionTitleStore {
  readonly file: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /** Return valid stored overrides; missing or malformed metadata is empty. */
  async read(): Promise<Map<string, string>> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      if (error instanceof SyntaxError) return new Map();
      throw error;
    }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.titles)) return new Map();
    const titles = new Map<string, string>();
    for (const [path, title] of Object.entries(value.titles)) {
      if (path.length > 0 && typeof title === "string" && title.trim().length > 0) {
        titles.set(path, title.trim());
      }
    }
    return titles;
  }

  /** Preserve other sessions' names and serialize rapid updates in call order. */
  save(path: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (!path || !normalized) return Promise.reject(new Error("session path and nonempty title are required"));
    const write = async (): Promise<void> => {
      const titles = await this.read();
      titles.set(path, normalized);
      const text = JSON.stringify({ version: 1, titles: Object.fromEntries(titles) });
      await writeTextAtomically(this.file, text);
    };
    this.#writing = this.#writing.catch(() => {}).then(write);
    return this.#writing;
  }
}
