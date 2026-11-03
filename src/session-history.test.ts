import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { renderSessionHistory } from "./session-history";

const roots: string[] = [];
const controllers: AbortController[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(readers.splice(0).map((reader) => reader.cancel().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeOmp(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-desktop-history-"));
  roots.push(root);
  const executable = join(root, "omp");
  await writeFile(executable, `#!/bin/sh\n${source}\n`);
  await chmod(executable, 0o700);
  return executable;
}

describe("offline session history renderer", () => {

  test("rejects unsafe terminal dimensions without starting a renderer", async () => {
    const response = await renderSessionHistory({ file: "/sessions/a.jsonl", cols: 0, rows: 27, omp: "/not-used" });
    expect(response.status).toBe(400);
  });

  test("passes configured OMP arguments as literal argv entries before render", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-desktop-history-argv-"));
    roots.push(root);
    const executable = join(root, "omp");
    const invocationPath = join(root, "invocation.txt");
    await writeFile(executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(invocationPath)}\nprintf 'fixture history\\n'\n`);
    await chmod(executable, 0o700);
    const configuredArgs = ["--fixture-option", "fixed;literal"];
    const file = "/sessions/argv-safe.jsonl";

    const response = await renderSessionHistory({ file, cols: 80, rows: 24, omp: executable, args: configuredArgs });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture history");
    expect((await readFile(invocationPath, "utf8")).trimEnd().split("\n")).toEqual([
      ...configuredArgs, "render", file, "--width", "80", "--height", "24",
    ]);
  });

  test("cancellation reaps a renderer and permits another while the second remains active", async () => {
    const omp = await fakeOmp("printf '%s\\n' \"$$\"; exec sleep 30");
    const start = async (file: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await renderSessionHistory({ file, cols: 80, rows: 24, omp, signal: controller.signal });
      if (!response.body) throw new Error("Renderer did not expose a body");
      const reader = response.body.getReader();
      readers.push(reader);
      const first = await reader.read();
      const pid = Number(new TextDecoder().decode(first.value).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Renderer did not expose its owned PID");
      return { reader, pid };
    };
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const first = await start("/sessions/a.jsonl");
    const second = await start("/sessions/b.jsonl");
    await first.reader.cancel();
    expect(alive(first.pid)).toBe(false);
    const third = await start("/sessions/c.jsonl");
    expect(alive(second.pid)).toBe(true);
    expect(alive(third.pid)).toBe(true);
    await second.reader.cancel();
    await third.reader.cancel();
    expect(alive(second.pid)).toBe(false);
    expect(alive(third.pid)).toBe(false);
  });
});
