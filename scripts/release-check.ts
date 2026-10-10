#!/usr/bin/env bun
/** Fresh installs and shared-runtime smoke, without using the caller's config or services. */
import { mkdtemp, mkdir, copyFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, "../..");
const bun = Bun.which("bun") ?? process.execPath;
const omp = Bun.which(process.env.OMP_DESKTOP_OMP ?? "omp");
if (!omp) throw new Error("Install the OMP CLI or set OMP_DESKTOP_OMP before running release:check.");
const root = await mkdtemp(join(tmpdir(), "omp-release-check-"));
const home = join(root, "home");
const checkout = join(root, "checkout");
const tokenFile = join(home, ".config/omp-mobile/token");
const ipc = join(home, ".local/state/omp-mobile");
const env: Record<string, string> = {
  HOME: home,
  PATH: `${dirname(bun)}:/usr/local/bin:/usr/bin:/bin`,
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OMP_DESKTOP_OMP: omp,
  OMP_DESKTOP_CWD: home,
  OMP_DESKTOP_SESSIONS_DIR: join(home, ".omp/agent/sessions"),
  OMP_DESKTOP_PASTE_DIR: join(root, "pastes"),
  OMP_MOBILE_ROOT: home,
  OMP_MOBILE_IPC_DIR: ipc,
  OMP_MOBILE_TOKEN_FILE: tokenFile,
};

type Child = { proc: Bun.Subprocess; stdout: Promise<string>; stderr: Promise<string> };
const services: Child[] = [];
function spawn(cwd: string, args: string[]): Child {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { proc, stdout: new Response(proc.stdout).text(), stderr: new Response(proc.stderr).text() };
}
async function command(cwd: string, args: string[], quiet = false): Promise<string> {
  const child = spawn(cwd, args);
  const code = await child.proc.exited;
  const stdout = await child.stdout;
  const stderr = await child.stderr;
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}):\n${stdout}\n${stderr}`);
  if (!quiet) console.log(stdout.trim(), stderr.trim());
  return stdout;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  console.log(`ok - ${message}`);
}
function unusedPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Could not allocate a private test port.");
  return port;
}
async function ready(base: string, child: Child): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.proc.exitCode !== null) throw new Error(`Service exited: ${await child.stderr}`);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Service did not become ready: ${base}`);
}

console.log(`Release check: disposable workspace ${root}`);
try {
  await mkdir(home, { recursive: true });
  await mkdir(env.TMPDIR!, { recursive: true });
  for (const project of ["omp-desktop", "omp-mobile"]) {
    const from = join(source, project);
    // Include current edits/new public files, not just HEAD; never copy ignored private files.
    const ignoredTracked = await command(from, ["git", "ls-files", "-ci", "--exclude-standard"], true);
    if (ignoredTracked.trim()) throw new Error(`${project} tracks ignored private/generated files; untrack them before release.`);
    const files = (await command(from, ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], true)).split("\0").filter(Boolean);
    for (const file of files) {
      const exists = await stat(join(from, file)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false; // Deleted in the current working tree.
        throw error;
      });
      if (!exists) continue;
      const destination = join(checkout, project, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(from, file), destination);
    }
    const cwd = join(checkout, project);
    await command(cwd, [bun, "install", "--frozen-lockfile"]);
    await command(cwd, [bun, "run", "check"]);
    await command(cwd, [bun, "test"]);
  }
  const desktop = join(checkout, "omp-desktop");
  const mobile = join(checkout, "omp-mobile");
  await command(desktop, [bun, "run", "smoke"]);
  await command(mobile, [bun, "run", "build"]);
  await command(mobile, [bun, "run", "setup"]);
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert(((await stat(tokenFile)).mode & 0o777) === 0o600, "setup token is owner-only");
  await command(mobile, [bun, "run", "setup"]);
  assert((await readFile(tokenFile, "utf8")).trim() === token, "repeated setup preserves the token");
  assert((await command(mobile, [bun, "run", "setup", "--show"], true)).trim() === token, "explicit onboarding reads the same token");

  const desktopPort = unusedPort();
  const mobilePort = unusedPort();
  const desktopBase = `http://127.0.0.1:${desktopPort}`;
  const mobileBase = `http://127.0.0.1:${mobilePort}`;
  env.OMP_DESKTOP_PORT = String(desktopPort);
  env.OMP_MOBILE_PORT = String(mobilePort);
  env.OMP_MOBILE_DESKTOP_URL = desktopBase;
  const daemon = spawn(desktop, [bun, "run", "start"]);
  services.push(daemon);
  const gateway = spawn(mobile, [bun, "run", "start"]);
  services.push(gateway);
  await Promise.all([ready(desktopBase, daemon), ready(mobileBase, gateway)]);
  const headers = { Authorization: `Bearer ${token}`, Origin: mobileBase, "Content-Type": "application/json" };
  assert((await fetch(`${mobileBase}/api/slots`)).status === 401, "gateway rejects unauthenticated session access");
  assert((await fetch(`${mobileBase}/api/slots`, { headers: { ...headers, Origin: "https://evil.example" } })).status === 403, "gateway rejects an unrelated browser origin");
  const created = await fetch(`${mobileBase}/api/slots`, { method: "POST", headers, body: JSON.stringify({ cwd: home }) });
  assert(created.ok, "mobile starts a real runtime through desktop");
  const live = await fetch(`${mobileBase}/api/slots`, { headers }).then(r => r.json()) as { slots: { id: string }[] };
  assert(live.slots.length === 1, "fresh gateway exposes exactly its new runtime");
  const id = live.slots[0]!.id;
  const runtimes = await fetch(`${desktopBase}/api/runtimes`).then(r => r.json()) as { runtimes: { id: string; pid: number | null; cwd: string }[] };
  assert(runtimes.runtimes.some(r => r.id === id && r.pid !== null && r.cwd === home), "desktop and mobile share one real process in the disposable home");
  let state: Response | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await fetch(`${mobileBase}/api/slots/${id}/state`, { headers });
    if (state.ok) break;
    await Bun.sleep(100);
  }
  assert(state?.ok, "real OMP extension serves structured session state");
  assert(((await stat(join(ipc, `${id}.sock`))).mode & 0o777) === 0o600, "extension socket is owner-only");
  const stopped = await fetch(`${mobileBase}/api/slots/${id}`, { method: "DELETE", headers });
  assert(stopped.ok, "mobile stops its test runtime");
  const remaining = await fetch(`${desktopBase}/api/runtimes`).then(r => r.json()) as { runtimes: unknown[] };
  assert(remaining.runtimes.length === 0, "desktop no longer lists the stopped runtime");
  console.log("RELEASE CHECK PASSED (native shell, provider login and real push delivery require separate verification)");
} finally {
  for (const child of services.reverse()) {
    if (child.proc.exitCode === null) child.proc.kill("SIGTERM");
    await child.proc.exited;
  }
  await rm(root, { recursive: true, force: true });
}
