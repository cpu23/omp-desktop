import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "omp-desktop-daemon-smoke-"));
const home = join(root, "home");
const state = join(root, "state");
const bun = Bun.which("bun") ?? process.execPath;
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
const port = portProbe.port;
portProbe.stop(true);
if (port === undefined) throw new Error("Could not allocate a loopback port for the daemon smoke.");
const base = `http://127.0.0.1:${port}`;
const proc = Bun.spawn([bun, "run", join(import.meta.dir, "../src/daemon.ts")], {
  cwd: root,
  env: {
    HOME: home,
    PATH: `${dirname(bun)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OMP_DESKTOP_HOST: "127.0.0.1",
    OMP_DESKTOP_PORT: String(port),
    OMP_DESKTOP_CWD: root,
    OMP_DESKTOP_OMP: "/bin/false",
    OMP_DESKTOP_EXTENSION: "",
    OMP_DESKTOP_SESSIONS_DIR: join(home, ".omp/agent/sessions"),
    OMP_DESKTOP_STATE_DIR: state,
    OMP_DESKTOP_PASTE_DIR: join(root, "pastes"),
    OMP_MOBILE_IPC_DIR: join(home, ".local/state/omp-mobile"),
    OMP_MOBILE_TOKEN_FILE: join(home, ".config/omp-mobile/token"),
  },
  stdout: "ignore",
  stderr: "pipe",
});
const stderr = new Response(proc.stderr).text();

try {
  let ready = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && proc.exitCode === null) {
    let response: Response | undefined;
    try {
      response = await fetch(`${base}/api/build`, { signal: AbortSignal.timeout(500) });
    } catch {
      // The daemon is still starting.
    }
    if (response?.ok) {
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("build" in payload) ||
        typeof payload.build !== "string" ||
        payload.build.length === 0
      ) {
        throw new Error("Daemon /api/build returned an invalid payload.");
      }
      console.log(`ok - isolated daemon build API responds (${payload.build})`);
      ready = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!ready) {
    const detail = proc.exitCode === null ? "timed out" : `exited with code ${proc.exitCode}`;
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await proc.exited;
    }
    throw new Error(`Daemon did not become ready (${detail}):\n${(await stderr).slice(0, 2000)}`);
  }

  const response = await fetch(`${base}/api/runtimes`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`/api/runtimes returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("runtimes" in payload) ||
    !Array.isArray(payload.runtimes) ||
    payload.runtimes.length !== 0
  ) {
    throw new Error("Fresh daemon /api/runtimes did not return an empty runtime list.");
  }
  console.log("ok - isolated daemon runtime API responds with no existing sessions");
  console.log("DAEMON SMOKE PASSED");
} finally {
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  await rm(root, { recursive: true, force: true });
}
