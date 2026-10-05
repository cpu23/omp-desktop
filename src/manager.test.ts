/**
 * Regression tests for the runtime pool's durable semantics.
 *
 * The daemon's ledger records exactly `liveSessions()`, and a restart replays
 * it; these tests pin the two properties that keep that honest: one transcript
 * never runs in two processes (including concurrent resume requests), and the
 * snapshot follows the real lifecycle — a stop or an exit leaves the pool,
 * while a sniffed transcript joins it.
 *
 * `Runtime` spawns through a real PTY, so the tests use tiny stand-in binaries
 * that ignore omp's flags: one waits for a line and exits, one announces an
 * OSC 1337 session file like omp does.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager } from "./manager";

const dir = mkdtempSync(join(tmpdir(), "omp-manager-test-"));
const waitingOmp = join(dir, "fake-omp");
const sniffingOmp = join(dir, "fake-omp-sniff");
const announced = join(dir, "sessions", "-tmp-fixture", "2026-10-05T00-00-00-000Z_01a10000-0000-7000-8000-00000000ab01.jsonl");

writeFileSync(waitingOmp, "#!/bin/sh\nprintf 'fake-omp-ready\\n'\nread line\nexit 0\n");
chmodSync(waitingOmp, 0o755);
writeFileSync(
  sniffingOmp,
  `#!/bin/sh\nprintf '\\033]1337;SetUserVar=omp_session_file=${Buffer.from(announced).toString("base64")}\\007'\nread line\nexit 0\n`,
);
chmodSync(sniffingOmp, 0o755);

const managers: RuntimeManager[] = [];

function manager(file = waitingOmp): RuntimeManager {
  const created = new RuntimeManager({
    file,
    args: [],
    cwd: dir,
    cols: 80,
    rows: 24,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
    maxRuntimes: 8,
  });
  managers.push(created);
  return created;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  // A real PTY is the thing under test (spawn, sniff, exit are platform
  // events); there is no timer seam to fake here, so poll the observable state.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  for (const created of managers.splice(0)) created.killAll();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("durable pool snapshots", () => {
  const transcript = "/home/mrw/.omp/agent/sessions/-dev/2026-10-05T00-00-00-000Z_a.jsonl";

  test("a resume claims its transcript before omp sniffs it and joins the pool", async () => {
    const pool = manager();
    const runtime = await pool.create({ resume: transcript });
    expect(runtime.sessionFile).toBe(transcript);
    expect(runtime.alive).toBe(true);
    expect(pool.liveSessions()).toEqual([{ sessionFile: transcript, cwd: dir, cols: 80, rows: 24 }]);
  });

  test("a second resume of the same transcript reuses one process", async () => {
    const pool = manager();
    const first = await pool.create({ resume: transcript });
    const second = await pool.create({ resume: transcript });
    expect(second.id).toBe(first.id);
    expect(pool.list()).toHaveLength(1);
  });

  test("concurrent resumes of one transcript share a single in-flight process", async () => {
    const pool = manager();
    const [a, b, c] = await Promise.all([
      pool.create({ resume: transcript }),
      pool.create({ resume: transcript }),
      pool.create({ resume: transcript }),
    ]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(pool.list()).toHaveLength(1);
    expect(pool.liveSessions()).toHaveLength(1);
  });

  test("an explicit stop leaves the pool", async () => {
    const pool = manager();
    const runtime = await pool.create({ resume: transcript });
    expect(pool.kill(runtime.id)).toBe(true);
    expect(pool.liveSessions()).toEqual([]);
    expect(pool.get(runtime.id)).toBeUndefined();
    // A stopped transcript is started again only by a new explicit resume.
    const replacement = await pool.create({ resume: transcript });
    expect(replacement.id).not.toBe(runtime.id);
  });

  test("an exited process leaves the pool; a later resume starts a replacement", async () => {
    const pool = manager();
    const runtime = await pool.create({ resume: transcript });
    runtime.write("\n");
    await waitFor(() => runtime.status === "exited", "the stand-in omp to exit");
    expect(pool.liveSessions()).toEqual([]);
    const replacement = await pool.create({ resume: transcript });
    expect(replacement.id).not.toBe(runtime.id);
    expect(replacement.alive).toBe(true);
  });

  test("a transcript-less runtime is not restorable, and a sniffed transcript joins the pool", async () => {
    const reserved = manager();
    const fresh = await reserved.create({});
    expect(fresh.sessionFile).toBeNull();
    expect(reserved.liveSessions()).toEqual([]);

    const sniffing = manager(sniffingOmp);
    const announcedRuntime = await sniffing.create({});
    expect(sniffing.liveSessions()).toEqual([]);
    announcedRuntime.start();
    await waitFor(() => sniffing.liveSessions().some((entry) => entry.sessionFile === announced), "the announced transcript");
    expect(sniffing.liveSessions()).toEqual([{ sessionFile: announced, cwd: dir, cols: 80, rows: 24 }]);
  });

  test("subscribers hear starts, stops and exits exactly once each", async () => {
    const pool = manager();
    const changes: string[] = [];
    const unsubscribe = pool.subscribeChanges((change) => changes.push(change));
    const stopped = await pool.create({ resume: transcript });
    // The exit of the stopped process is the only source of a stray event; the
    // runtime's own subscription fires after the pool's, so awaiting it proves
    // no late pool change follows a kill.
    const stoppedExited = new Promise<void>((resolve) => stopped.subscribeExit(() => resolve()));
    pool.kill(stopped.id);
    await stoppedExited;
    const exited = await pool.create({ resume: transcript });
    exited.write("\n");
    await waitFor(() => exited.status === "exited", "the stand-in omp to exit");
    unsubscribe();
    // The kinds matter: only "exited" is provisional for the durable record.
    expect(changes).toEqual(["started", "stopped", "started", "exited"]);
  });
});
