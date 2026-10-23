import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_FILE_LIMIT } from "./image-limits";

const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 4096;

/** Uploads are serialized against the shared directory quota; existing files are never deleted. */
export class PasteStore {
  readonly #dir: string;
  readonly #budget: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(dir: string, budget = Number(process.env.OMP_DESKTOP_PASTE_BUDGET_BYTES ?? DEFAULT_BUDGET_BYTES)) {
    if (!Number.isSafeInteger(budget) || budget < IMAGE_FILE_LIMIT) {
      throw new Error("OMP_DESKTOP_PASTE_BUDGET_BYTES must be an integer of at least 33554432");
    }
    this.#dir = dir;
    this.#budget = budget;
  }

  write(bytes: Uint8Array, extension: string): Promise<string> {
    const run = this.#tail.then(async () => {
      await mkdir(this.#dir, { recursive: true });
      const entries = await readdir(this.#dir, { withFileTypes: true });
      if (entries.length >= MAX_FILES) throw new PasteCapacityError("paste directory file limit reached");
      let used = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          used += (await stat(join(this.#dir, entry.name))).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (used + bytes.byteLength > this.#budget) throw new PasteCapacityError("paste storage budget exceeded");
      }
      if (used + bytes.byteLength > this.#budget) throw new PasteCapacityError("paste storage budget exceeded");
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
      const path = join(this.#dir, name);
      await Bun.write(path, bytes);
      return path;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class PasteCapacityError extends Error {}
