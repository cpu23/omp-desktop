import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { renderSessionHistory } from "./session-history";

const roots: string[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
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

  test("keeps the final answer after output larger than a pipe buffer", async () => {
    const payload = `${"history line\n".repeat(200_000)}FINAL ANSWER\n`;
    const omp = await fakeOmp(
      `exec ${JSON.stringify(process.execPath)} -e 'process.stdout.write("history line\\n".repeat(200000) + "FINAL ANSWER\\n"); process.exit(0)'`,
    );
    const response = await renderSessionHistory({ file: "/sessions/large.jsonl", cols: 80, rows: 24, omp });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
  });

  test("cancellation reaps a renderer and permits another while the second remains active", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-history-cancellation-"));
    roots.push(root);
    const omp = await fakeOmp('printf "%s\\n" "$$" > "$2.tmp"; mv "$2.tmp" "$2"; exec sleep 30');
    const start = async (name: string) => {
      const file = join(root, name);
      const controller = new AbortController();
      controllers.push(controller);
      // A separate OS process publishes its PID; fake timers cannot advance it.
      const deadline = Date.now() + 3000;
      const response = renderSessionHistory({ file, cols: 80, rows: 24, omp, signal: controller.signal });
      while (!(await Bun.file(file).exists())) {
        if (Date.now() > deadline) throw new Error("Renderer did not publish its PID");
        await Bun.sleep(10);
      }
      const pid = Number((await Bun.file(file).text()).trim());
      return { controller, response, pid };
    };
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const first = await start("a");
    const second = await start("b");
    first.controller.abort();
    expect((await first.response).status).toBe(499);
    expect(alive(first.pid)).toBe(false);
    const third = await start("c");
    expect(alive(second.pid)).toBe(true);
    expect(alive(third.pid)).toBe(true);
    second.controller.abort();
    third.controller.abort();
    expect((await second.response).status).toBe(499);
    expect((await third.response).status).toBe(499);
    expect(alive(second.pid)).toBe(false);
    expect(alive(third.pid)).toBe(false);
  });
});
