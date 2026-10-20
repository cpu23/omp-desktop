/**
 * Regression tests for the runtime pool's durable semantics.
 *
 * The daemon's ledger records exactly `liveSessions()`, and a restart replays
 * it; these tests pin the two properties that keep that honest: one transcript
 * never runs in two processes (including concurrent resume requests), and the
 * snapshot follows the real lifecycle — a stop or an exit leaves the pool,
 * while a sniffed transcript joins it.
 *
 * `Runtime` spawns through a real PTY. Most tests use tiny stand-in binaries
 * that ignore omp's flags; the termination regression uses real interactive
 * Bash children so cleanup is observable at the process level.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager, PendingRuntimeCapacityError } from "./manager";

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

function manager(file = waitingOmp, args: string[] = []): RuntimeManager {
  const created = new RuntimeManager({
    file,
    args,
    cwd: dir,
    cols: 80,
    rows: 24,
    env: { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function linuxResourceCounts() {
  return {
    fds: readdirSync("/proc/self/fd").length,
    threads: readdirSync("/proc/self/task").length,
  };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.killAll("SIGKILL")));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("durable pool snapshots", () => {
  const transcript = "/home/user/.omp/agent/sessions/-dev/2026-10-05T00-00-00-000Z_a.jsonl";

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

  test.skipIf(process.platform === "win32")("interactive Bash children ignoring SIGTERM are reaped on stop and shutdown", async () => {
    const pool = manager("/bin/bash", ["-i", "-c", "trap '' TERM; : > bash-ready-$$; read -r"]);
    const stopped = await pool.create({});
    const remaining = await pool.create({});
    stopped.start();
    remaining.start();
    const stoppedPid = stopped.pid;
    const remainingPid = remaining.pid;
    if (stoppedPid === null || remainingPid === null) throw new Error("interactive Bash did not start");
    await waitFor(
      () =>
        processExists(stoppedPid) &&
        processExists(remainingPid) &&
        existsSync(join(dir, `bash-ready-${stoppedPid}`)) &&
        existsSync(join(dir, `bash-ready-${remainingPid}`)),
      "interactive Bash children to install their SIGTERM traps",
    );

    expect(pool.kill(stopped.id)).toBe(true);
    expect(pool.get(stopped.id)).toBeUndefined();
    const shutdown = pool.killAll();
    expect(pool.list()).toEqual([]);
    await shutdown;

    expect(stopped.status).toBe("exited");
    expect(remaining.status).toBe("exited");
    expect(processExists(stoppedPid)).toBe(false);
    expect(processExists(remainingPid)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("PTY exit releases native handles and writer threads", async () => {
    const pool = manager("/bin/sh", ["-c", "exit 0"]);
    const warmup = await pool.create({});
    warmup.start();
    await waitFor(() => warmup.status === "exited", "warmup PTY child exit");
    pool.kill(warmup.id);
    const baseline = linuxResourceCounts();

    for (let index = 0; index < 12; index += 1) {
      const runtime = await pool.create({});
      runtime.start();
      await waitFor(() => runtime.status === "exited", `PTY child ${index + 1} exit`);
      expect(pool.kill(runtime.id)).toBe(true);
    }

    await waitFor(() => {
      const current = linuxResourceCounts();
      return current.fds <= baseline.fds + 2 && current.threads <= baseline.threads + 2;
    }, "native PTY resources to return to baseline");
    const after = linuxResourceCounts();
    expect(after.fds).toBeLessThanOrEqual(baseline.fds + 2);
    expect(after.threads).toBeLessThanOrEqual(baseline.threads + 2);
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
    // kinds matter: only "exited" is provisional for the durable record.
    expect(changes).toEqual(["started", "stopped", "started", "exited"]);
  });

  test("a pending lower limit counts allocations, including transcript-less runtimes", async () => {
    const pool = manager();
    // A fresh runtime is a real allocation (an omp process is coming) even
    // though nothing knows its transcript yet.
    await pool.create({});
    expect(pool.liveSessions()).toEqual([]);
    expect(pool.allocated()).toBe(1);

    let refused: unknown;
    try {
      await pool.create({}, { maxRuntimes: 1 });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PendingRuntimeCapacityError);
    expect(pool.list()).toHaveLength(1);
  });

  test("concurrent creates cannot both pass a pending lower limit", async () => {
    const pool = manager();
    const settled = await Promise.allSettled([
      pool.create({}, { maxRuntimes: 1 }),
      pool.create({}, { maxRuntimes: 1 }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PendingRuntimeCapacityError);
    expect(pool.allocated()).toBe(1);
  });

  test("an exited runtime no longer counts against a pending lower limit", async () => {
    const pool = manager();
    const runtime = await pool.create({ resume: transcript });
    expect(pool.allocated()).toBe(1);
    runtime.write("\n");
    await waitFor(() => runtime.status === "exited", "the stand-in omp to exit");
    expect(pool.allocated()).toBe(0);
  });
});
