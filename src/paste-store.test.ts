import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_FILE_LIMIT } from "./image-limits";
import { PasteCapacityError, PasteStore } from "./paste-store";

test("concurrent uploads respect the aggregate quota without deleting retained images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-paste-budget-"));
  try {
    const retained = join(dir, "retained.png");
    await writeFile(retained, "retained-image-prefix");
    await truncate(retained, IMAGE_FILE_LIMIT - 700);
    const store = new PasteStore(dir, IMAGE_FILE_LIMIT);
    const first = new Uint8Array(600).fill(17);
    const second = new Uint8Array(600).fill(29);
    const results = await Promise.allSettled([store.write(first, "png"), store.write(second, "png")]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    if (results[0]!.status !== "fulfilled" || results[1]!.status !== "rejected") throw new Error("unexpected upload outcome");
    expect(results[1]!.reason).toBeInstanceOf(PasteCapacityError);
    expect(new Uint8Array(await readFile(results[0]!.value))).toEqual(first);
    expect((await stat(retained)).size).toBe(IMAGE_FILE_LIMIT - 700);
    const handle = await Bun.file(retained).slice(0, 21).text();
    expect(handle).toBe("retained-image-prefix");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
