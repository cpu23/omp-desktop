/**
 * Persistent daemon-owned archive markers for OMP sessions. Archives hide a
 * transcript from listings without modifying or deleting the transcript.
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

/** Atomically persisted set of session transcript paths hidden from listings. */
export class SessionArchiveStore {
  readonly file: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /** Return valid stored paths; missing or malformed metadata is empty. */
  async read(): Promise<string[]> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof SyntaxError) return [];
      throw error;
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.archivedPaths)) return [];
    return [...new Set(value.archivedPaths.filter((path): path is string => typeof path === "string" && path.length > 0))];
  }

  /** Preserve prior archives and serialize repeated/concurrent updates in call order. */
  archive(path: string): Promise<void> {
    if (!path) return Promise.reject(new Error("session path is required"));
    const write = async (): Promise<void> => {
      const paths = new Set(await this.read());
      paths.add(path);
      await writeTextAtomically(this.file, JSON.stringify({ version: 1, archivedPaths: [...paths] }));
    };
    this.#writing = this.#writing.catch(() => {}).then(write);
    return this.#writing;
  }
}
