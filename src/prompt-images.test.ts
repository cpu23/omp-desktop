import { expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPromptImages } from "./idle-extension";

test("prompt attachments deduplicate repeated paths before encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-images-"));
  try {
    const path = join(root, "tiny.png");
    await Bun.write(path, "image fixture");
    const images = await readPromptImages([path, path]);
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0]!.data, "base64").toString()).toBe("image fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prompt attachments bound aggregate bytes and unique file count", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-images-"));
  try {
    const paths = [join(root, "a.png"), join(root, "b.png")];
    for (const path of paths) {
      const handle = await open(path, "w");
      try { await handle.truncate(17 * 1024 * 1024); } finally { await handle.close(); }
    }
    await expect(readPromptImages(paths)).rejects.toThrow("32 MiB total");
    const many = Array.from({ length: 17 }, (_, index) => join(root, `${index}.png`));
    for (const path of many) await Bun.write(path, "x");
    await expect(readPromptImages(many)).rejects.toThrow("16");
  } finally { await rm(root, { recursive: true, force: true }); }
});
