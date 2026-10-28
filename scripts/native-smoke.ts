#!/usr/bin/env bun
/** Exercise the real GTK4/WebKitGTK shell against isolated real daemons and OS-facing fixtures. */
import { access, chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isRecord } from "../src/guards";
import { fakeOmpRecordPath, startTestDaemon, writeTestTranscript, type TestDaemon } from "./fixtures/daemon";
import { runImageAssertions } from "./fixtures/image-assertions";
import { WebDriver, type X11InputBackend } from "./fixtures/webdriver";

import { AccessibilityClient, walkAccessibilityTree, type AccessibilityNode } from "./fixtures/accessibility";
const ROOT = resolve(import.meta.dir, "..");
const MAX_CAPTURE = 64 * 1024;
const PRIVATE_USE_ENTER = "\uE007";
const PRIVATE_USE_CONTROL = "\uE009";
const WEB_DRIVER_BROWSER_OPTIONS = "webkitgtk:browserOptions";
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type Capture = {
  text: string;
  lines: string[];
  pending: string;
  push(chunk: string): void;
};
type ManagedChild = {
  proc: Bun.Subprocess;
  stdout: Capture;
  stderr: Capture;
  streams: Promise<void>[];
  detached: boolean;
};
type Profile = { root: string; home: string; bin: string; env: Record<string, string>; input: X11InputBackend | null };
type Shell = { host: ManagedChild; driver: WebDriver; closed: boolean };
type NormalShell = {
  app: ManagedChild;
  accessibilityProcess: ManagedChild;
  accessibility: AccessibilityClient;
  profile: Profile;
  pid: number;
  windowId: string;
  closed: boolean;
};
type NotificationService = {
  child: ManagedChild;
  events(): Record<string, unknown>[];
  activate(id: number): void;
};
type RuntimeInfo = { id: string; pid: number | null; sessionFile: string | null; title: string; alive: boolean };
type ImageFixtureServer = { port: number; stop(force?: boolean): void };
type ImageFixture = { server: ImageFixtureServer; url: string };
type Workspace = { activeSpaceId: string; spaces: Array<{ id: string; layout: { tree: unknown; panes: Record<string, unknown>; focused: string | null } }> };

function capture(): Capture {
  return {
    text: "",
    lines: [],
    pending: "",
    push(chunk: string) {
      this.text = (this.text + chunk).slice(-MAX_CAPTURE);
      this.pending += chunk;
      for (;;) {
        const newline = this.pending.indexOf("\n");
        if (newline < 0) break;
        const line = this.pending.slice(0, newline).replace(/\r$/, "");
        this.pending = this.pending.slice(newline + 1);
        this.lines.push(line);
        if (this.lines.length > 512) this.lines.shift();
      }
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array> | null | undefined, output: Capture): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) output.push(decoder.decode(value, { stream: true }));
    }
    output.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function spawnTracked(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "ignore" | "pipe";
    stdout?: "ignore" | "pipe";
    stderr?: "ignore" | "pipe";
    detached?: boolean;
  } = {},
): ManagedChild {
  const proc = Bun.spawn({
    cmd,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    detached: options.detached ?? true,
  });
  const stdout = capture();
  const stderr = capture();
  const streams = [drain(proc.stdout, stdout), drain(proc.stderr, stderr)];
  return { proc, stdout, stderr, streams, detached: options.detached ?? true };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function ownedProcessGroupExited(pgid: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    await Bun.sleep(50);
  }
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

async function stopChild(child: ManagedChild, timeoutMs = 5_000): Promise<void> {
  try {
    if (child.detached) process.kill(-child.proc.pid, "SIGTERM");
    else if (child.proc.exitCode === null) child.proc.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      if (child.proc.exitCode === null) child.proc.kill("SIGTERM");
    }
  }
  const exited = child.detached
    ? await ownedProcessGroupExited(child.proc.pid, Date.now() + timeoutMs)
    : await Promise.race([child.proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
  if (!exited) {
    try {
      if (child.detached) process.kill(-child.proc.pid, "SIGKILL");
      else if (child.proc.exitCode === null) child.proc.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH" && child.proc.exitCode === null) child.proc.kill("SIGKILL");
    }
    const killed = child.detached
      ? await ownedProcessGroupExited(child.proc.pid, Date.now() + 5_000)
      : await Promise.race([child.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!killed) throw new Error(`Owned process group ${child.proc.pid} survived SIGKILL.`);
  }
  if (child.proc.exitCode === null) {
    await Promise.race([child.proc.exited, Bun.sleep(5_000)]);
    if (child.proc.exitCode === null && processExists(child.proc.pid)) {
      throw new Error(`Owned child ${child.proc.pid} was not reaped.`);
    }
  }
  const streamsDrained = await Promise.race([
    Promise.all(child.streams).then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!streamsDrained) throw new Error(`Owned child ${child.proc.pid} output streams did not close.`);
}
async function stopChildAndRethrow(child: ManagedChild, error: unknown, context: string): Promise<never> {
  try {
    await stopChild(child);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], context);
  }
  throw error;
}


async function cleanupOwned(label: string, actions: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${label} cleanup failed.`);
}

function requireCommand(names: string[], label: string): string {
  for (const name of names) {
    const found = Bun.which(name);
    if (found) return found;
  }
  throw new Error(`Missing native smoke prerequisite ${label}; install the documented Linux native test packages.`);
}

async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value !== false && value !== null && value !== undefined) return value as T;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}


function jsonRecords(lines: string[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) output.push(value);
    } catch {
      // Startup diagnostics can share stdout with a fixture; only JSON events are records.
    }
  }
  return output;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createProfile(parent: string, name: string, runtimeDir = join(parent, "xdg-runtime")): Promise<Profile> {
  const root = join(parent, name);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const config = join(home, ".config");
  const data = join(home, ".local", "share");
  const cache = join(home, ".cache");
  const state = join(home, ".local", "state");
  await Promise.all([root, home, bin, config, data, cache, state].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const path = `${bin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  const env: Record<string, string> = {
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: runtimeDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: "xterm-256color",
    DBUS_SESSION_BUS_ADDRESS: "",
  };
  for (const key of [
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
    "XAUTHORITY", "GDK_BACKEND", "GSK_RENDERER", "LD_LIBRARY_PATH", "IMLIB2_LOADER_PATH",
    "WEBKIT_FORCE_DMABUF_RENDERER", "WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const inheritedWaylandDisplay = process.env.WAYLAND_DISPLAY;
  const inheritedRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (inheritedWaylandDisplay && !isAbsolute(inheritedWaylandDisplay) && inheritedRuntimeDir) {
    // Keep the compositor socket usable while XDG_RUNTIME_DIR points at the isolated fixture bus/runtime tree.
    env.WAYLAND_DISPLAY = resolve(inheritedRuntimeDir, inheritedWaylandDisplay);
  }
  return { root, home, bin, env, input: null };
}

async function installExternalOpener(profile: Profile): Promise<string> {
  const log = join(profile.root, "external-open.log");
  const path = join(profile.bin, "xdg-open");
  await writeFile(path, "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$OMP_DESKTOP_OPEN_LOG\"\n", { mode: 0o700 });
  await chmod(path, 0o700);
  profile.env.OMP_DESKTOP_OPEN_LOG = log;
  return log;
}

async function startPrivateBus(runtimeDir: string, home: string): Promise<{ address: string; child: ManagedChild; binary: string }> {
  const binary = requireCommand(["dbus-daemon"], "dbus-daemon");
  const child = spawnTracked([binary, "--session", "--nofork", "--print-address=1", "--print-pid=1"], {
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: "",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    },
  });
  try {
    const address = await waitFor("the fixture-owned private D-Bus address", () => {
      if (child.proc.exitCode !== null) throw new Error(`dbus-daemon exited: ${child.stderr.text}`);
      return child.stdout.lines.find((line) => line.startsWith("unix:") || line.startsWith("tcp:")) ?? false;
    }, 10_000);
    return { address, child, binary };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function startNotificationService(
  root: string,
  address: string,
  runtimeDir: string,
): Promise<NotificationService> {
  const python = await fileExists("/usr/bin/python3") ? "/usr/bin/python3" : requireCommand(["python3"], "Python 3 with PyGObject");
  const service = join(ROOT, "scripts", "fixtures", "notification-service.py");
  const child = spawnTracked([python, service], {
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      LANG: process.env.LANG ?? "C.UTF-8",
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: address,
    },
    stdin: "pipe",
  });
  try {
    await waitFor("the fixture notification service name", () => {
      if (child.proc.exitCode !== null) throw new Error(`notification fixture exited: ${child.stderr.text}\n${child.stdout.text}`);
      return jsonRecords(child.stdout.lines).some((event) => event.event === "ready") || false;
    }, 10_000);
    return {
      child,
      events: () => jsonRecords(child.stdout.lines).filter((event) => ["delivery", "closed", "activated", "activation-ignored"].includes(String(event.event))),
      activate(id) {
        const input = child.proc.stdin;
        if (!input || typeof input === "number") throw new Error("Notification fixture has no writable command pipe.");
        input.write(`${JSON.stringify({ activate: id })}\n`);
        input.flush();
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function allocatePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function processOwnsListener(pid: number, port: number): Promise<boolean> {
  const wanted = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table = "";
    try {
      table = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10 || columns[3] !== "0A") continue;
      const localPort = columns[1]?.split(":").at(-1)?.toUpperCase();
      if (localPort === wanted) inodes.add(columns[9]!);
    }
  }
  if (inodes.size === 0) return false;
  let descriptors: string[];
  try {
    descriptors = await readdir(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const descriptor of descriptors) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1]!)) return true;
    } catch {
      // The listener may close between listing and readlink.
    }
  }
  return false;
}

async function startWebDriver(env: Record<string, string>): Promise<{ child: ManagedChild; endpoint: string; binary: string }> {
  const binary = requireCommand(["WebKitWebDriver", "webkitgtk-driver", "webkitgtk-webdriver", "webkit2gtk-driver"], "WebKitWebDriver");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await allocatePort();
    const child = spawnTracked([binary, "--host=127.0.0.1", `--port=${port}`], { env });
    try {
      const listener = await waitFor<true | "bind-conflict">("the owned WebKitWebDriver listener", async () => {
        if (child.proc.exitCode !== null) {
          const detail = `${child.stdout.text}\n${child.stderr.text}`;
          if (/address already in use|failed to bind|bind.*in use|EADDRINUSE/i.test(detail)) return "bind-conflict";
          throw new Error(`WebKitWebDriver exited before listening: ${detail}`);
        }
        return await processOwnsListener(child.proc.pid, port) || false;
      }, 12_000);
      if (listener === "bind-conflict") {
        await stopChild(child);
        continue;
      }
      const endpoint = `http://127.0.0.1:${port}`;
      await waitFor("WebKitWebDriver status", async () => {
        try {
          const response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(500) });
          return response.ok ? true : false;
        } catch {
          return false;
        }
      }, 10_000);
      return { child, endpoint, binary };
    } catch (error) {
      await stopChildAndRethrow(child, error, "WebKitWebDriver startup failed and its child cleanup failed.");
    }
  }
  throw new Error("Could not allocate an owned WebKitWebDriver listener after five bind conflicts.");
}

async function openShell(profile: Profile, port: number, binary: string): Promise<Shell> {
  const env = { ...profile.env, OMP_DESKTOP_PORT: String(port) };
  const host = await startWebDriver(env);
  const sessionStartedAt = Date.now();
  console.log("Starting WebKitWebDriver automation session.");
  try {
    const driver = await WebDriver.create(host.endpoint, {
      browserName: "omp-desktop",
      pageLoadStrategy: "none",
      [WEB_DRIVER_BROWSER_OPTIONS]: { binary, args: ["--automation-mode"] },
    }, profile.input ?? undefined);
    console.log(`WebKitWebDriver automation session is ready after ${Date.now() - sessionStartedAt}ms.`);
    console.log(`Negotiated WebDriver capabilities: ${JSON.stringify(driver.capabilities)}`);
    return { host: host.child, driver, closed: false };
  } catch (error) {
    const diagnostics = [
      `WebKitWebDriver binary: ${host.binary}`,
      `WebKitWebDriver endpoint: ${host.endpoint}`,
      `WebKitWebDriver pid/exit: ${host.child.proc.pid}/${String(host.child.proc.exitCode)}`,
      `GTK launch environment: DISPLAY=${JSON.stringify(profile.env.DISPLAY ?? "")} GDK_BACKEND=${JSON.stringify(profile.env.GDK_BACKEND ?? "")} XDG_RUNTIME_DIR=${JSON.stringify(profile.env.XDG_RUNTIME_DIR ?? "")}`,
      `WebKitWebDriver stdout:\n${host.child.stdout.text || "(empty)"}`,
      `WebKitWebDriver stderr:\n${host.child.stderr.text || "(empty)"}`,
    ].join("\n");
    const failure = new Error(`Automated GTK window creation failed: ${String(error)}\n${diagnostics}`, { cause: error });
    try {
      await stopChild(host.child);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "Automated GTK startup and WebKitWebDriver cleanup failed.");
    }
    throw failure;
  }
}

async function closeShell(shell: Shell): Promise<void> {
  if (shell.closed) return;
  shell.closed = true;
  try {
    await shell.driver.close();
  } finally {
    await stopChild(shell.host);
  }
}

function parseRuntimes(value: unknown): RuntimeInfo[] {
  if (!isRecord(value) || !Array.isArray(value.runtimes)) throw new Error("GET /api/runtimes returned an invalid response.");
  return value.runtimes.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.alive !== "boolean") {
      throw new Error("GET /api/runtimes contained an invalid runtime.");
    }
    return {
      id: entry.id,
      pid: typeof entry.pid === "number" ? entry.pid : null,
      sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : null,
      title: typeof entry.title === "string" ? entry.title : "",
      alive: entry.alive,
    };
  });
}

async function runtimes(base: string): Promise<RuntimeInfo[]> {
  const response = await fetch(`${base}/api/runtimes`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`GET /api/runtimes returned ${response.status}: ${await response.text()}`);
  return parseRuntimes(await response.json());
}

async function screen(base: string, id: string): Promise<string> {
  const response = await fetch(`${base}/api/runtimes/${encodeURIComponent(id)}/screen`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`GET /api/runtimes/${id}/screen returned ${response.status}.`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.screen !== "string") throw new Error("The runtime screen response had no terminal text.");
  return payload.screen;
}

async function readRecord(root: string, id: string): Promise<Buffer> {
  try {
    return await readFile(fakeOmpRecordPath(root, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}
function normalizeScreenRows(value: string): string {
  // The public screen snapshot joins terminal rows; xterm soft-wraps long output,
  // so ignore row padding/breaks while matching a single known no-space marker.
  return value.replace(/\s+/g, "");
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function getWorkspace(base: string): Promise<Workspace> {
  const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`GET /api/state returned ${response.status}.`);
  const value: unknown = await response.json();
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.state.layout)) {
    throw new Error("GET /api/state has no workspace layout.");
  }
  const layout = value.state.layout;
  if (typeof layout.activeSpaceId !== "string" || !Array.isArray(layout.spaces)) {
    throw new Error("The saved workspace has an invalid space index.");
  }
  const spaces = layout.spaces.map((space) => {
    if (!isRecord(space) || typeof space.id !== "string" || !isRecord(space.layout) || !isRecord(space.layout.panes)) {
      throw new Error("The saved workspace contains an invalid space layout.");
    }
    return {
      id: space.id,
      layout: {
        tree: space.layout.tree,
        panes: space.layout.panes,
        focused: typeof space.layout.focused === "string" ? space.layout.focused : null,
      },
    };
  });
  return { activeSpaceId: layout.activeSpaceId, spaces };
}


function workspaceSignature(workspace: Workspace): string {
  // Titles are refreshed from live PTY metadata after reconnect; the persisted pane/session binding is authoritative.
  return JSON.stringify({
    activeSpaceId: workspace.activeSpaceId,
    spaces: workspace.spaces.map((space) => ({
      id: space.id,
      tree: space.layout.tree,
      focused: space.layout.focused,
      panes: Object.fromEntries(Object.entries(space.layout.panes).map(([id, binding]) => [
        id,
        isRecord(binding) ? {
          runtimeId: binding.runtimeId ?? null,
          sessionFile: binding.sessionFile ?? null,
          autoResume: binding.autoResume ?? null,
          keepEmpty: binding.keepEmpty ?? null,
        } : binding,
      ])),
    })),
  });
}
async function waitForWorkspaceBindings(
  base: string,
  label: string,
): Promise<{ workspace: Workspace; runtimes: RuntimeInfo[] }> {
  return await waitFor(label, async () => {
    const [workspace, current] = await Promise.all([getWorkspace(base), runtimes(base)]);
    if (current.length === 0 || current.some((runtime) =>
      !runtime.alive || runtime.pid === null || runtime.sessionFile === null
    )) return false;
    const byId = new Map(current.map((runtime) => [runtime.id, runtime]));
    const bound = workspace.spaces.flatMap((space) => Object.values(space.layout.panes))
      .filter((binding): binding is Record<string, unknown> & { runtimeId: string } =>
        isRecord(binding) && typeof binding.runtimeId === "string");
    if (bound.length === 0) return false;
    if (bound.some((binding) => {
      const runtime = byId.get(binding.runtimeId);
      return !runtime || runtime.sessionFile === null || binding.sessionFile !== runtime.sessionFile;
    })) return false;
    return { workspace, runtimes: current };
  });
}

async function activePaneBindings(driver: WebDriver, base: string): Promise<Array<{ paneId: string; runtimeId: string }>> {
  const uiPanes = await driver.execute<Array<{ paneId: string }>>(
    `return Array.from(document.querySelectorAll("#panes .pane"), pane => ({ paneId: pane.dataset.pane || "" }));`,
  );
  const workspace = await getWorkspace(base);
  const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  if (!active) throw new Error("The saved active space is missing.");
  return uiPanes.flatMap(({ paneId }) => {
    const binding = active.layout.panes[paneId];
    return isRecord(binding) && typeof binding.runtimeId === "string" ? [{ paneId, runtimeId: binding.runtimeId }] : [];
  });
}
async function waitForRuntimePaneReady(driver: WebDriver, base: string, runtimeId: string): Promise<void> {
  await driver.waitFor(async () => {
    const binding = (await activePaneBindings(driver, base)).find((pane) => pane.runtimeId === runtimeId);
    if (!binding) return false;
    const pane = await driver.find(`#panes .pane[data-pane="${binding.paneId}"]`).catch(() => null);
    return pane ? await driver.execute<boolean>(
      `const pane = arguments[0]; const busy = pane.querySelector('.pane-body')?.hasAttribute('aria-busy'); const starting = pane.querySelector('.pane-starting')?.hidden; return busy === false && starting === true;`,
      [pane],
    ) : false;
  }, `WebSocket attachment and replay completion for runtime ${runtimeId}`, 25_000);
}


async function waitConnected(driver: WebDriver, port: number): Promise<void> {
  const startedAt = Date.now();
  const expectedOrigin = `http://127.0.0.1:${port}`;
  await driver.waitFor(async () => {
    const url = await driver.execute<string>("return location.href");
    return url.startsWith(expectedOrigin) ? true : false;
  }, "bootstrap to connect to the configured daemon", 30_000);
  await driver.waitFor(async () => await driver.execute<boolean>("return Boolean(document.querySelector('#new-session'))"), "the real desktop UI", 30_000);
  const shellMarker = await driver.execute<string | null>(
    `return window.__OMP_DESKTOP_SHELL__ ?? null;`,
  );
  assert(shellMarker === "gtk", `Connected daemon page had native-shell marker ${JSON.stringify(shellMarker)}.`);
  console.log(`Connected GTK WebView to ${expectedOrigin} in ${Date.now() - startedAt}ms.`);
}
type NativeLayout = {
  viewportWidth: number;
  viewportHeight: number;
  paneWidth: number;
  paneHeight: number;
};

async function measureNativeLayout(driver: WebDriver): Promise<NativeLayout> {
  return await driver.execute<NativeLayout>(`const panes = document.getElementById("panes");
    const pane = panes?.querySelector(".pane");
    const bounds = pane?.getBoundingClientRect();
    return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      paneWidth: bounds?.width ?? 0, paneHeight: bounds?.height ?? 0 };`);
}

async function verifyNativeResize(driver: WebDriver): Promise<void> {
  const originalRect = await driver.windowRect();
  const before = await measureNativeLayout(driver);
  assert(before.paneWidth > 0 && before.paneHeight > 0,
    `The initial WebView pane had no allocated area: ${JSON.stringify(before)}.`);
  const requested = await driver.setWindowRect(1100, 700);
  assert(requested.width === 1100 && requested.height === 700,
    `WebDriver did not accept the 1100x700 native resize (${requested.width}x${requested.height}).`);
  const resized = await driver.waitFor(async () => {
    const layout = await measureNativeLayout(driver);
    return layout.viewportWidth < before.viewportWidth &&
      layout.viewportHeight < before.viewportHeight &&
      layout.paneWidth < before.paneWidth &&
      layout.paneHeight < before.paneHeight ? layout : false;
  }, "native window resize to propagate into the WebView viewport and pane allocation", 15_000);
  await driver.setWindowRect(originalRect.width, originalRect.height);
  const restored = await driver.waitFor(async () => {
    const layout = await measureNativeLayout(driver);
    return Math.abs(layout.viewportWidth - before.viewportWidth) <= 2 &&
      Math.abs(layout.viewportHeight - before.viewportHeight) <= 2 &&
      Math.abs(layout.paneWidth - before.paneWidth) <= 2 &&
      Math.abs(layout.paneHeight - before.paneHeight) <= 2 ? layout : false;
  }, "native window restore to return the WebView viewport and pane allocation", 15_000);
  console.log(`ok - native resize 1100x700 changed viewport/pane to ${resized.viewportWidth}x${resized.viewportHeight}/${resized.paneWidth.toFixed(0)}x${resized.paneHeight.toFixed(0)} and restored ${restored.viewportWidth}x${restored.viewportHeight}`);
}

async function captureShellScreenshot(driver: WebDriver, path: string): Promise<void> {
  const image = await driver.screenshot();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(image, "base64"));
}
async function waitForRenderedTerminalFrame(driver: WebDriver): Promise<void> {
  await Bun.sleep(300);
  await driver.executeAsync(`
    const complete = arguments[arguments.length - 1];
    Promise.resolve(document.fonts.ready).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => complete(true)));
    });
  `);
}


function optionalCommandOutput(cmd: string[]): string | null {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

async function ownedProcessTree(rootPid: number): Promise<number[]> {
  const result: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => "");
    for (const child of children.trim().split(/\s+/)) {
      const childPid = Number(child);
      if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) pending.push(childPid);
    }
  }
  return result;
}

type WebKitGraphicsProcess = {
  pid: number;
  command: string;
  driverMaps: string[];
  softwareMaps: string[];
  deviceFds: string[];
};

type GraphicsObservation = {
  processIds: number[];
  descriptors: string[];
  webkitProcesses: WebKitGraphicsProcess[];
  softwareWebKitProcessIds: number[];
  nvidiaGraphicsProcessIds: number[];
  nvidiaWebKitGraphicsProcessIds: number[];
};

async function observeGraphicsDescriptors(rootPid: number): Promise<GraphicsObservation> {
  const processIds = await ownedProcessTree(rootPid);
  const descriptors: string[] = [];
  const webkitProcesses: WebKitGraphicsProcess[] = [];
  const softwareWebKitProcessIds: number[] = [];
  for (const pid of processIds) {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    const isWebKitProcess = /\bWebKit(?:Web|GPU)Process\b/i.test(command);
    const deviceFds: string[] = [];
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      if (!/dma.?buf|\/dev\/dri\/|\/dev\/gpu|\/dev\/nvidia/i.test(target)) continue;
      const details = await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8").catch(() => "");
      const summary = details.split("\n").filter((line) => /^(size|flags|mnt_id|ino|exp_name|count):/i.test(line)).join(";");
      descriptors.push(`${pid}:${fd} ${target}${summary ? ` [${summary}]` : ""}`);
      if (isWebKitProcess && (/^\/dev\/(?:nvidia|dri\/renderD)/i.test(target))) deviceFds.push(target);
    }
    if (!isWebKitProcess) continue;
    const maps = await readFile(`/proc/${pid}/maps`, "utf8").catch(() => "");
    const paths = maps.split("\n").map((line) => line.trim().split(/\s+/).pop() ?? "");
    const driverMaps = [...new Set(paths.filter((path) => /\/(?:lib(?:EGL|GLX)_nvidia|libnvidia-(?:eglcore|glcore|gpucomp|glsi|allocator))[^/]*$/i.test(path)))];
    const softwareMaps = [...new Set(paths.filter((path) => /\/(?:swrast_dri|kms_swrast|softpipe_dri)\.so(?:\.|$)|llvmpipe|swiftshader/i.test(path)))];
    if (softwareMaps.length > 0) softwareWebKitProcessIds.push(pid);
    webkitProcesses.push({ pid, command: command.trim().slice(0, 240), driverMaps, softwareMaps, deviceFds: [...new Set(deviceFds)] });
  }

  const owned = new Set(processIds);
  const nvidiaGraphicsProcessIds = new Set<number>();
  const nvidiaSmi = Bun.which("nvidia-smi");
  const nvidiaOutput = nvidiaSmi ? optionalCommandOutput([nvidiaSmi]) : null;
  if (nvidiaOutput) {
    for (const line of nvidiaOutput.split(/\r?\n/)) {
      const match = /^\s*\|\s*\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z+]+)\s+/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (owned.has(pid) && match[2]!.includes("G")) nvidiaGraphicsProcessIds.add(pid);
    }
  }

  const nvidiaWebKitGraphicsProcessIds = webkitProcesses
    .filter((process) =>
      nvidiaGraphicsProcessIds.has(process.pid) &&
      process.driverMaps.some((path) => /nvidia/i.test(path)) &&
      process.deviceFds.some((path) => /^\/dev\/nvidia(?:0|ctl|[0-9]+)/i.test(path)) &&
      process.deviceFds.some((path) => /^\/dev\/dri\/renderD\d+$/i.test(path)))
    .map((process) => process.pid);
  return {
    processIds,
    descriptors,
    webkitProcesses,
    softwareWebKitProcessIds,
    nvidiaGraphicsProcessIds: [...nvidiaGraphicsProcessIds],
    nvidiaWebKitGraphicsProcessIds,
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function percentile95(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]!;
}

async function runFrameProbe(
  driver: WebDriver,
  daemon: TestDaemon,
  paneBindings: Array<{ paneId: string; runtimeId: string }>,
  label: string,
  sequence?: string,
  sendPaneLoad = true,
): Promise<{ intervals: number[]; keyToNextFrameMs: number | null }> {
  const durationMs = 10_000;
  await driver.execute(`
    const duration = arguments[0];
    const intervals = [];
    let previousFrame = null;
    let firstKeydownAt = null;
    let keyToNextFrameMs = null;
    const startedAt = performance.now();
    document.addEventListener("keydown", () => {
      if (firstKeydownAt === null) firstKeydownAt = performance.now();
    }, { capture: true, once: true });
    const sampleFrame = () => {
      const frameAt = performance.now();
      if (previousFrame !== null) intervals.push(frameAt - previousFrame);
      if (firstKeydownAt !== null && keyToNextFrameMs === null) {
        keyToNextFrameMs = Math.max(0, frameAt - firstKeydownAt);
      }
      previousFrame = frameAt;
      if (frameAt - startedAt < duration) {
        requestAnimationFrame(sampleFrame);
      } else {
        document.documentElement.dataset.nativeFrameProbe = JSON.stringify({ intervals, keyToNextFrameMs });
      }
    };
    requestAnimationFrame(sampleFrame);
  `, [durationMs]);

  if (sequence !== undefined) {
    const target = paneBindings[0]!;
    const before = await readRecord(daemon.root, target.runtimeId);
    const textarea = await driver.find(`#panes .pane[data-pane="${target.paneId}"] textarea.xterm-helper-textarea`);
    await driver.click(await driver.find(`#panes .pane[data-pane="${target.paneId}"]`));
    await driver.sendKeys(textarea, `${sequence}${PRIVATE_USE_ENTER}`);
    const after = await waitFor("the native 120-character key sequence to reach its PTY record", async () => {
      const bytes = await readRecord(daemon.root, target.runtimeId);
      return bytes.length > before.length ? bytes : false;
    });
    assert(after.subarray(before.length).toString("utf8") === `${sequence}\n`,
      "The 120-character WebDriver key sequence did not produce exactly one matching PTY input line.");
    const output = await waitFor("the daemon /screen ACK for the native 120-character key sequence", async () => {
      const current = await screen(daemon.base, target.runtimeId);
      return countOccurrences(normalizeScreenRows(current), `ACK:${sequence}`) === 1 ? current : false;
    });
    assert(countOccurrences(normalizeScreenRows(output), `ACK:${sequence}`) === 1, "The daemon screen omitted or duplicated the 120-character ACK.");
    console.log(`ok - native WebDriver typed exactly ${sequence.length} known characters; exact PTY bytes and daemon /screen ACK match`);
  }

  if (sendPaneLoad) {
    const deadline = Date.now() + durationMs;
    let loadIndex = 0;
    while (Date.now() < deadline) {
      for (const { paneId } of paneBindings) {
        if (Date.now() >= deadline) break;
        const selector = `#panes .pane[data-pane="${paneId}"]`;
        await driver.click(await driver.find(selector));
        const textarea = await driver.find(`${selector} textarea.xterm-helper-textarea`);
        await driver.sendKeys(textarea, `native-${label}-load-${loadIndex++}${PRIVATE_USE_ENTER}`);
      }
    }
  }

  await driver.waitFor(async () => await driver.execute<boolean>(
    "return Boolean(document.documentElement.dataset.nativeFrameProbe);",
  ), `${label} 10-second animation-frame probe`, 20_000);
  const payload: unknown = await driver.execute("return document.documentElement.dataset.nativeFrameProbe || null;");
  await driver.execute("delete document.documentElement.dataset.nativeFrameProbe;");
  assert(typeof payload === "string", `${label} animation-frame probe returned no sample payload.`);
  const parsed: unknown = JSON.parse(payload);
  assert(isRecord(parsed) && Array.isArray(parsed.intervals), `${label} animation-frame probe returned malformed samples.`);
  const intervals = parsed.intervals.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  assert(intervals.length >= 30, `${label} animation-frame probe collected too few frame intervals (${intervals.length}).`);
  const keyToNextFrameMs = typeof parsed.keyToNextFrameMs === "number" ? parsed.keyToNextFrameMs : null;
  assert(keyToNextFrameMs !== null, `${label} did not capture keydown-to-next-rAF timing.`);
  console.log(
    `${label} frame intervals: n=${intervals.length} median=${median(intervals).toFixed(2)}ms ` +
    `p95=${percentile95(intervals).toFixed(2)}ms; keydown-to-next-rAF=${keyToNextFrameMs.toFixed(2)}ms ` +
    `(event-to-frame and rAF cadence are distinct measurements, not photon latency)`,
  );
  return { intervals, keyToNextFrameMs };
}

async function runHardwareAcceptance(
  shell: Shell,
  profile: Profile,
  daemon: TestDaemon,
  paneBindings: Array<{ paneId: string; runtimeId: string }>,
): Promise<void> {
  const { driver } = shell;
  const layoutBeforeResize = await measureNativeLayout(driver);
  const rect = await driver.setWindowRect(2200, 1120);
  assert(rect.width === 2200 && rect.height === 1120,
    `Hardware acceptance needs a 2200x1120 native window; WebDriver reports ${rect.width}x${rect.height}.`);
  const actualLayout = await driver.waitFor(async () => {
    const layout = await measureNativeLayout(driver);
    return layout.viewportWidth === 2200 && layout.viewportHeight === 1120 &&
      layout.paneWidth > layoutBeforeResize.paneWidth && layout.paneHeight > layoutBeforeResize.paneHeight
      ? layout : false;
  }, "a 2200x1120 WebView viewport and expanded pane allocation after resizing the four-pane UI", 15_000);
  assert(actualLayout.viewportWidth === 2200 && actualLayout.viewportHeight === 1120 &&
    actualLayout.paneWidth > layoutBeforeResize.paneWidth &&
    actualLayout.paneHeight > layoutBeforeResize.paneHeight,
  `Hardware viewport/pane allocation did not reflect 2200x1120: before=${JSON.stringify(layoutBeforeResize)} after=${JSON.stringify(actualLayout)}.`);
  await driver.waitFor(async () => await driver.execute<string>("return document.fonts.status") === "loaded", "the actual UI fonts to load");
  const pageMetrics = await driver.execute<{
    dpr: number;
    innerWidth: number;
    innerHeight: number;
    screenWidth: number;
    screenHeight: number;
    userAgent: string;
  }>(`return {
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    userAgent: navigator.userAgent,
  };`);
  const gtkVersion = optionalCommandOutput(["pkg-config", "--modversion", "gtk4"]) ?? "unavailable";
  const webkitVersion = optionalCommandOutput(["pkg-config", "--modversion", "webkitgtk-6.0"]) ?? "unavailable";
  const explicitBackend = profile.env.GDK_BACKEND?.trim() ?? "";
  const inferredWayland = !explicitBackend && Boolean(profile.env.WAYLAND_DISPLAY?.trim() || profile.env.XDG_SESSION_TYPE === "wayland");
  const selectedWayland = explicitBackend ? explicitBackend === "wayland" : inferredWayland;
  const disableDmaBuf = Boolean(profile.env.WEBKIT_DISABLE_DMABUF_RENDERER?.trim());
  const forceShm = Boolean(profile.env.WEBKIT_DMABUF_RENDERER_FORCE_SHM?.trim());
  const forcedDmaBuf = profile.env.WEBKIT_FORCE_DMABUF_RENDERER?.trim() ||
    (selectedWayland && !disableDmaBuf && !forceShm ? "1 (GTK/WebKit shell default)" : "unset");
  const kscreen = Bun.which("kscreen-doctor");
  const displayOutput = kscreen ? optionalCommandOutput([kscreen, "-o"]) : null;
  const scaleMatch = displayOutput?.match(/\bScale:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const refreshMatch = displayOutput?.match(/@([0-9]+(?:\.[0-9]+)?)(?:\s*Hz)?/i) ??
    displayOutput?.match(/\b([0-9]+(?:\.[0-9]+)?)\s*Hz/i);
  const nativeScale = scaleMatch ? Number(scaleMatch[1]) : null;
  const refreshHz = refreshMatch ? Number(refreshMatch[1]) : null;
  if (nativeScale === null) throw new Error("--require-gpu requires an observable native display scale from kscreen-doctor -o.");
  if (refreshHz === null) throw new Error("--require-gpu requires an observable output refresh rate from kscreen-doctor -o.");
  const renderer = await webglRenderer(driver);
  const descriptors = await observeGraphicsDescriptors(shell.host.proc.pid);
  const environment = {
    GDK_BACKEND: explicitBackend || (inferredWayland ? "wayland (shell default)" : "GTK backend default"),
    GSK_RENDERER: profile.env.GSK_RENDERER?.trim() || "gl (shell default)",
    WEBKIT_FORCE_DMABUF_RENDERER: forcedDmaBuf,
    WEBKIT_DISABLE_DMABUF_RENDERER: profile.env.WEBKIT_DISABLE_DMABUF_RENDERER?.trim() || "unset",
    WEBKIT_DMABUF_RENDERER_FORCE_SHM: profile.env.WEBKIT_DMABUF_RENDERER_FORCE_SHM?.trim() || "unset",
  };
  console.log(`native hardware diagnostics: ${JSON.stringify({
    gtk4: gtkVersion,
    webkitgtk6: webkitVersion,
    environment,
    nativeSurfaceScale: nativeScale,
    refreshHz,
    webkitDpr: pageMetrics.dpr,
    viewport: [pageMetrics.innerWidth, pageMetrics.innerHeight],
    screen: [pageMetrics.screenWidth, pageMetrics.screenHeight],
    userAgent: pageMetrics.userAgent,
    windowRect: rect,
    webglRenderer: renderer.renderer,
    dmaBufAndDrmDescriptors: descriptors.descriptors,
    ownedWebKitProcessIds: descriptors.processIds,
    softwareWebKitProcessIds: descriptors.softwareWebKitProcessIds,
    nvidiaWebKitGraphicsProcessIds: descriptors.nvidiaWebKitGraphicsProcessIds,
  })}`);
  const rendererSoftware = /llvmpipe|software|swiftshader|mesa offscreen/i.test(renderer.renderer);
  const rendererNamesHardware = /nvidia|amd|radeon|intel|mali|adreno/i.test(renderer.renderer);
  const softwareWebKitObserved = descriptors.softwareWebKitProcessIds.length > 0;
  const nvidiaProcessProof = descriptors.nvidiaWebKitGraphicsProcessIds.length > 0;
  if (!renderer.supported || rendererSoftware || softwareWebKitObserved ||
      (!rendererNamesHardware && !nvidiaProcessProof)) {
    throw new Error(
      `--require-gpu needs an observed hardware WebGL renderer and owned GPU process; ` +
      `found ${JSON.stringify(renderer.renderer)}, software=${softwareWebKitObserved}, NVIDIA proof=${nvidiaProcessProof}.`,
    );
  }
  const sequence = Array.from({ length: 120 }, (_, index) => String.fromCharCode(65 + index % 26)).join("");
  const firstProbe = await runFrameProbe(driver, daemon, paneBindings, "native-probe-1", sequence);
  const secondProbe = await runFrameProbe(driver, daemon, paneBindings, "native-probe-2");
  if (refreshHz >= 60) {
    for (const [label, samples] of [["native-probe-1", firstProbe.intervals], ["native-probe-2", secondProbe.intervals]] as const) {
      const frameMedian = median(samples);
      const frameP95 = percentile95(samples);
      assert(frameMedian <= 20 && frameP95 <= 33,
        `${label} exceeded the >=60Hz workstation target (median ${frameMedian.toFixed(2)}ms, p95 ${frameP95.toFixed(2)}ms).`);
    }
  } else {
    console.log(`No frame timing threshold applied to this ${refreshHz}Hz output.`);
  }
  await captureShellScreenshot(driver, process.env.OMP_DESKTOP_NATIVE_SCREENSHOT ?? join(tmpdir(), `omp-desktop-native-smoke-${process.pid}.png`));
}

async function testFirstSessionAndPaneWorkload(
  shell: Shell,
  daemon: TestDaemon,
  profile: Profile,
  openLog: string,
  screenshotPath: string,
  requireGpu: boolean,
): Promise<{
  stoppedRuntimeId: string;
  stoppedPid: number;
  runtimeSnapshot: Array<[string, number | null]>;
  savedWorkspaceSignature: string;
}> {
  const { driver } = shell;
  await waitConnected(driver, daemon.port);
  const base = daemon.base;
  const beforeNewSession = await driver.waitFor(async () => {
    const current = await runtimes(base);
    return current.length === 1 && current[0]!.pid !== null ? current : false;
  }, "the app's automatic initial session to attach before the explicit new-session control");
  await verifyNativeResize(driver);
  const beforeSessionIds = new Set(beforeNewSession.map((runtime) => runtime.id));
  await driver.clickCss("#new-session");
  const created = await driver.waitFor(async () => {
    const current = await runtimes(base);
    const added = current.filter((runtime) => !beforeSessionIds.has(runtime.id));
    return current.length === beforeNewSession.length + 1 && added.length === 1 && added[0]!.pid !== null ? added[0] : false;
  }, "#new-session to add and attach one real daemon runtime");
  await waitForRuntimePaneReady(driver, base, created.id);
  console.log("ok - #new-session creates a real runtime and WebSocket attachment starts its fake-OMP PTY");
  const createdRecord = fakeOmpRecordPath(daemon.root, created.id);
  const terminal = await driver.find("#panes .pane textarea.xterm-helper-textarea");
  await driver.click(await driver.find("#panes .pane"));
  const echo = "native-echo-✓";
  await driver.sendKeys(terminal, `${echo}${PRIVATE_USE_ENTER}`);
  await waitFor("the exact initial PTY bytes", async () => {
    const bytes = (await readRecord(daemon.root, created.id)).toString("utf8");
    return bytes.includes(`${echo}\n`) ? true : false;
  });
  const initialScreen = await waitFor("the first input ACK in the daemon screen", async () => {
    const output = await screen(base, created.id);
    return output.includes(`ACK:${echo}`) ? output : false;
  });
  assert(countOccurrences(initialScreen, `ACK:${echo}`) === 1, "The daemon screen snapshot duplicated the first terminal ACK.");
  const bytes = (await readRecord(daemon.root, created.id)).toString("utf8");
  assert(countOccurrences(bytes, echo) === 1, "WebDriver key input was lost or duplicated in the PTY byte record.");
  await waitForRenderedTerminalFrame(driver);
  await captureShellScreenshot(driver, screenshotPath);
  console.log(`ok - WebDriver entered native-echo-✓ through xterm; PTY bytes and daemon /screen ACK verified, native screenshot captured at ${screenshotPath}`);
  assert(await fileExists(createdRecord), "The UI-created runtime did not get a fixture-owned input record.");

  await driver.rightClick(await driver.find("#panes .pane"));
  const firstSplitItem = await driver.waitFor(async () => {
    const item = await driver.find(".pane-menu [role='menuitem']").catch(() => null);
    return item && await driver.displayed(item) ? item : false;
  }, "the first actual pane context menu");
  await driver.click(firstSplitItem);
  await driver.waitFor(async () => await driver.findAll("#panes .pane").then((items) => items.length === 2), "the first pane split");
  await driver.rightClick(await driver.find("#panes .pane"));
  const secondSplitItem = await driver.waitFor(async () => {
    const item = await driver.find(".pane-menu [role='menuitem']").catch(() => null);
    return item && await driver.displayed(item) ? item : false;
  }, "the second actual pane context menu");
  await driver.click(secondSplitItem);
  const paneBindings = await driver.waitFor(async () => {
    const bindings = await activePaneBindings(driver, base);
    return bindings.length === 4 && new Set(bindings.map((entry) => entry.runtimeId)).size === 4 ? bindings : false;
  }, "four distinct pane/runtime bindings");
  const allRuntimes = await waitFor("all four attached pane runtimes", async () => {
    const current = await runtimes(base);
    return paneBindings.every(({ runtimeId }) => current.some((runtime) => runtime.id === runtimeId && runtime.pid !== null)) ? current : false;
  });
  const beforeMarkers = new Map<string, Buffer>();
  for (const runtime of allRuntimes) beforeMarkers.set(runtime.id, await readRecord(daemon.root, runtime.id));
  const markers = paneBindings.map((_, index) => `native-pane-${index + 1}-✓`);
  for (let index = 0; index < paneBindings.length; index += 1) {
    const target = paneBindings[index]!;
    await waitForRuntimePaneReady(driver, base, target.runtimeId);
    await driver.click(await driver.find(`#panes .pane[data-pane="${target.paneId}"]`));
    const textarea = await driver.find(`#panes .pane[data-pane="${target.paneId}"] textarea.xterm-helper-textarea`);
    await driver.sendKeys(textarea, `${markers[index]}${PRIVATE_USE_ENTER}`);
    await waitFor(`the PTY acknowledgement for ${markers[index]}`, async () =>
      (await screen(base, target.runtimeId)).includes(`ACK:${markers[index]}`) ? true : false,
    );
  }
  for (let index = 0; index < paneBindings.length; index += 1) {
    const target = paneBindings[index]!;
    const current = (await readRecord(daemon.root, target.runtimeId)).toString("utf8");
    const previous = beforeMarkers.get(target.runtimeId)!.toString("utf8");
    const suffix = current.startsWith(previous) ? current.slice(previous.length) : "<record-rewritten>";
    assert(suffix === `${markers[index]}\n`, `Focused pane ${target.paneId} did not send exactly its marker to runtime ${target.runtimeId}: ${JSON.stringify(suffix)}`);
    for (const other of allRuntimes) {
      if (other.id === target.runtimeId) continue;
      const record = (await readRecord(daemon.root, other.id)).toString("utf8");
      assert(!record.includes(markers[index]), `Marker for focused pane ${target.paneId} reached unrelated runtime ${other.id}.`);
    }
  }
  console.log("ok - four actual panes focus distinct PTYs and deliver exact UTF-8 markers");
  const knownSequence = Array.from({ length: 120 }, (_, index) => String.fromCharCode(65 + index % 26)).join("");
  await runFrameProbe(driver, daemon, paneBindings, "native-x11-key-input", knownSequence, false);
  if (requireGpu) await runHardwareAcceptance(shell, profile, daemon, paneBindings);
  await waitForRenderedTerminalFrame(driver);
  await captureShellScreenshot(driver, screenshotPath);
  console.log(`Captured the real four-pane terminal with acknowledged native input at ${screenshotPath}`);

  const visibleTitles = () => driver.execute<string[]>(
    `return Array.from(document.querySelectorAll("#session-list .row .title"))
      .filter(node => {
        const row = node.closest(".row");
        return row && getComputedStyle(row).display !== "none" &&
          getComputedStyle(row).visibility !== "hidden" && row.getClientRects().length > 0;
      })
      .map(node => node.textContent || "");`,
  );
  const originalTitles = await visibleTitles();
  assert(originalTitles.includes("native search alpha"), "The known transcript title was not visible before searching.");
  await driver.clearCss("#search");
  await driver.sendKeysCss("#search", "native search alpha");
  await driver.waitFor(async () => {
    const titles = await visibleTitles();
    return titles.length === 1 && titles[0] === "native search alpha";
  }, "the known transcript title to be the only visible sidebar result");
  const filteredTitles = await visibleTitles();
  assert(filteredTitles.length === 1 && filteredTitles[0] === "native search alpha", `Search returned unexpected visible fixture titles: ${JSON.stringify(filteredTitles)}`);
  await driver.clearCss("#search");
  await driver.waitFor(async () => JSON.stringify(await visibleTitles()) === JSON.stringify(originalTitles),
    "clearing search to restore the same visible session rows");
  console.log("ok - session search filters a known transcript title and clearing restores the visible list");

  await driver.clickCss("#new-space");
  await driver.waitFor(async () => await driver.findAll("#space-tabs [role='tab']").then((items) => items.length === 2), "the second workspace space");
  const spaces = await driver.execute<Array<{ id: string; selected: string }>>(
    `return Array.from(document.querySelectorAll("#space-tabs [role='tab']"), tab => ({ id: tab.dataset.space || "", selected: tab.getAttribute("aria-selected") || "false" }));`,
  );
  assert(spaces.length === 2 && spaces[1]!.selected === "true", "The newly created space was not the displayed selection.");
  const workspaceWithSecond = await getWorkspace(base);
  assert(workspaceWithSecond.activeSpaceId === spaces[1]!.id, "Displayed space selection disagrees with the saved active-space id.");
  await driver.click(await driver.find(`#space-tabs [role='tab'][data-space="${spaces[0]!.id}"]`));
  const workspaceBack = await getWorkspace(base);
  const selectedAfterBack = await driver.execute<string | null>(
    `return document.querySelector("#space-tabs [role='tab'][aria-selected='true']")?.dataset.space ?? null;`,
  );
  assert(selectedAfterBack === spaces[0]!.id && workspaceBack.activeSpaceId === spaces[0]!.id,
    "Space selection and durable active-space id diverged after switching back.");
  const bindingsAfterSwitch = await activePaneBindings(driver, base);
  assert(bindingsAfterSwitch.length === 4 && new Set(bindingsAfterSwitch.map((item) => item.runtimeId)).size === 4,
    "Returning to the original space did not preserve all four pane/runtime bindings.");
  await testClipboardAndFileDrop(profile, daemon, shell);
  await testNavigationPolicy(shell, daemon, openLog);
  console.log("ok - space controls, visible selection, and daemon-saved pane/runtime bindings agree");

  const paneToClose = paneBindings[2]!;
  const runtimeCountBeforeClose = (await runtimes(base)).length;
  await driver.click(await driver.find(`#panes .pane[data-pane="${paneToClose.paneId}"] .pane-close`));
  await driver.waitFor(async () => await driver.execute<boolean>(
    `return Array.from(document.querySelectorAll("#panes .pane")).some(pane =>
      pane.dataset.pane === arguments[0] &&
      pane.querySelector(".pane-placeholder")?.textContent?.includes("empty pane") === true
    );`,
    [paneToClose.paneId],
  ), "closing a pane to leave its empty slot in the four-pane layout");
  const runtimesAfterClose = await runtimes(base);
  assert(runtimesAfterClose.length === runtimeCountBeforeClose && runtimesAfterClose.some((runtime) => runtime.id === paneToClose.runtimeId),
    "Closing a pane killed its detached session.");
  console.log("ok - closing a pane detaches its session without killing the daemon-owned PTY");

  const toStop = paneBindings[3]!;
  const stopped = (await runtimes(base)).find((runtime) => runtime.id === toStop.runtimeId);
  assert(stopped?.pid !== null && stopped?.pid !== undefined, "Chosen explicit-stop runtime has no PTY pid.");
  const row = await driver.find(`#session-list .row[title*="${toStop.runtimeId}"] .kill`);
  await driver.click(row);
  await driver.waitFor(async () => !(await runtimes(base)).some((runtime) => runtime.id === toStop.runtimeId), "explicit session stop to remove the runtime");
  await waitFor("the explicitly stopped PTY to be reaped", async () => !(await isProcessAlive(stopped.pid!)));
  console.log("ok - explicit session stop removes the runtime and reaps its owned PTY");
  const normalTargetPane = paneBindings.find((binding) =>
    binding.paneId !== paneToClose.paneId && binding.runtimeId !== toStop.runtimeId);
  assert(normalTargetPane, "No surviving four-pane runtime is available for normal-mode native input.");
  await driver.click(await driver.find(`#panes .pane[data-pane="${normalTargetPane.paneId}"]`));
  await waitFor("normal-mode handoff to preserve a focused live pane", async () => {
    const workspace = await getWorkspace(base);
    const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
    return active?.layout.focused === normalTargetPane.paneId ? workspace : false;
  });

  const settledWorkspace = await waitForWorkspaceBindings(base, "fixture transcript paths to agree with saved pane/runtime bindings");
  const saved = settledWorkspace.workspace;
  const runtimeIdSnapshot: Array<[string, number | null]> = settledWorkspace.runtimes
    .map(({ id, pid }) => [id, pid] as [string, number | null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const savedWorkspaceSignature = workspaceSignature(saved);
  const daemonProcess = daemon.proc;
  await closeShell(shell);
  assert(daemon.proc === daemonProcess, "Closing the native window replaced the daemon process handle.");
  const afterCloseRuntimes = await runtimes(base);
  assert(JSON.stringify(afterCloseRuntimes.map(({ id, pid }) => [id, pid]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) === JSON.stringify(runtimeIdSnapshot),
    "Closing the shell stopped or replaced daemon-owned runtime pids.");
  console.log("ok - window close leaves the daemon and all live PTY processes untouched");

  return {
    stoppedRuntimeId: toStop.runtimeId,
    stoppedPid: stopped.pid,
    runtimeSnapshot: runtimeIdSnapshot,
    savedWorkspaceSignature,
  };
}

async function verifyPersistentNormalProfileAndNotifications(
  profile: Profile,
  daemon: TestDaemon,
  binary: string,
  notificationService: NotificationService,
  stoppedRuntimeId: string | null,
  expectedRuntimeSnapshot: Array<[string, number | null]>,
  expectedWorkspaceSignature: string | null,
  screenshotPath: string,
): Promise<NormalShell> {
  let shell: NormalShell | null = null;
  let server: ReturnType<typeof createHttpServer> | null = null;
  let socketPath: string | null = null;
  let listening = false;
  let socketRequests = 0;
  let completion: { identity: string; completedAt: number } | null = null;
  let succeeded = false;
  let failure: unknown = null;
  try {
    shell = await startNormalShell(profile, daemon.port, binary);
    let before = await waitFor("normal GTK profile live daemon runtimes", async () => {
      const current = await runtimes(daemon.base);
      return current.length > 0 && current.every((runtime) => runtime.alive && runtime.pid !== null) ? current : false;
    });
    const snapshot = (values: RuntimeInfo[]): Array<[string, number | null]> =>
      values.map(({ id, pid }) => [id, pid] as [string, number | null]).sort((a, b) => a[0].localeCompare(b[0]));
    const expectedSnapshot = expectedRuntimeSnapshot.length > 0 ? expectedRuntimeSnapshot : snapshot(before);
    assert(JSON.stringify(snapshot(before)) === JSON.stringify(expectedSnapshot),
      "Normal production window changed daemon runtime ids or pids before the profile persistence check.");
    if (stoppedRuntimeId !== null) {
      assert(!before.some((runtime) => runtime.id === stoppedRuntimeId),
        "An explicitly stopped runtime returned in the normal production profile.");
    }
    assert(before.every((runtime) => runtime.alive && runtime.pid !== null),
      "Normal profile persistence requires every expected daemon-owned PTY to remain live.");
    const settledWorkspace = await waitForWorkspaceBindings(
      daemon.base,
      "normal GTK daemon session files to agree with saved pane bindings",
    );
    before = settledWorkspace.runtimes;
    assert(JSON.stringify(snapshot(before)) === JSON.stringify(expectedSnapshot),
      "Normal GTK workspace restoration changed daemon runtime ids or pids while session-file bindings settled.");
    const originalWorkspace = settledWorkspace.workspace;
    const originalSignature = workspaceSignature(originalWorkspace);
    if (expectedWorkspaceSignature !== null) {
      assert(originalSignature === expectedWorkspaceSignature,
        "Normal production app did not load the previously saved pane/runtime workspace before changing it.");
    }
    const targetSpace = originalWorkspace.spaces.find((space) => space.id === originalWorkspace.activeSpaceId);
    const focusedPaneId = targetSpace?.layout.focused;
    const targetBindingValue = focusedPaneId ? targetSpace?.layout.panes[focusedPaneId] : undefined;
    assert(targetSpace && isRecord(targetBindingValue) && typeof targetBindingValue.runtimeId === "string",
      "The active normal GTK space must focus a pane bound to a live runtime.");
    const targetRuntimeId = targetBindingValue.runtimeId;
    const targetRuntime = before.find((runtime) => runtime.id === targetRuntimeId);
    assert(targetRuntime && targetRuntime.pid !== null, "The focused notification target runtime has no live PTY.");
    const targetSpaceId = targetSpace.id;
    socketPath = join(daemon.root, "mobile", `${targetRuntime.id}.sock`);
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    server = createHttpServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/status") {
        response.writeHead(404).end("not found");
        return;
      }
      socketRequests += 1;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accent: null, agentActive: false, completion }));
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath!, resolveListen);
    });
    listening = true;
    await chmod(socketPath, 0o600);
    await waitFor("daemon API to observe the fixture's initial no-completion state", async () => {
      const body: unknown = await (await fetch(`${daemon.base}/api/runtimes`)).json();
      return isRecord(body) && Array.isArray(body.runtimes) && body.runtimes.some((entry) =>
        isRecord(entry) && entry.id === targetRuntime.id && isRecord(entry.presentation) &&
        entry.presentation.completion === null,
      ) ? true : false;
    });
    const firstClientBaseline = socketRequests;
    await waitFor("normal GTK client to observe the initial no-completion state", () =>
      socketRequests > firstClientBaseline);
    await testNormalTerminalInput(
      shell,
      daemon,
      targetRuntime.id,
      screenshotPath.replace(/\.png$/i, "-terminal.png"),
    );

    await setNormalPreferences(shell);
    const preferenceWorkspace = await waitFor("native preference updates to preserve the daemon workspace", async () => {
      const workspace = await getWorkspace(daemon.base);
      return workspaceSignature(workspace) === originalSignature ? workspace : false;
    });
    assert(workspaceSignature(preferenceWorkspace) === originalSignature,
      "Changing native preferences altered the saved pane/runtime workspace.");
    assert(JSON.stringify(snapshot(await runtimes(daemon.base))) === JSON.stringify(expectedSnapshot),
      "Changing normal native preferences changed daemon-owned runtime ids or pids.");
    await closeNormalSettings(shell);
    const initialTree = await normalSnapshot(shell);
    await captureNormalScreenshot(shell, screenshotPath);
    const alternateSpace = originalWorkspace.spaces.find((space) =>
      space.id !== targetSpaceId && Object.values(space.layout.panes).some((binding) =>
        isRecord(binding) && typeof binding.runtimeId === "string" &&
        before.some((runtime) => runtime.id === binding.runtimeId && runtime.pid !== null),
      ),
    );
    let destinationSpaceId: string;
    if (alternateSpace) {
      const alternateIndex = originalWorkspace.spaces.indexOf(alternateSpace) + 1;
      const tabName = `Space ${alternateIndex}`;
      const alternateTab = walkAccessibilityTree(initialTree).find((node) =>
        node.role.toLowerCase() === "page tab" && node.name === tabName,
      );
      assert(alternateTab, `Saved live-bound alternate space ${tabName} has no accessible tab.`);
      clickAccessible(shell, alternateTab);
      await waitForAccessibleTree(shell, "real X11 click to select the existing live-bound space tab", (tree) =>
        walkAccessibilityTree(tree).some((node) =>
          node.role.toLowerCase() === "page tab" && node.name === tabName && node.states.includes("selected"),
        ));
      destinationSpaceId = alternateSpace.id;
    } else {
      const newSpace = accessibleButton(initialTree, "New space");
      if (!newSpace) throw new Error(`Normal GTK space control is missing from AT-SPI:\n${normalTreeSummary(initialTree)}`);
      clickAccessible(shell, newSpace);
      await waitForAccessibleTree(shell, "real X11 click to add and select a native GTK space tab", (tree) => {
        const tabs = walkAccessibilityTree(tree).filter((node) => node.role.toLowerCase() === "page tab");
        return tabs.length === originalWorkspace.spaces.length + 1 && tabs.some((node) => node.states.includes("selected"));
      });
      const createdWorkspace = await waitFor("normal GTK New space control to activate an empty space", async () => {
        const workspace = await getWorkspace(daemon.base);
        return workspace.activeSpaceId !== originalWorkspace.activeSpaceId &&
          workspace.spaces.length === originalWorkspace.spaces.length + 1 ? workspace : false;
      });
      destinationSpaceId = createdWorkspace.activeSpaceId;
    }
    const separatedWorkspace = await waitFor("normal GTK to persist selection of a different space", async () => {
      const workspace = await getWorkspace(daemon.base);
      return workspace.activeSpaceId === destinationSpaceId ? workspace : false;
    });
    const persistedWorkspaceSignature = workspaceSignature(separatedWorkspace);

    await captureNormalScreenshot(shell, screenshotPath);
    await closeNormalShell(shell);
    shell = null;
    assert(JSON.stringify(snapshot(await runtimes(daemon.base))) === JSON.stringify(expectedSnapshot),
      "Closing the normal production GTK window changed daemon-owned runtime ids or pids.");
    assert(workspaceSignature(await getWorkspace(daemon.base)) === persistedWorkspaceSignature,
      "Closing the normal production GTK window lost the saved workspace.");

    shell = await startNormalShell(profile, daemon.port, binary);
    await verifyNormalPreferences(shell);
    const reopenedRuntimes = await runtimes(daemon.base);
    assert(JSON.stringify(snapshot(reopenedRuntimes)) === JSON.stringify(expectedSnapshot),
      "Reopening the same normal GTK profile changed live daemon runtime ids or pids.");
    assert(reopenedRuntimes.every((runtime) => runtime.alive && runtime.pid !== null),
      "A PTY stopped while reopening the normal GTK profile.");
    const reopenedWorkspace = await getWorkspace(daemon.base);
    const reopenedWorkspaceSignature = workspaceSignature(reopenedWorkspace);
    assert(reopenedWorkspaceSignature === persistedWorkspaceSignature,
      `The normal production profile reopen changed the persisted pane/runtime workspace. Saved=${persistedWorkspaceSignature} reopened=${reopenedWorkspaceSignature}`);
    assert(reopenedWorkspace.activeSpaceId !== targetSpaceId,
      "The normal profile did not restore the different space selected before closing its window.");
    assert(reopenedWorkspace.spaces.some((space) => space.id === targetSpaceId &&
      Object.values(space.layout.panes).some((binding) => isRecord(binding) && binding.runtimeId === targetRuntime.id)),
    "The same-profile reopen did not retain the notification target's pane/runtime binding.");
    await closeNormalSettings(shell);
    console.log("ok - normal production binary reopens the same persistent profile with sidebar/motion/notification preferences, workspace bindings, and identical live PTY ids/pids");

    const reopenedBaseline = socketRequests;
    await waitFor("reopened normal GTK client to observe no-completion state", () =>
      socketRequests > reopenedBaseline);
    const firstIdentity = "native-smoke-completion-1";
    completion = { identity: firstIdentity, completedAt: Date.now() };
    await waitFor("daemon API to expose the new fixture completion identity", async () => {
      const body: unknown = await (await fetch(`${daemon.base}/api/runtimes`)).json();
      return isRecord(body) && Array.isArray(body.runtimes) && body.runtimes.some((entry) =>
        isRecord(entry) && entry.id === targetRuntime.id && isRecord(entry.presentation) &&
        isRecord(entry.presentation.completion) && entry.presentation.completion.identity === firstIdentity,
      ) ? true : false;
    }, 8_000);
    let delivery: Record<string, unknown>;
    try {
      delivery = await waitFor("normal WebKit profile to deliver its GIO completion notification", () => {
        const events = notificationService.events().filter((event) => event.event === "delivery");
        return events.find((event) => event.app === "omp-desktop" &&
          typeof event.id === "number" && typeof event.title === "string" && event.title.length > 0 &&
          Array.isArray(event.actions) && event.actions.includes("default")) ?? false;
      }, 20_000);
    } catch (error) {
      const body: unknown = await (await fetch(`${daemon.base}/api/runtimes`)).json().catch(() => null);
      console.error(
        `Completion delivery diagnostics: socketRequests=${socketRequests}; ` +
        `notificationEvents=${JSON.stringify(notificationService.events())}; runtimes=${JSON.stringify(body)}`,
      );
      throw error;
    }

    const notificationId = delivery.id;
    assert(typeof notificationId === "number", "Notification service received no uint id.");
    assert(Array.isArray(delivery.actions) && delivery.actions.length >= 2 && delivery.actions[0] === "default",
      "Normal WebKit completion notification did not publish its default click action.");
    assert(delivery.app === "omp-desktop", `Notification used unexpected application identity ${String(delivery.app)}.`);
    const deliveriesBeforeRepeat = notificationService.events().filter((event) => event.event === "delivery").length;
    await waitFor("real completion presentation to be visible from the daemon", async () => {
      const body: unknown = await (await fetch(`${daemon.base}/api/runtimes`)).json();
      return isRecord(body) && Array.isArray(body.runtimes) && body.runtimes.some((entry) =>
        isRecord(entry) && entry.id === targetRuntime.id && isRecord(entry.presentation) &&
        isRecord(entry.presentation.completion) && entry.presentation.completion.identity === firstIdentity,
      ) ? true : false;
    }, 8_000);
    await Bun.sleep(5_500);
    assert(notificationService.events().filter((event) => event.event === "delivery").length === deliveriesBeforeRepeat,
      "A repeated completion identity delivered a second real desktop notification.");

    const beforeActivation = await getWorkspace(daemon.base);
    assert(beforeActivation.activeSpaceId !== targetSpaceId,
      "Notification click-to-focus would be inconclusive because its target space was already active.");
    notificationService.activate(notificationId);
    const activatedWorkspace = await waitFor("normal notification action to switch spaces and focus its target runtime", async () => {
      const workspace = await getWorkspace(daemon.base);
      if (workspace.activeSpaceId !== targetSpaceId) return false;
      const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
      if (!active || !active.layout.focused) return false;
      const binding = active.layout.panes[active.layout.focused];
      return isRecord(binding) && binding.runtimeId === targetRuntime.id ? workspace : false;
    });
    const activated = notificationService.events().find((event) => event.event === "activated" && event.id === notificationId);
    assert(activated, "The private notification service did not emit the recorded default action.");
    console.log(`ok - real normal-mode GIO notification action focused runtime ${targetRuntime.id} in space ${activatedWorkspace.activeSpaceId}; duplicate completion identity produced no second delivery`);

    await openNormalSettings(shell);
    const beforeOptOut = normalPreferenceState(await normalSnapshot(shell));
    assert(beforeOptOut.notifications === true, `Notification opt-in did not survive same-profile reopen: ${JSON.stringify(beforeOptOut)}`);
    await setNormalGroupToggle(shell, "Completion notifications", "On", ["Off", "On"], false);
    const offTree = await waitForAccessibleTree(shell, "native notification Off preference", (tree) => {
      const state = normalPreferenceState(tree);
      return state.notifications === false;
    });
    await closeNormalSettings(shell);
    const deliveriesBeforeOff = notificationService.events().filter((event) => event.event === "delivery").length;
    const disabledIdentity = "native-smoke-notification-off";
    completion = { identity: disabledIdentity, completedAt: Date.now() + 1 };
    await waitFor("the UI-Off completion to reach the daemon presentation API", async () => {
      const body: unknown = await (await fetch(`${daemon.base}/api/runtimes`)).json();
      return isRecord(body) && Array.isArray(body.runtimes) && body.runtimes.some((entry) =>
        isRecord(entry) && entry.id === targetRuntime.id && isRecord(entry.presentation) &&
        isRecord(entry.presentation.completion) && entry.presentation.completion.identity === disabledIdentity,
      ) ? true : false;
    }, 10_000);
    await Bun.sleep(5_500);
    assert(notificationService.events().filter((event) => event.event === "delivery").length === deliveriesBeforeOff,
      "A new completion was delivered while the real normal-mode UI notification preference was Off.");
    const finalWorkspace = await getWorkspace(daemon.base);
    assert(finalWorkspace.spaces.some((space) => space.id === finalWorkspace.activeSpaceId),
      "Workspace state became unreadable after normal notification settings and action changes.");
    assert(normalPreferenceState(offTree).notifications === false,
      "AT-SPI did not expose the actual notification Off state after the user click.");
    await captureNormalScreenshot(shell, screenshotPath);
    await testNormalSingleInstance(shell, binary, daemon, await runtimes(daemon.base), screenshotPath);
    succeeded = true;
  } catch (error) {
    failure = error;
    if (shell) {
      console.error(`Normal GTK app stdout:\n${shell.app.stdout.text}\nNormal GTK app stderr:\n${shell.app.stderr.text}`);
      console.error(`AT-SPI stderr:\n${shell.accessibilityProcess.stderr.text}`);
      try {
        console.error(`Last normal GTK accessibility tree:\n${normalTreeSummary(await normalSnapshot(shell))}`);
      } catch (snapshotError) {
        console.error(`Final AT-SPI snapshot failed: ${String(snapshotError)}`);
      }
    }
  }
  try {
    await cleanupOwned("normal profile notification fixture", [
      async () => {
        if (server && listening && server.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolveClose, reject) =>
            server!.close((error) => {
              if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
              else resolveClose();
            }));
          listening = false;
        }
      },
      async () => {
        if (socketPath) await rm(socketPath, { force: true });
      },
      async () => {
        if (!succeeded && shell) await closeNormalShell(shell);
      },
    ]);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], "Normal profile/notification scenario failed and cleanup also failed.");
    throw cleanupError;
  }
  if (failure) throw failure;
  if (!shell) throw new Error("Normal production GTK window disappeared before the singleton scenario completed.");
  return shell;
}

async function setClipboard(backend: "x11" | "wayland", profile: Profile, mime: string, bytes: Uint8Array): Promise<ManagedChild> {
  let cmd: string[];
  if (backend === "wayland") {
    const binary = requireCommand(["wl-copy"], "wl-copy for native Wayland clipboard tests");
    cmd = [binary, "--foreground", "--type", mime];
  } else {
    const binary = requireCommand(["xclip"], "xclip for native X11 clipboard tests");
    cmd = [binary, "-quiet", "-selection", "clipboard", "-i", "-t", mime];
  }
  const child = spawnTracked(cmd, { env: profile.env, stdin: "pipe", detached: false });
  try {
    const input = child.proc.stdin;
    if (!input || typeof input === "number") throw new Error("Clipboard helper did not expose a writable input pipe.");
    input.write(bytes);
    input.flush();
    input.end();
    await verifyClipboardSelection(backend, profile, mime, bytes);
    return child;
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function verifyClipboardSelection(
  backend: "x11" | "wayland",
  profile: Profile,
  mime: string,
  bytes: Uint8Array,
): Promise<void> {
  const timeout = requireCommand(["timeout"], "timeout for bounded OS clipboard verification");
  const clipboardCommand = requireCommand(
    backend === "x11" ? ["xclip"] : ["wl-paste"],
    backend === "x11" ? "xclip for native X11 clipboard verification" : "wl-paste for native Wayland clipboard verification",
  );
  const runBounded = (command: string, args: string[]) => Bun.spawnSync({
    cmd: [timeout, "--signal=TERM", "--kill-after=1s", "2s", command, ...args],
    env: profile.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(`${backend} OS clipboard to advertise ${mime} and return the exact payload`, () => {
    const targetResult = backend === "x11"
      ? runBounded(clipboardCommand, ["-selection", "clipboard", "-out", "-t", "TARGETS"])
      : runBounded(clipboardCommand, ["--list-types"]);
    if (targetResult.exitCode !== 0) return false;
    const targets = new TextDecoder().decode(targetResult.stdout).split(/\s+/);
    if (!targets.includes(mime)) return false;
    const payloadResult = backend === "x11"
      ? runBounded(clipboardCommand, ["-selection", "clipboard", "-out", "-t", mime])
      : runBounded(clipboardCommand, ["--no-newline", "--type", mime]);
    return payloadResult.exitCode === 0 && Buffer.from(payloadResult.stdout).equals(Buffer.from(bytes));
  }, 5_000);
}

function clipboardBackend(profile?: Profile): "x11" | "wayland" {
  const environment = profile?.env ?? process.env;
  const selected = environment.GDK_BACKEND ?? "";
  if (selected.split(",").includes("wayland") && environment.WAYLAND_DISPLAY) return "wayland";
  if (!selected && environment.XDG_SESSION_TYPE === "wayland" && environment.WAYLAND_DISPLAY) return "wayland";
  return "x11";
}

async function testClipboardAndFileDrop(profile: Profile, daemon: TestDaemon, shell: Shell): Promise<void> {
  const bindings = await activePaneBindings(shell.driver, daemon.base);
  const target = bindings.find((pane) => pane.runtimeId && pane.runtimeId !== "") ?? false;
  assert(target, "No active pane is available for clipboard and file-drop scenarios.");
  await shell.driver.click(await shell.driver.find(`#panes .pane[data-pane="${target.paneId}"]`));
  const backend = clipboardBackend(profile);
  const text = `native-clipboard-${crypto.randomUUID()}`;
  const textOwner = await setClipboard(backend, profile, backend === "wayland" ? "text/plain;charset=utf-8" : "UTF8_STRING", Buffer.from(text));
  try {
    await shell.driver.keyPress("v", PRIVATE_USE_CONTROL);
    await shell.driver.keyPress(PRIVATE_USE_ENTER);
    const bytes = await waitFor("actual OS clipboard text to reach the selected PTY", async () => {
      const record = await readRecord(daemon.root, target.runtimeId);
      return record.toString("utf8").includes(`${text}\n`) ? record : false;
    });
    assert(countOccurrences(bytes.toString("utf8"), text) === 1, "Clipboard text was inserted more than once or lost.");
    const output = await screen(daemon.base, target.runtimeId);
    assert(countOccurrences(output, `ACK:${text}`) === 1, "The clipboard text did not arrive as one exact terminal line.");
  } finally {
    await stopChild(textOwner);
  }
  console.log(`ok - ${backend} OS clipboard text reaches the selected terminal exactly once`);

  const previous = await readRecord(daemon.root, target.runtimeId);
  const pasteFilesBefore = new Set(await readdir(join(daemon.root, "pastes")).catch(() => []));
  const imageOwner = await setClipboard(backend, profile, "image/png", PNG_FIXTURE);
  try {
    await shell.driver.click(await shell.driver.find(`#panes .pane[data-pane="${target.paneId}"]`));
    const shellMarker = await shell.driver.execute<string | null>(
      `return window.__OMP_DESKTOP_SHELL__ ?? null;`,
    );
    assert(shellMarker === "gtk", `Native-shell capability marker was ${JSON.stringify(shellMarker)} on ${await shell.driver.currentUrl()}.`);
    await shell.driver.execute(`
      delete document.documentElement.dataset.ompNativePasteObservation;
      document.addEventListener("paste", event => {
        const data = event.clipboardData;
        const items = Array.from(data?.items ?? []).map(item => {
          const file = item.getAsFile();
          return { kind: item.kind, type: item.type, fileName: file?.name ?? null,
            fileType: file?.type ?? null, fileSize: file?.size ?? null };
        });
        document.documentElement.dataset.ompNativePasteObservation = JSON.stringify({
          trusted: event.isTrusted, types: Array.from(data?.types ?? []), items,
          textPlain: data?.getData("text/plain") ?? null,
          marker: window.__OMP_DESKTOP_SHELL__ ?? null, url: location.href,
          clipboardReadAvailable: typeof navigator.clipboard?.read === "function"
        });
      }, { capture: true, once: true });
    `);
    await shell.driver.keyPress("v", PRIVATE_USE_CONTROL);
    let newPaste: string;
    try {
      newPaste = await waitFor("native OS PNG clipboard to upload into the real daemon paste store", async () => {
        const files = await readdir(join(daemon.root, "pastes")).catch(() => []);
        const fresh = files.find((name) => !pasteFilesBefore.has(name));
        return fresh ? join(daemon.root, "pastes", fresh) : false;
      }, 20_000);
    } catch (error) {
      let page: unknown;
      try {
        page = await shell.driver.execute<unknown>(
          `return { url: location.href, title: document.title, readyState: document.readyState,
            status: document.getElementById("status")?.textContent ?? null,
            body: document.body?.innerText?.slice(0, 500) ?? null,
            marker: window.__OMP_DESKTOP_SHELL__ ?? null,
            clipboardReadAvailable: typeof navigator.clipboard?.read === "function",
            pasteObservation: document.documentElement.dataset.ompNativePasteObservation ?? null };`,
        );
      } catch (pageError) {
        page = { evaluationError: String(pageError) };
      }
      let clipboardPermission: unknown;
      try {
        clipboardPermission = await shell.driver.executeAsync<unknown>(
          `const done = arguments[arguments.length - 1];
           if (!navigator.permissions?.query) { done({ available: false }); return; }
           navigator.permissions.query({ name: "clipboard-read" })
             .then(permission => done({ state: permission.state }))
             .catch(error => done({ error: error.name + ": " + error.message }));`,
        );
      } catch (permissionError) {
        clipboardPermission = { error: String(permissionError) };
      }
      throw new Error(`${String(error)}; page state: ${JSON.stringify(page)}; clipboard-read permission: ${JSON.stringify(clipboardPermission)}`);
    }
    const pasteObservation = await shell.driver.execute<unknown>(
      `const raw = document.documentElement.dataset.ompNativePasteObservation;
       return raw ? JSON.parse(raw) : null;`,
    );
    assert(isRecord(pasteObservation) && pasteObservation.trusted === true &&
      pasteObservation.marker === "gtk" && Array.isArray(pasteObservation.types) &&
      Array.isArray(pasteObservation.items) && typeof pasteObservation.url === "string" &&
      new URL(pasteObservation.url).origin === new URL(daemon.base).origin,
    `The actual trusted PNG paste event did not carry the GTK capability/origin: ${JSON.stringify(pasteObservation)}`);
    const imageFileDelivered = pasteObservation.items.some((item) =>
      isRecord(item) && item.kind === "file" && typeof item.fileType === "string" &&
      item.fileType.startsWith("image/"),
    );
    const emptyEventClipboardFallback = pasteObservation.types.length === 0 &&
      pasteObservation.clipboardReadAvailable === true;
    assert(imageFileDelivered || emptyEventClipboardFallback,
      `PNG paste event provided neither an image File nor the empty-event clipboard fallback: ${JSON.stringify(pasteObservation)}`);
    console.log(`Observed trusted OS paste event: ${JSON.stringify(pasteObservation)}`);
    const pastedBytes = await readFile(newPaste);
    assert(pastedBytes.equals(PNG_FIXTURE), "PNG clipboard upload bytes differ from the OS clipboard payload.");
    // Image paste types the daemon-generated path verbatim; file drops use shell quoting.
    const expectedPath = `${newPaste} `;
    await shell.driver.waitFor(async () => await shell.driver.execute<boolean>(
      `return document.getElementById("status")?.textContent === "image path typed";`,
    ), "the image-paste handler to report its successful path insertion");
    const beforeEnter = await readRecord(daemon.root, target.runtimeId);
    assert(beforeEnter.equals(previous), "PNG paste sent bytes before an explicit Enter, so it may have appended a newline.");
    await shell.driver.keyPress(PRIVATE_USE_ENTER);
    const expectedPathAndEnter = `${expectedPath}\n`;
    await waitFor("the exact uploaded PNG path and one explicit Enter to reach the selected PTY", async () => {
      const record = await readRecord(daemon.root, target.runtimeId);
      return record.equals(Buffer.concat([previous, Buffer.from(expectedPathAndEnter)])) ? record : false;
    });
    const afterImage = await readRecord(daemon.root, target.runtimeId);
    const delta = afterImage.subarray(previous.length).toString("utf8");
    assert(delta === expectedPathAndEnter, `PNG paste inserted an unexpected or duplicate PTY path: ${JSON.stringify(delta)}`);
  } finally {
    await stopChild(imageOwner);
  }
  console.log(`ok - ${backend} OS clipboard PNG uploads exact bytes and inserts one path into PTY input`);

  const dropFile = join(daemon.root, "drop with 'quote.txt");
  await writeFile(dropFile, "file-drop-event-contract");
  const beforeDrop = await readRecord(daemon.root, target.runtimeId);
  const unrelatedRecords = new Map<string, Buffer>();
  for (const pane of bindings) {
    if (pane.runtimeId !== target.runtimeId) {
      unrelatedRecords.set(pane.runtimeId, await readRecord(daemon.root, pane.runtimeId));
    }
  }
  const expectedDrop = `'${dropFile.replace(/'/g, "'\\''")}' `;
  await shell.driver.evaluate(({ paneId, path }) => {
    const pane = document.querySelector<HTMLElement>(`#panes .pane[data-pane="${paneId}"]`);
    if (!pane) throw new Error("missing target pane");
    const rect = pane.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    window.dispatchEvent(new CustomEvent("omp-desktop-file-drop", {
      detail: { paths: [path, `${path}\nforged`], x, y },
    }));
    return { x, y };
  }, { paneId: target.paneId, path: dropFile });
  assert((await readRecord(daemon.root, target.runtimeId)).equals(beforeDrop),
    "The native file-drop event appended a newline instead of leaving the quoted path pending.");
  await shell.driver.keyPress(PRIVATE_USE_ENTER);
  const expectedDropAndEnter = `${expectedDrop}\n`;
  const afterDrop = await waitFor("the native file-drop path and one explicit Enter to reach the target PTY", async () => {
    const record = await readRecord(daemon.root, target.runtimeId);
    return record.equals(Buffer.concat([beforeDrop, Buffer.from(expectedDropAndEnter)])) ? record : false;
  });
  const dropDelta = afterDrop.subarray(beforeDrop.length).toString("utf8");
  assert(dropDelta === expectedDropAndEnter, `File-drop event consumer failed CSS hit-testing, quote escaping, control-character filtering, or no-newline behavior: ${JSON.stringify(dropDelta)}`);
  for (const [runtimeId, before] of unrelatedRecords) {
    assert((await readRecord(daemon.root, runtimeId)).equals(before),
      `File-drop path was dispatched to unrelated runtime ${runtimeId}.`);
  }
  assert((await shell.driver.currentUrl()).startsWith(daemon.base),
    "File-drop event changed the WebView location.");
  console.log("ok - event contract targets the CSS pane, quotes/filter controls, preserves no-newline semantics and leaves unrelated PTYs untouched (not OS DnD)");
}

async function clickPolicyLink(driver: WebDriver, url: string, targetBlank: boolean): Promise<void> {
  await driver.execute(`
    document.getElementById("native-policy-link")?.remove();
    const anchor = document.createElement("a");
    anchor.id = "native-policy-link";
    anchor.href = arguments[0];
    anchor.target = arguments[1] ? "_blank" : "_self";
    anchor.textContent = "native navigation policy fixture";
    anchor.style.cssText = "position:fixed;left:12px;top:12px;z-index:2147483647;padding:14px;background:#fff;color:#000";
    document.body.append(anchor);
  `, [url, targetBlank]);
  await driver.click(await driver.find("#native-policy-link"));
  await driver.execute(`document.getElementById("native-policy-link")?.remove();`);
}


async function testNavigationPolicy(shell: Shell, daemon: TestDaemon, openLog: string): Promise<void> {
  const driver = shell.driver;
  const origin = `http://127.0.0.1:${daemon.port}`;
  const connectHandler = await driver.execute<boolean>("return Boolean(window.webkit?.messageHandlers?.ompDesktopConnect)");
  assert(!connectHandler, "The bootstrap-only ompDesktopConnect handler leaked onto the daemon page.");
  const startUrl = await driver.execute<string>("return location.href");
  const externalUrls = [
    "https://example.invalid/native-shell-external-https",
    "http://example.invalid/native-shell-external-http",
  ];
  for (const external of externalUrls) {
    await clickPolicyLink(driver, external, true);
    await waitFor(`external URL ${external} to be handed to the test-owned xdg-open`, async () => {
      const text = await readFile(openLog, "utf8").catch(() => "");
      return text.includes(external) ? true : false;
    }, 10_000);
  }
  assert(await driver.execute<string>("return location.href") === startUrl, "External navigation replaced the daemon WebView.");
  const handlesBefore = await driver.command<string[]>("GET", `/session/${driver.sessionId}/window/handles`);
  assert(handlesBefore.length === 1, "External target=_blank created an unmanaged WebView window.");

  let otherOriginReached = false;
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      otherOriginReached = true;
      return new Response("<!doctype html><title>other origin</title><script>window.clipboardAttempt=1;window.notificationAttempt=1</script>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  try {
    const denied = [
      "file:///etc/passwd",
      "data:text/html,%3Ctitle%3Edata-policy-page%3C/title%3E",
      `http://127.0.0.1:${other.port}/privileged-attempt`,
    ];
    for (const url of denied) {
      await clickPolicyLink(driver, url, false);
      await driver.executeAsync(`
        const done = arguments[arguments.length - 1];
        requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
      `);
      assert((await driver.execute<string>("return location.href")).startsWith(origin), `Disallowed destination replaced the WebView: ${url}`);
      const pageState = await driver.execute<{ origin: string; hasConnect: boolean }>(
        `return { origin: location.origin, hasConnect: Boolean(window.webkit?.messageHandlers?.ompDesktopConnect) };`,
      );
      assert(pageState.origin === origin && pageState.hasConnect === false,
        `A denied destination inherited shell capabilities: ${JSON.stringify(pageState)}`);
    }
    assert(!otherOriginReached, "The other-port content loaded, so it could attempt clipboard or notification access.");
    const allowedNewWindow = `${origin}/?native-policy-reused-window=1`;
    await clickPolicyLink(driver, allowedNewWindow, true);
    await driver.waitFor(async () => (await driver.execute<string>("return location.href")).includes("native-policy-reused-window=1"), "allowed new-window destination to reuse the managed view");
    const handlesAfter = await driver.command<string[]>("GET", `/session/${driver.sessionId}/window/handles`);
    assert(handlesAfter.length === 1, "Allowed new-window navigation created an unmanaged WebView.");
    await driver.waitFor(async () => await driver.execute<boolean>("return Boolean(document.querySelector('#new-session'))"),
      "same-origin new-window reuse to retain the real daemon UI");
    console.log("ok - real navigation clicks open external URLs via owned xdg-open; file/data/other-port pages are denied; allowed new windows reuse one view");
  } finally {
    other.stop(true);
  }
}

async function freeOccupiedPortServer(): Promise<{ port: number; stop(): void }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("not the desktop daemon", { status: 200 }),
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("The fixture-owned occupied endpoint did not bind a TCP port.");
  }
  return { port, stop: () => server.stop(true) };
}

async function testConnectionRetry(parent: string, binary: string, busAddress: string, display: string, runtimeDir: string): Promise<void> {
  const root = await mkdtemp(join(parent, "retry-port-"));
  const profile = await createProfile(root, "retry-profile", runtimeDir);
  const customPort = await allocatePort();
  configureX11Input(profile, display);
  profile.env.DBUS_SESSION_BUS_ADDRESS = busAddress;
  let daemon: TestDaemon | null = null;
  let shell: Shell | null = null;
  try {
    shell = await openShell(profile, customPort, binary);
    await shell.driver.waitFor(async () => {
      const retry = await shell!.driver.find("#retry").catch(() => null);
      return retry ? await shell!.driver.displayed(retry) : false;
    }, "visible bootstrap error and Retry for an unreachable custom port", 25_000);
    const failedUrl = await shell.driver.execute<string>("return location.href");
    assert(failedUrl.startsWith("omp://bootstrap/"), `Unreachable custom port left bootstrap unexpectedly: ${failedUrl}`);
    const detail = await shell.driver.elementText(await shell.driver.find("#detail"));
    assert(detail.length > 0, "Unreachable custom port showed no readable connection error.");
    daemon = await startTestDaemon({ root: join(root, "daemon"), port: customPort });
    await shell.driver.clickCss("#retry");
    await waitConnected(shell.driver, customPort);
    const buildResponse = await fetch(`${daemon.base}/api/build`);
    assert(buildResponse.ok, "Retry did not connect the app to the real daemon build endpoint.");
    if ((await runtimes(daemon.base)).length === 0) await shell.driver.clickCss("#new-session");
    await waitFor("Retry's new-session control to create a usable real daemon runtime", async () => {
      const current = await runtimes(daemon!.base);
      return current.some((runtime) => runtime.pid !== null && runtime.alive) ? true : false;
    });
    console.log("ok - bootstrap Retry recovers when the real daemon later binds the exact failed custom port");
  } finally {
    await cleanupOwned("Retry connection scenario", [
      async () => {
        if (shell) await closeShell(shell);
      },
      async () => {
        if (daemon) await daemon.stop();
      },
      () => rm(root, { recursive: true, force: true }),
    ]);
  }

  const occupiedRoot = await mkdtemp(join(parent, "occupied-port-"));
  let occupied: { port: number; stop(): void } | null = null;
  let occupiedShell: Shell | null = null;
  try {
    const endpoint = await freeOccupiedPortServer();
    occupied = endpoint;
    const occupiedProfile = await createProfile(occupiedRoot, "occupied-profile", runtimeDir);
    const serviceLog = join(occupiedRoot, "systemctl.log");
    const serviceRecorder = join(occupiedProfile.bin, "systemctl");
    await writeFile(serviceRecorder, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$OMP_DESKTOP_SYSTEMCTL_LOG\"\nexit 0\n", { mode: 0o700 });
    await chmod(serviceRecorder, 0o700);
    occupiedProfile.env.OMP_DESKTOP_SYSTEMCTL_LOG = serviceLog;
    occupiedShell = await openShell(occupiedProfile, endpoint.port, binary);
    await occupiedShell.driver.waitFor(async () => {
      const retry = await occupiedShell!.driver.find("#retry").catch(() => null);
      return retry ? await occupiedShell!.driver.displayed(retry) : false;
    }, "bootstrap failure at an occupied non-daemon endpoint", 25_000);
    const page = await occupiedShell.driver.execute<string>("return location.href");
    assert(page.startsWith("omp://bootstrap/"), `An occupied non-daemon endpoint escaped bootstrap: ${page}`);
    const info: unknown = await occupiedShell.driver.execute("return { href: location.href, text: document.querySelector('#detail')?.textContent || '' }");
    assert(isRecord(info) && typeof info.text === "string" && info.text.length > 0, "Occupied endpoint did not return visible failure detail.");
    const occupiedResponse = await fetch(`http://127.0.0.1:${endpoint.port}/api/build`);
    assert(occupiedResponse.ok && await occupiedResponse.text() === "not the desktop daemon",
      "The fixture-owned occupied endpoint was replaced or stopped during connection failure.");
    assert((await readFile(serviceLog, "utf8").catch(() => "")).length === 0,
      "An occupied custom port invoked systemctl instead of failing on bootstrap.");
    console.log("ok - occupied non-daemon endpoint remains on bootstrap with visible Retry and no service start");
  } finally {
    await cleanupOwned("occupied endpoint scenario", [
      async () => {
        if (occupiedShell) await closeShell(occupiedShell);
      },
      async () => {
        if (occupied) occupied.stop();
      },
      () => rm(occupiedRoot, { recursive: true, force: true }),
    ]);
  }
}

async function startXvfb(profile: Profile): Promise<{ child: ManagedChild; display: string }> {
  const binary = requireCommand(["Xvfb"], "Xvfb for isolated native WebDriver input and single-instance verification");
  const child = spawnTracked([binary, "-displayfd", "1", "-screen", "0", "1400x900x24", "-nolisten", "tcp", "-noreset", "-ac"], {
    env: profile.env,
    detached: true,
  });
  try {
    const number = await waitFor("the fixture-owned Xvfb display number", () => {
      if (child.proc.exitCode !== null) throw new Error(`Xvfb exited: ${child.stderr.text}`);
      const line = child.stdout.lines.find((entry) => /^\d+$/.test(entry));
      return line ? Number(line) : false;
    }, 10_000);
    return { child, display: `:${number}` };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
function configureX11Input(profile: Profile, display: string): void {
  profile.env.DISPLAY = display;
  profile.env.GDK_BACKEND = "x11";
  profile.env.GSK_RENDERER = "gl";
  delete profile.env.WAYLAND_DISPLAY;
  delete profile.env.XDG_SESSION_TYPE;
  delete profile.env.XAUTHORITY;
  profile.input = {
    xdotool: requireCommand(["xdotool"], "xdotool for real OS keyboard and pointer input"),
    timeout: requireCommand(["timeout"], "timeout for bounded native X11 input commands"),
    env: { ...profile.env },
    windowTitle: "OMP Desktop",
  };
}

async function startOpenbox(profile: Profile): Promise<ManagedChild> {
  const openbox = requireCommand(["openbox"], "Openbox for normal-mode window tests");
  const xprop = requireCommand(["xprop"], "xprop from x11-utils for actual window-manager readiness");
  const xdgConfig = resolve(dirname(openbox), "../../etc/xdg");
  const configFile = join(xdgConfig, "openbox", "rc.xml");
  const hasConfig = await fileExists(configFile);
  const env = {
    ...profile.env,
    XDG_DATA_DIRS: [
      resolve(dirname(openbox), "../share"),
      process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share",
    ].join(":"),
    ...(hasConfig ? { XDG_CONFIG_HOME: xdgConfig } : {}),
  };
  const child = spawnTracked([
    openbox,
    "--sm-disable",
    ...(hasConfig ? ["--config-file", configFile] : []),
  ], { env, stdout: "pipe", stderr: "pipe", detached: true });
  try {
    await waitFor("fixture Openbox WM selection and EWMH registration", () => {
      if (child.proc.exitCode !== null) throw new Error(`Openbox exited (${child.proc.exitCode}): ${child.stdout.text}\n${child.stderr.text}`);
      const root = commandOutput([xprop, "-root", "_NET_SUPPORTING_WM_CHECK"], profile.env);
      const windowId = root.match(/window id # (0x[0-9a-f]+)/i)?.[1];
      if (!windowId) return false;
      return /Openbox/i.test(commandOutput([xprop, "-id", windowId, "_NET_WM_NAME"], profile.env));
    }, 15_000);
    return child;
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function startNormalShell(profile: Profile, port: number, binary: string): Promise<NormalShell> {
  if (!profile.input) throw new Error("Normal-mode GTK app requires the real X11 input backend.");
  const python = await fileExists("/usr/bin/python3") ? "/usr/bin/python3" : requireCommand(["python3"], "Python 3 with PyGObject AT-SPI bindings");
  const helperPath = join(ROOT, "scripts", "fixtures", "accessibility.py");
  const accessibilityProcess = spawnTracked([python, helperPath], {
    env: profile.env,
    stdin: "pipe",
    detached: true,
  });
  const accessibility = new AccessibilityClient(accessibilityProcess);
  let app: ManagedChild | null = null;
  let lastSnapshot: AccessibilityNode | null = null;
  let lastSnapshotError: string | null = null;
  try {
    await accessibility.waitForRegistry(process.pid);
    app = spawnTracked([binary], {
      env: { ...profile.env, OMP_DESKTOP_PORT: String(port) },
      detached: true,
    });
    const windowId = await waitFor("one visible normal GTK application window", async () => {
      if (app!.proc.exitCode !== null) throw new Error(`Normal GTK app exited before showing a window: ${app!.stderr.text}`);
      const windows = await visibleWindows(profile.input!.xdotool, profile.env);
      if (windows.length > 1) throw new Error(`Expected one normal GTK window, found ${windows.length}.`);
      return windows.length === 1 ? windows[0]! : false;
    }, 30_000);
    const tree = await waitFor("the accessible normal GTK daemon UI", async () => {
      if (app!.proc.exitCode !== null) throw new Error(`Normal GTK app exited before accessibility was available: ${app!.stderr.text}`);
      try {
        lastSnapshot = await accessibility.snapshot(app!.proc.pid);
        return walkAccessibilityTree(lastSnapshot).some((node) => node.name === "Sidebar settings")
          ? lastSnapshot
          : false;
      } catch (error) {
        lastSnapshotError = String(error);
        if (accessibilityProcess.proc.exitCode !== null) {
          throw new Error(`AT-SPI helper exited: ${accessibilityProcess.stderr.text}; ${lastSnapshotError}`);
        }
        return false;
      }
    }, 45_000);
    assert(tree.processid === app.proc.pid || walkAccessibilityTree(tree).some((node) => node.processid === app!.proc.pid),
      `AT-SPI snapshot was not rooted at normal app PID ${app.proc.pid}.`);
    return { app, accessibilityProcess, accessibility, profile, pid: app.proc.pid, windowId, closed: false };
  } catch (error) {
    const summary = app ? `\nnormal app stdout:\n${app.stdout.text}\nnormal app stderr:\n${app.stderr.text}` : "";
    const axSummary = app && accessibilityProcess.proc.exitCode === null
      ? `\nAT-SPI stderr:\n${accessibilityProcess.stderr.text}\nlast snapshot error: ${lastSnapshotError ?? "none"}\nlast AX tree:\n${lastSnapshot ? normalTreeSummary(lastSnapshot) : "no application tree snapshot"}`
      : "";
    accessibility.close();
    try {
      await cleanupOwned("normal GTK startup", [
        async () => {
          if (app) await stopChild(app);
        },
        async () => await stopChild(accessibilityProcess),
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Normal GTK startup failed and owned process cleanup also failed.");
    }
    throw new Error(`${String(error)}${summary}${axSummary}`);
  }
}


async function closeNormalShell(shell: NormalShell): Promise<void> {
  if (shell.closed) return;
  const input = shell.profile.input;
  assert(input, "Normal GTK window lost its X11 input backend before close.");
  let visibleAfterClose: string[] = [];
  let closeError: unknown = null;
  let exited = shell.app.proc.exitCode !== null;
  if (!exited) {
    try {
      runNormalXdotool(shell, ["windowactivate", "--sync", shell.windowId]);
      const focused = runNormalXdotool(shell, ["getwindowfocus"]);
      if (focused !== shell.windowId) throw new Error(`Openbox did not focus the owned window before close (${focused}).`);
      const windowId = Number(shell.windowId);
      if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error(`Invalid exact GTK window id ${shell.windowId}.`);
      const wmctrl = requireCommand(["wmctrl"], "wmctrl for exact-window WM_DELETE_WINDOW");
      const result = Bun.spawnSync({
        cmd: [input.timeout, "--signal=TERM", "--kill-after=1s", "5s", wmctrl, "-i", "-c", `0x${windowId.toString(16)}`],
        env: input.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(result.stdout).trim();
      const stderr = new TextDecoder().decode(result.stderr).trim();
      if (result.exitCode !== 0) throw new Error(`wmctrl -i -c failed (${result.exitCode}): ${stderr || stdout}`);
    } catch (error) {
      closeError = error;
    }
    exited = await Promise.race([
      shell.app.proc.exited.then(() => true),
      Bun.sleep(15_000).then(() => false),
    ]);
    if (!exited) visibleAfterClose = await visibleWindows(input.xdotool, input.env);
  }
  shell.closed = true;
  shell.accessibility.close();
  try {
    await cleanupOwned("normal GTK app close", [
      async () => await stopChild(shell.app),
      async () => await stopChild(shell.accessibilityProcess),
    ]);
  } catch (cleanupError) {
    if (closeError) throw new AggregateError([closeError, cleanupError], "Normal GTK close and owned-child cleanup failed.");
    throw cleanupError;
  }
  if (!exited) {
    throw new Error(`Normal GTK app did not exit after exact-window wmctrl WM_DELETE_WINDOW; visible windows=${JSON.stringify(visibleAfterClose)}${closeError ? `: ${String(closeError)}` : ""}.`);
  }
}

function typeNormalText(shell: NormalShell, text: string): void {
  let ascii = "";
  const flush = (): void => {
    if (!ascii) return;
    runNormalXdotool(shell, ["type", "--clearmodifiers", "--delay", "0", ascii]);
    ascii = "";
  };
  for (const character of text) {
    const codepoint = character.codePointAt(0)!;
    if (codepoint === 0x0a || codepoint === 0x0d) {
      flush();
      runNormalXdotool(shell, ["key", "--clearmodifiers", "Return"]);
    } else if (codepoint >= 0x20 && codepoint <= 0x7e) {
      ascii += character;
    } else if (codepoint > 0x7e) {
      flush();
      runNormalXdotool(shell, ["key", "--clearmodifiers", `U${codepoint.toString(16).toUpperCase()}`]);
    }
  }
  flush();
}

async function testNormalTerminalInput(
  shell: NormalShell,
  daemon: TestDaemon,
  runtimeId: string,
  screenshotPath: string,
): Promise<void> {
  await waitFor("normal GTK target PTY to emit its deterministic ready screen", async () =>
    (await screen(daemon.base, runtimeId)).includes("FAKE-OMP READY") ? true : false);
  const initialRecord = await readRecord(daemon.root, runtimeId);
  const tree = await waitForAccessibleTree(shell, "normal GTK terminal input to become accessible", (snapshot) =>
    walkAccessibilityTree(snapshot).some((node) =>
      node.role.toLowerCase() === "entry" && node.name === "Terminal input" && node.states.includes("enabled"),
    ), 20_000);
  const terminalInputs = walkAccessibilityTree(tree)
    .filter((node) => node.role.toLowerCase() === "entry" && node.name === "Terminal input");
  const terminalInput = terminalInputs.find((node) => node.states.includes("focused")) ??
    (terminalInputs.length === 1 ? terminalInputs[0] : undefined);
  assert(terminalInput, `Normal GTK has no uniquely focused terminal input:\n${normalTreeSummary(tree)}`);
  clickAccessible(shell, terminalInput);
  await waitForAccessibleTree(shell, "normal GTK terminal textarea to receive native X11 focus", (snapshot) =>
    walkAccessibilityTree(snapshot).some((node) =>
      node.role.toLowerCase() === "entry" && node.name === "Terminal input" && node.states.includes("focused"),
    ));
  const marker = "native-normal-echo-✓";
  typeNormalText(shell, `${marker}\n`);
  const expectedBytes = Buffer.from(`${marker}\n`, "utf8");
  await waitFor("normal GTK X11 key events to reach the owned PTY exactly once", async () => {
    const bytes = await readRecord(daemon.root, runtimeId);
    const delta = bytes.subarray(initialRecord.length);
    return delta.length >= expectedBytes.length && delta.equals(expectedBytes) ? bytes : false;
  });
  const output = await waitFor("normal GTK PTY to acknowledge the actual X11 input", async () => {
    const value = await screen(daemon.base, runtimeId);
    return value.includes(`ACK:${marker}`) ? value : false;
  });
  assert(countOccurrences(output, `ACK:${marker}`) === 1, "Normal GTK input did not produce exactly one daemon screen ACK.");
  // /screen is daemon state; capture immediately, then again after 2s to distinguish delayed WebKit paint from missing output.
  await captureNormalScreenshot(shell, screenshotPath);
  await Bun.sleep(2_000);
  const delayedScreenshotPath = `${screenshotPath.replace(/\.png$/i, "")}-after-2s.png`;
  await captureNormalScreenshot(shell, delayedScreenshotPath);
  console.log(`ok - normal production GTK accepted native X11 UTF-8 input and verified one daemon ACK; immediate and 2s native screenshots captured`);
}
function runNormalXdotool(shell: NormalShell, args: string[]): string {
  const input = shell.profile.input;
  if (!input) throw new Error("Normal GTK app has no X11 input backend.");
  const result = Bun.spawnSync({
    cmd: [input.timeout, "--signal=TERM", "--kill-after=1s", "5s", input.xdotool, ...args],
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) throw new Error(`xdotool ${args[0]} exited ${result.exitCode}: ${stderr || stdout}`);
  return stdout;
}

function focusNormalWindow(shell: NormalShell): void {
  runNormalXdotool(shell, ["windowactivate", "--sync", shell.windowId]);
}

function clickAccessible(shell: NormalShell, node: AccessibilityNode): void {
  const rect = node.windowExtents;
  if (!rect || rect.width < 1 || rect.height < 1) {
    throw new Error(`Accessible ${node.role} ${JSON.stringify(node.name)} has no clickable window-relative extent.`);
  }
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  const input = shell.profile.input;
  if (!input) throw new Error("Normal GTK app has no X11 input backend.");
  const geometry = commandOutput([input.xdotool, "getwindowgeometry", "--shell", shell.windowId], input.env);
  console.log(
    `X11 click ${node.role} ${JSON.stringify(node.name)} at window ${x},${y}; ` +
    `AXSCREEN=${JSON.stringify(node.extents)} AXWINDOW=${JSON.stringify(rect)} X11=${JSON.stringify(geometry)}`,
  );
  focusNormalWindow(shell);
  runNormalXdotool(shell, [
    "mousemove", "--window", shell.windowId, String(x), String(y),
    "click", "--clearmodifiers", "1",
  ]);
}


async function normalSnapshot(shell: NormalShell): Promise<AccessibilityNode> {
  return await shell.accessibility.snapshot(shell.pid);
}

function normalTreeSummary(tree: AccessibilityNode, limit = 120): string {
  return walkAccessibilityTree(tree).slice(0, limit)
    .map((node) => `${node.role}:${JSON.stringify(node.name)}[${node.states.join(",")}]@${JSON.stringify(node.extents)}`)
    .join("\n");
}

function accessibleButton(root: AccessibilityNode, name: string): AccessibilityNode | undefined {
  return walkAccessibilityTree(root).find((node) => node.name === name && /button/i.test(node.role));
}


function accessibleIsPressed(node: AccessibilityNode): boolean {
  const states = new Set(node.states.map((state) => state.toLowerCase()));
  return states.has("pressed") || states.has("checked") || states.has("selected");
}
function accessibleOptionName(value: string): string {
  const normalized = value.trim().toLowerCase();
  const notificationToggle = normalized.match(/^completion notifications\s+(off|on)$/);
  return notificationToggle?.[1] ?? normalized;
}

function accessibleGroupButtons(root: AccessibilityNode, groupName: string, buttonNames: string[]): AccessibilityNode[] {
  const group = walkAccessibilityTree(root).find((node) => node.name === groupName && node.children.length > 0);
  if (!group) return [];
  return walkAccessibilityTree(group).filter((node) =>
    buttonNames.some((name) => accessibleOptionName(node.name) === name.toLowerCase()) && /button/i.test(node.role));
}

function normalPreferenceState(root: AccessibilityNode): {
  folders: boolean | null;
  motionReduced: boolean | null;
  notifications: boolean | null;
  notificationStatus: string | null;
} {
  const folders = accessibleGroupButtons(root, "Sidebar view", ["Folders", "Sessions"])
    .find((node) => accessibleOptionName(node.name) === "folders");
  const motion = accessibleGroupButtons(root, "Working indicator motion", ["Off", "System", "On"])
    .find((node) => accessibleOptionName(node.name) === "off");
  const notifications = accessibleGroupButtons(root, "Completion notifications", ["Off", "On"]);
  const notificationButton = notifications.find((node) => accessibleOptionName(node.name) === "on") ??
    notifications.find((node) => accessibleOptionName(node.name) === "off");
  const status = walkAccessibilityTree(root).find((node) => /Completion notifications are (?:on|off)\./.test(node.name));
  return {
    folders: folders ? accessibleIsPressed(folders) : null,
    motionReduced: motion ? accessibleIsPressed(motion) : null,
    notifications: notificationButton ? accessibleIsPressed(notificationButton) : null,
    notificationStatus: status?.name ?? null,
  };
}

async function openNormalSettings(shell: NormalShell): Promise<AccessibilityNode> {
  const before = await normalSnapshot(shell);
  if (accessibleGroupButtons(before, "Completion notifications", ["Off", "On"]).length > 0) return before;
  const settings = accessibleButton(before, "Sidebar settings");
  if (!settings) throw new Error(`Normal GTK settings button is absent from AT-SPI tree:\n${normalTreeSummary(before)}`);
  clickAccessible(shell, settings);
  return await waitForAccessibleTree(shell, "accessible sidebar settings controls", (tree) =>
    accessibleGroupButtons(tree, "Completion notifications", ["Off", "On"]).length > 0);
}

async function setNormalGroupToggle(
  shell: NormalShell,
  groupName: string,
  preferredButtonName: string,
  buttonNames: string[],
  desired: boolean,
): Promise<AccessibilityNode> {
  const currentTree = await waitForAccessibleTree(shell, `${groupName} accessible control`, (tree) =>
    accessibleGroupButtons(tree, groupName, buttonNames).length > 0);
  const select = (tree: AccessibilityNode): AccessibilityNode | undefined => {
    const controls = accessibleGroupButtons(tree, groupName, buttonNames);
    return controls.find((node) => accessibleOptionName(node.name) === preferredButtonName.toLowerCase()) ?? controls[0];
  };
  const control = select(currentTree);
  if (!control) throw new Error(`Missing AT-SPI control ${groupName}/${buttonNames.join("|")}.\n${normalTreeSummary(currentTree)}`);
  if (accessibleIsPressed(control) === desired) return currentTree;
  clickAccessible(shell, control);
  return await waitForAccessibleTree(shell, `${groupName} control state ${desired}`, (tree) => {
    const updated = select(tree);
    return Boolean(updated && accessibleIsPressed(updated) === desired);
  });
}

async function setNormalPreferences(shell: NormalShell): Promise<AccessibilityNode> {
  await openNormalSettings(shell);
  await setNormalGroupToggle(shell, "Sidebar view", "Folders", ["Folders", "Sessions"], true);
  await setNormalGroupToggle(shell, "Working indicator motion", "Off", ["Off", "System", "On"], true);
  await setNormalGroupToggle(shell, "Completion notifications", "Off", ["Off", "On"], true);
  const tree = await waitForAccessibleTree(shell, "real notification permission to be granted", (snapshot) => {
    const state = normalPreferenceState(snapshot);
    return state.folders === true && state.motionReduced === true && state.notifications === true;
  }, 20_000);
  const state = normalPreferenceState(tree);
  console.log(`Normal-mode user controls set preferences: ${JSON.stringify(state)}`);
  return tree;
}

async function verifyNormalPreferences(shell: NormalShell): Promise<void> {
  const tree = await openNormalSettings(shell);
  const state = normalPreferenceState(tree);
  assert(state.folders === true && state.motionReduced === true && state.notifications === true,
  `Normal production profile did not restore exact opted-in preferences: ${JSON.stringify(state)}\n${normalTreeSummary(tree)}`);
}

async function closeNormalSettings(shell: NormalShell): Promise<void> {
  const tree = await normalSnapshot(shell);
  if (accessibleGroupButtons(tree, "Completion notifications", ["Off", "On"]).length === 0) return;
  const back = accessibleButton(tree, "Back to the sidebar");
  if (!back) throw new Error(`Normal GTK settings view has no accessible Back control:\n${normalTreeSummary(tree)}`);
  clickAccessible(shell, back);
  await waitForAccessibleTree(shell, "normal sidebar to return after settings", (snapshot) =>
    accessibleButton(snapshot, "Sidebar settings") !== undefined);
}

async function waitForAccessibleTree(
  shell: NormalShell,
  label: string,
  predicate: (tree: AccessibilityNode) => boolean,
  timeoutMs = 15_000,
): Promise<AccessibilityNode> {
  return await waitFor(label, async () => {
    if (shell.app.proc.exitCode !== null) throw new Error(`Normal GTK app exited during accessibility polling: ${shell.app.stderr.text}`);
    try {
      const tree = await normalSnapshot(shell);
      return predicate(tree) ? tree : false;
    } catch (error) {
      if (shell.accessibilityProcess.proc.exitCode !== null) {
        throw new Error(`AT-SPI helper exited: ${shell.accessibilityProcess.stderr.text}; ${String(error)}`);
      }
      return false;
    }
  }, timeoutMs);
}

async function captureNormalScreenshot(shell: NormalShell, path: string): Promise<void> {
  const scrot = requireCommand(["scrot"], "scrot for owned normal GTK window screenshots");
  focusNormalWindow(shell);
  const focused = runNormalXdotool(shell, ["getwindowfocus"]);
  assert(focused === shell.windowId, `Cannot capture OMP Desktop; focused X11 window is ${focused}.`);
  await mkdir(dirname(path), { recursive: true });
  const result = Bun.spawnSync({ cmd: [scrot, "--format", "png", "--overwrite", "-u", path], env: shell.profile.env, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(`scrot failed with ${result.exitCode}: ${stderr || stdout}`);
  const image = await readFile(path);
  assert(image.length > 0, `scrot produced an empty normal GTK screenshot at ${path}.`);
  console.log(`Captured normal-mode GTK window screenshot: ${path} (${image.length} bytes)`);
}


function commandOutput(cmd: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} exited ${result.exitCode}: ${stderr || stdout}`);
  return stdout.trim();
}

async function visibleWindows(xdotool: string, env: Record<string, string>): Promise<string[]> {
  const result = Bun.spawnSync({ cmd: [xdotool, "search", "--onlyvisible", "--name", "^OMP Desktop$"], env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).trim().split(/\s+/).filter(Boolean);
}

async function testNormalSingleInstance(
  shell: NormalShell,
  binary: string,
  daemon: TestDaemon,
  runtimesBefore: RuntimeInfo[],
  screenshotPath: string,
): Promise<void> {
  const input = shell.profile.input;
  assert(input, "Normal single-instance test has no X11 display.");
  const beforeIds = (await runtimes(daemon.base))
    .map(({ id, pid }) => [id, pid] as [string, number | null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const expectedIds = runtimesBefore
    .map(({ id, pid }) => [id, pid] as [string, number | null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert(JSON.stringify(beforeIds) === JSON.stringify(expectedIds),
    "Normal shell profile startup changed daemon-owned runtime ids or pids.");
  let second: ManagedChild | null = null;
  try {
    runNormalXdotool(shell, ["windowminimize", shell.windowId]);
    second = spawnTracked([binary], {
      env: { ...shell.profile.env, OMP_DESKTOP_PORT: String(daemon.port) },
      detached: true,
    });
    await waitFor("second normal application process to activate then exit", () => second!.proc.exitCode !== null, 30_000);
    assert(second.proc.exitCode === 0, `Second normal binary exited ${second.proc.exitCode}: ${second.stderr.text}`);
    await waitFor("one visible window after second-instance activation", async () => {
      const windows = await visibleWindows(input.xdotool, input.env);
      return windows.length === 1 && windows[0] === shell.windowId ? windows : false;
    }, 10_000);
    const focus = runNormalXdotool(shell, ["getwindowfocus"]);
    assert(focus === shell.windowId, `Second launch did not unminimize and focus the original native window (${focus} != ${shell.windowId}).`);
    const afterIds = (await runtimes(daemon.base))
      .map(({ id, pid }) => [id, pid] as [string, number | null])
      .sort((a, b) => a[0].localeCompare(b[0]));
    assert(JSON.stringify(afterIds) === JSON.stringify(beforeIds), "Second normal launch created or replaced a daemon runtime.");
    await captureNormalScreenshot(shell, screenshotPath);
    console.log("ok - second normal binary unminimizes/focuses the same GTK window, exits, and adds no runtime on the same bus/display/profile");
  } catch (error) {
    if (second) console.error(`Second normal process stdout:\n${second.stdout.text}\nstderr:\n${second.stderr.text}`);
    throw error;
  } finally {
    if (second) await stopChild(second);
  }
}

async function buildImageServer(): Promise<ImageFixture> {
  const entry = join(ROOT, "scripts", "fixtures", "image-terminal.ts");
  const build = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "Native image fixture bundle failed to build.");
  const script = await build.outputs[0]!.text();
  const xtermCss = Bun.file(join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/build") return Response.json({ build: "nativeimagefixture" }, { headers: { "cache-control": "no-store" } });
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/xterm.css") return new Response(xtermCss, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (path === "/" || path === "/index.html") {
        return new Response(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><style>html,body{margin:0;background:#000}#terminal{width:1000px;height:600px}</style><div id="terminal"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("The native image asset server did not bind a TCP port.");
  }
  return { server: { port, stop: (force?: boolean) => server.stop(force) }, url: `http://127.0.0.1:${port}` };
}

async function webglRenderer(driver: WebDriver): Promise<{ supported: boolean; renderer: string }> {
  return await driver.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return { supported: false, renderer: "WebGL2 unavailable" };
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return { supported: true, renderer };
  });
}

async function testNativeImages(parent: string, binary: string, busAddress: string, requireGpu: boolean, runtimeDir: string): Promise<void> {
  const root = await mkdtemp(join(parent, "native-images-"));
  let fixture: ImageFixture | null = null;
  let shell: Shell | null = null;
  let failure: { error: unknown } | null = null;
  try {
    const imageFixture = await buildImageServer();
    fixture = imageFixture;
    const profile = await createProfile(root, "image-profile", runtimeDir);
    profile.env.DBUS_SESSION_BUS_ADDRESS = busAddress;
    for (const key of ["LIBGL_ALWAYS_SOFTWARE", "MESA_LOADER_DRIVER_OVERRIDE", "GALLIUM_DRIVER"]) {
      const value = process.env[key];
      if (value !== undefined) profile.env[key] = value;
    }
    shell = await openShell(profile, imageFixture.server.port, binary);
    console.log(`Opened native image automation view for ${imageFixture.url}.`);
    await shell.driver.waitFor(async () => (await shell!.driver.execute<string>("return location.href")).startsWith(imageFixture.url),
      "automation view to open the image fixture origin", 30_000);
    await shell.driver.waitFor(async () => await shell!.driver.execute<boolean>("return Boolean(document.querySelector('#terminal'))"),
      "the fixture-owned native image page", 30_000);
    console.log("Native image fixture page is loaded; running shared DOM assertions.");
    await runImageAssertions(shell.driver);
    console.log("ok - native WebKitGTK DOM image pixel, clipping, erase, pressure, scrollback and replay assertions");

    const webgl = await webglRenderer(shell.driver);
    const graphics = await observeGraphicsDescriptors(shell.host.proc.pid);
    const rendererSoftware = /llvmpipe|software|swiftshader|mesa offscreen/i.test(webgl.renderer);
    const libglOverride = profile.env.LIBGL_ALWAYS_SOFTWARE?.trim() ?? "";
    const mesaOverrides = `${profile.env.MESA_LOADER_DRIVER_OVERRIDE ?? ""} ${profile.env.GALLIUM_DRIVER ?? ""}`;
    const explicitSoftware =
      (libglOverride !== "" && !/^(?:0|false|no)$/i.test(libglOverride)) ||
      /llvmpipe|softpipe|swrast|software/i.test(mesaOverrides);
    const software = rendererSoftware || explicitSoftware || graphics.softwareWebKitProcessIds.length > 0;
    const rendererNamesHardware = /nvidia|amd|radeon|intel|mali|adreno/i.test(webgl.renderer);
    const nvidiaProcessProof = graphics.nvidiaWebKitGraphicsProcessIds.length > 0;
    const hardware = webgl.supported && !software && (rendererNamesHardware || nvidiaProcessProof);
    console.log(`native image graphics provenance: ${JSON.stringify({
      webglSupported: webgl.supported,
      webglRenderer: webgl.renderer,
      rendererStringMasked: /^Apple GPU$/i.test(webgl.renderer),
      explicitLibglSoftware: explicitSoftware,
      softwareWebKitProcessIds: graphics.softwareWebKitProcessIds,
      webkitProcesses: graphics.webkitProcesses,
      nvidiaGraphicsProcessIds: graphics.nvidiaGraphicsProcessIds,
      nvidiaWebKitGraphicsProcessIds: graphics.nvidiaWebKitGraphicsProcessIds,
    })}`);
    if (!hardware) {
      const reason = !webgl.supported
        ? webgl.renderer
        : software
          ? `software WebGL path (renderer ${JSON.stringify(webgl.renderer)}, forced=${explicitSoftware}, software process IDs=${graphics.softwareWebKitProcessIds.join(",")})`
          : `hardware not proven for renderer ${JSON.stringify(webgl.renderer)}`;
      if (requireGpu) throw new Error(`GPU-required native image run cannot accept an unverified renderer: ${reason}`);
      console.log(`Native WebGL image assertions not run: ${reason}; DOM image assertions passed.`);
      return;
    }

    await shell.driver.navigate(`${imageFixture.url}/?renderer=webgl`);
    await shell.driver.waitFor(async () => (await shell!.driver.execute<string>("return location.href")).includes("?renderer=webgl"),
      "the fixture-owned WebGL image page", 30_000);
    await shell.driver.waitFor(async () => await shell!.driver.execute<boolean>("return Boolean(document.querySelector('#terminal'))"),
      "the fixture-owned WebGL terminal", 30_000);
    await runImageAssertions(shell.driver);
    console.log(`ok - native WebKitGTK WebGL image assertions (${webgl.renderer}; NVIDIA WebKit process proof=${nvidiaProcessProof})`);
  } catch (error) {
    if (shell) {
      console.error(`WebKitWebDriver stdout:\n${shell.host.stdout.text}\nWebKitWebDriver stderr:\n${shell.host.stderr.text}`);
    }
    failure = { error };
  }
  try {
    await cleanupOwned("native image scenario", [
      async () => {
        if (shell) await closeShell(shell);
      },
      async () => {
        if (fixture) fixture.server.stop(true);
      },
      () => rm(root, { recursive: true, force: true }),
    ]);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure.error, cleanupError], "Native image scenario failed and cleanup also failed.");
    throw cleanupError;
  }
  if (failure) throw failure.error;
}
async function testInitialNativeInput(parent: string, binary: string, busAddress: string, screenshotPath: string, runtimeDir: string): Promise<void> {
  const root = await mkdtemp(join(parent, "first-native-input-"));
  let daemon: TestDaemon | null = null;
  let xvfb: ManagedChild | null = null;
  let shell: Shell | null = null;
  let failure: unknown = null;
  try {
    daemon = await startTestDaemon({ root: join(root, "daemon") });
    const profile = await createProfile(root, "profile", runtimeDir);
    profile.env.DBUS_SESSION_BUS_ADDRESS = busAddress;
    const display = await startXvfb(profile);
    xvfb = display.child;
    configureX11Input(profile, display.display);
    shell = await openShell(profile, daemon.port, binary);
    await waitConnected(shell.driver, daemon.port);
    const beforeSession = await waitFor("the fresh app's automatic first runtime", async () => {
      const current = await runtimes(daemon!.base);
      return current.length === 1 && current[0]!.pid !== null ? current[0] : false;
    });
    const beforeIds = new Set([beforeSession.id]);
    await shell.driver.clickCss("#new-session");
    const runtime = await waitFor("the #new-session button to add one real runtime", async () => {
      const current = await runtimes(daemon!.base);
      const added = current.filter((entry) => !beforeIds.has(entry.id));
      return current.length === 2 && added.length === 1 && added[0]!.pid !== null ? added[0] : false;
    });
    await waitForRuntimePaneReady(shell.driver, daemon.base, runtime.id);
    const textarea = await shell.driver.find("#panes .pane textarea.xterm-helper-textarea");
    await shell.driver.click(await shell.driver.find("#panes .pane"));
    const marker = "native-echo-✓";
    await shell.driver.sendKeys(textarea, `${marker}${PRIVATE_USE_ENTER}`);
    const record = await waitFor("OS-keyboard bytes in the first fake OMP PTY", async () => {
      const bytes = await readRecord(daemon!.root, runtime.id);
      return bytes.length > 0 ? bytes : false;
    });
    assert(record.toString("utf8") === `${marker}\n`,
      `X11 OS-keyboard input did not produce exactly one UTF-8 line: ${JSON.stringify(record.toString("utf8"))}`);
    const output = await waitFor("the first real PTY's exact daemon screen ACK", async () => {
      const value = await screen(daemon!.base, runtime.id);
      return countOccurrences(value, `ACK:${marker}`) === 1 ? value : false;
    });
    assert(countOccurrences(output, `ACK:${marker}`) === 1, "The daemon screen omitted or duplicated the first native ACK.");
    await waitForRenderedTerminalFrame(shell.driver);
    await captureShellScreenshot(shell.driver, screenshotPath);
    console.log(`ok - X11 OS input typed ${marker}; exact PTY bytes and daemon /screen ACK verified; native screenshot captured at ${screenshotPath}`);
    await closeShell(shell);
    shell = null;
    assert(await isProcessAlive(runtime.pid!), "Closing the shell terminated the fixture-owned PTY.");
  } catch (error) {
    if (shell) {
      console.error(`WebKitWebDriver stdout:\n${shell.host.stdout.text}\nWebKitWebDriver stderr:\n${shell.host.stderr.text}`);
    }
    failure = error;
  }
  try {
    await cleanupOwned("focused native keyboard scenario", [
      async () => {
        if (shell) await closeShell(shell);
      },
      async () => {
        if (xvfb) await stopChild(xvfb);
      },
      async () => {
        if (daemon) await daemon.stop();
      },
      () => rm(root, { recursive: true, force: true }),
    ]);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], "Focused native keyboard scenario failed and cleanup also failed.");
    throw cleanupError;
  }
  if (failure) throw failure;
}


async function runNativeSmoke(): Promise<"full" | "images-only" | "policy-only" | "input-only" | "notification-only"> {
  if (process.platform !== "linux") throw new Error("The GTK4/WebKitGTK native smoke is supported only on Linux.");
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const requireGpu = args.includes("--require-gpu");
  const imagesOnly = args.includes("--images-only");
  const policyOnly = args.includes("--policy-only");
  const inputOnly = args.includes("--input-only");
  const notificationOnly = args.includes("--notification-only");
  if ([imagesOnly, policyOnly, inputOnly, notificationOnly].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --images-only, --policy-only, --input-only, or --notification-only.");
  }
  const standalone = imagesOnly || policyOnly || inputOnly || notificationOnly;
  const images = args.includes("--images") || requireGpu || imagesOnly;
  if (!notificationOnly) {
    requireCommand(["WebKitWebDriver", "webkitgtk-driver", "webkitgtk-webdriver", "webkit2gtk-driver"], "WebKitWebDriver");
  }
  if (!standalone) {
    requireCommand(["xclip"], "xclip for the isolated X11 clipboard tests");
  }
  if (!standalone || notificationOnly) {
    requireCommand(["xdotool"], "xdotool for real X11 input and window focus");
    requireCommand(["openbox"], "Openbox for normal-mode window verification");
    requireCommand(["wmctrl"], "wmctrl for WM_DELETE_WINDOW normal-mode close tests");
    requireCommand(["Xvfb"], "Xvfb for isolated native shell scenarios");
    requireCommand(["scrot"], "scrot for screenshots of the actual GTK window");
  }
  if (inputOnly || notificationOnly || policyOnly) {
    requireCommand(["xdotool"], "xdotool for real OS pointer and keyboard input");
    requireCommand(["Xvfb"], "Xvfb for isolated native input");
  }
  requireCommand(["dbus-daemon"], "dbus-daemon for private native fixtures");
  if ((!standalone || notificationOnly) && !await fileExists("/usr/bin/python3") && !Bun.which("python3")) {
    throw new Error("Missing Python 3 with PyGObject for AT-SPI and the private notification-service fixture.");
  }

  const configuredBinary = process.env.OMP_DESKTOP_BINARY;
  const cargoTarget = process.env.CARGO_TARGET_DIR
    ? resolve(ROOT, process.env.CARGO_TARGET_DIR)
    : join(ROOT, "src-tauri", "target");
  const binary = configuredBinary ? resolve(configuredBinary) : join(cargoTarget, "release", "omp-desktop");
  if (!await fileExists(binary)) throw new Error(`Native binary not found at ${binary}; run bun run app:build first.`);

  const scratch = await mkdtemp(join(tmpdir(), "omp-desktop-native-smoke-"));
  const runtimeDir = join(scratch, "xdg-runtime");
  const busHome = join(scratch, "dbus-home");
  let daemon: TestDaemon | null = null;
  let shell: Shell | null = null;
  let normalShell: NormalShell | null = null;
  let normalWindowManager: ManagedChild | null = null;
  let privateBus: ManagedChild | null = null;
  let notification: NotificationService | null = null;
  let inputXvfb: ManagedChild | null = null;
  let inputDisplay: string | null = null;
  const screenshotPath = process.env.OMP_DESKTOP_NATIVE_SCREENSHOT ?? join(tmpdir(), `omp-desktop-native-smoke-${process.pid}.png`);
  let failure: { error: unknown } | null = null;
  const cleanupActions = [
    async () => {
      if (normalShell) await closeNormalShell(normalShell);
    },
    async () => {
      if (normalWindowManager) await stopChild(normalWindowManager);
    },
    async () => {
      if (shell) await closeShell(shell);
    },
    async () => {
      if (inputXvfb) await stopChild(inputXvfb);
    },
    async () => {
      if (notification) await stopChild(notification.child);
    },
    async () => {
      if (privateBus) await stopChild(privateBus);
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    () => rm(scratch, { recursive: true, force: true }),
  ];
  try {
    await Promise.all([
      mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
      mkdir(busHome, { recursive: true, mode: 0o700 }),
    ]);
    const bus = await startPrivateBus(runtimeDir, busHome);
    privateBus = bus.child;
    if (imagesOnly) {
      await testNativeImages(scratch, binary, bus.address, requireGpu, runtimeDir);
      console.log("Native image-only mode did not run functional WebDriver input scenarios.");
    } else if (policyOnly) {
      daemon = await startTestDaemon();
      const profile = await createProfile(scratch, "policy-profile", runtimeDir);
      const openLog = await installExternalOpener(profile);
      profile.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
      const xvfb = await startXvfb(profile);
      inputXvfb = xvfb.child;
      inputDisplay = xvfb.display;
      configureX11Input(profile, xvfb.display);
      shell = await openShell(profile, daemon.port, binary);
      await waitConnected(shell.driver, daemon.port);
      await testNavigationPolicy(shell, daemon, openLog);
      const daemonProcess = daemon.proc;
      await closeShell(shell);
      shell = null;
      assert(daemon.proc === daemonProcess, "Closing the policy-test WebView changed the real fixture daemon process.");
      console.log("ok - native navigation and origin policy observations completed without synthetic pointer/keyboard input");
    } else if (inputOnly) {
      await testInitialNativeInput(scratch, binary, bus.address, screenshotPath, runtimeDir);
    } else if (notificationOnly) {
      notification = await startNotificationService(scratch, bus.address, runtimeDir);
      daemon = await startTestDaemon();
      const profile = await createProfile(scratch, "notification-profile", runtimeDir);
      profile.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
      const xvfb = await startXvfb(profile);
      inputXvfb = xvfb.child;
      inputDisplay = xvfb.display;
      configureX11Input(profile, xvfb.display);
      normalWindowManager = await startOpenbox(profile);
      normalShell = await verifyPersistentNormalProfileAndNotifications(
        profile,
        daemon,
        binary,
        notification,
        null,
        [],
        null,
        screenshotPath,
      );
      const beforeClose = await runtimes(daemon.base);
      await closeNormalShell(normalShell);
      normalShell = null;
      const afterClose = await runtimes(daemon.base);
      assert(JSON.stringify(afterClose.map(({ id, pid }) => [id, pid])) === JSON.stringify(beforeClose.map(({ id, pid }) => [id, pid])),
        "Closing the normal production notification window changed daemon-owned runtime ids or pids.");
      assert(afterClose.every((runtime) => runtime.pid !== null && runtime.alive),
        "Closing the normal production notification window stopped a fixture PTY.");
    } else {
      notification = await startNotificationService(scratch, bus.address, runtimeDir);
      daemon = await startTestDaemon();
      await writeTestTranscript(daemon.root, "native-search-alpha", {
        title: "native search alpha",
        firstPrompt: "fixture-only sidebar search case",
      });
      const profile = await createProfile(scratch, "main-profile", runtimeDir);
      const openLog = await installExternalOpener(profile);
      profile.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
      const xvfb = await startXvfb(profile);
      inputXvfb = xvfb.child;
      inputDisplay = xvfb.display;
      configureX11Input(profile, xvfb.display);
      shell = await openShell(profile, daemon.port, binary);
      const workload = await testFirstSessionAndPaneWorkload(shell, daemon, profile, openLog, screenshotPath, requireGpu);
      shell = null;
      const runtimeSnapshot = await runtimes(daemon.base);
      assert(runtimeSnapshot.every((runtime) => runtime.pid !== null && runtime.alive),
        "An expected live runtime lost its PTY pid before normal profile verification.");
      assert(!runtimeSnapshot.some((runtime) => runtime.id === workload.stoppedRuntimeId),
        "Explicit stop runtime unexpectedly remains in the pool.");

      const normalProfile = await createProfile(scratch, "normal-profile", runtimeDir);
      normalProfile.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
      configureX11Input(normalProfile, inputDisplay!);
      normalWindowManager = await startOpenbox(normalProfile);
      normalShell = await verifyPersistentNormalProfileAndNotifications(
        normalProfile,
        daemon,
        binary,
        notification,
        workload.stoppedRuntimeId,
        workload.runtimeSnapshot,
        workload.savedWorkspaceSignature,
        screenshotPath.replace(/\.png$/i, "-normal.png"),
      );
      const beforeNormalClose = await runtimes(daemon.base);
      await closeNormalShell(normalShell);
      normalShell = null;
      const afterNormalClose = await runtimes(daemon.base);
      assert(JSON.stringify(afterNormalClose.map(({ id, pid }) => [id, pid] as [string, number | null]).sort((a, b) => a[0].localeCompare(b[0]))) ===
        JSON.stringify(beforeNormalClose.map(({ id, pid }) => [id, pid] as [string, number | null]).sort((a, b) => a[0].localeCompare(b[0]))),
      "Closing the normal production GTK shell stopped or replaced daemon-owned runtimes.");
      assert(afterNormalClose.every((runtime) => runtime.pid !== null && runtime.alive),
        "Closing the normal production GTK shell stopped a live daemon PTY.");
      const beforeRestart = await runtimes(daemon.base);
      assert(JSON.stringify(beforeRestart.map(({ id, pid }) => [id, pid]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) ===
        JSON.stringify(workload.runtimeSnapshot),
      "Normal-mode preference/notification behavior changed the live runtime id/pid snapshot.");
      assert(beforeRestart.every((runtime) => runtime.pid !== null && runtime.sessionFile !== null),
        "A live native session has no resumable transcript path.");
      assert(new Set(beforeRestart.map((runtime) => runtime.sessionFile)).size === beforeRestart.length,
        "The live native runtimes did not have distinct transcript identities for post-restart matching.");
      for (const runtime of beforeRestart) {
        assert(await isProcessAlive(runtime.pid!), `Runtime ${runtime.id} died when its shell window closed.`);
        assert(await fileExists(runtime.sessionFile!), `Runtime ${runtime.id} transcript disappeared before daemon restart.`);
      }

      const previousBase = daemon.base;
      const previousPort = daemon.port;
      const previousGeneration = daemon.generation;
      const oldPids = beforeRestart.flatMap((runtime) => runtime.pid === null ? [] : [runtime.pid]);
      await daemon.restart();
      assert(daemon.generation !== previousGeneration, "The daemon restart did not advance its generation.");
      assert(daemon.base !== previousBase && daemon.port !== previousPort, "The daemon replacement did not publish its new test port.");
      try {
        await waitFor("all daemon-owned transcripts to restore under the replacement generation", async () => {
          const current = await runtimes(daemon!.base);
          return current.length === beforeRestart.length && beforeRestart.every((old) => {
            const runtime = current.find((entry) => entry.sessionFile === old.sessionFile);
            return runtime !== undefined && runtime.id !== old.id &&
              runtime.pid !== null && runtime.pid !== old.pid && runtime.alive;
          }) ? current : false;
        }, 30_000);
      } catch (error) {
        const current = await runtimes(daemon.base).catch((currentError) =>
          `GET /api/runtimes failed: ${String(currentError)}`);
        throw new Error(
          `${String(error)}\nBefore restart: ${JSON.stringify(beforeRestart)}\n` +
          `After replacement: ${JSON.stringify(current)}\nDaemon diagnostics:\n${daemon.diagnostics()}`,
        );
      }
      await waitFor("the old fixture PTYs to be reaped during daemon restart", async () => {
        for (const pid of oldPids) if (await isProcessAlive(pid)) return false;
        return true;
      });
      const restored = await runtimes(daemon.base);
      assert(restored.length === beforeRestart.length, "Daemon restart restored a different number of transcripts than were live before restart.");
      for (const runtime of restored) {
        const transcript = await readFile(runtime.sessionFile!, "utf8");
        assert(transcript.includes('"type":"session"'), `Runtime ${runtime.id} did not retain its actual resume transcript.`);
        const commandLine = (await readFile(`/proc/${runtime.pid}/cmdline`)).toString("utf8");
        assert(commandLine.includes("--resume") && commandLine.includes(runtime.sessionFile!),
          `Restored fake OMP ${runtime.id} did not receive its transcript on the replacement process.`);
      }
      console.log("ok - daemon restart changes generation/port, reaps old PTYs, and respawns every saved transcript under a new runtime identity");

      // Use a fresh WebKit profile on the replacement origin to keep daemon transcript recovery separate from origin-local storage.
      const resumedProfile = await createProfile(scratch, "post-restart-profile", runtimeDir);
      resumedProfile.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
      const resumedDaemon = daemon;
      if (!resumedDaemon) throw new Error("The test daemon disappeared before post-restart shell verification.");
      const resumedPort = resumedDaemon.port;
      const resumedShell = await openShell(resumedProfile, resumedPort, binary);
      shell = resumedShell;
      await waitConnected(resumedShell.driver, resumedPort);
      const restoredBinding = await resumedShell.driver.waitFor(async () =>
        (await activePaneBindings(resumedShell.driver, resumedDaemon.base))
          .find((pane) => restored.some((runtime) => runtime.id === pane.runtimeId)) ?? false,
      "fresh-origin shell to bind a displayed pane to a daemon-restored runtime", 30_000);
      const restoredRuntime = restored.find((runtime) => runtime.id === restoredBinding.runtimeId);
      assert(restoredRuntime, "Fresh-origin shell bound a pane to a runtime outside the restored transcript set.");
      await waitForRuntimePaneReady(resumedShell.driver, resumedDaemon.base, restoredRuntime.id);
      await waitFor("fresh-origin pane to receive its resumed fake OMP screen", async () => {
        const value = await screen(resumedDaemon.base, restoredRuntime.id);
        return value.includes("FAKE-OMP READY") ? value : false;
      }, 20_000);
      await waitForRenderedTerminalFrame(resumedShell.driver);
      const restartedScreenshot = `${screenshotPath.replace(/\.png$/i, "")}-restarted.png`;
      await captureShellScreenshot(resumedShell.driver, restartedScreenshot);
      await closeShell(resumedShell);
      shell = null;
      const afterRestartClose = await runtimes(daemon.base);
      assert(JSON.stringify(afterRestartClose.map(({ id, pid }) => [id, pid]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) ===
        JSON.stringify(restored.map(({ id, pid }) => [id, pid]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      "Closing the fresh post-restart shell stopped or replaced restored PTYs.");
      for (const runtime of afterRestartClose) {
        if (runtime.pid !== null) assert(await isProcessAlive(runtime.pid), `Restored runtime ${runtime.id} died when the shell closed.`);
      }

      await testConnectionRetry(scratch, binary, bus.address, inputDisplay!, runtimeDir);
      if (images) await testNativeImages(scratch, binary, bus.address, requireGpu, runtimeDir);
    }
    console.log("Manual coverage reminder: real file-manager DnD and normal desktop-bus notification behavior are separate hardware/user-session checks.");
  } catch (error) {
    if (shell) {
      console.error(`WebKitWebDriver stdout:\n${shell.host.stdout.text}`);
      console.error(`WebKitWebDriver stderr:\n${shell.host.stderr.text}`);
    }
    if (normalShell) {
      console.error(`Normal GTK app stdout:\n${normalShell.app.stdout.text}`);
      console.error(`Normal GTK app stderr:\n${normalShell.app.stderr.text}`);
      console.error(`AT-SPI stderr:\n${normalShell.accessibilityProcess.stderr.text}`);
    }
    failure = { error };
  }
  try {
    await cleanupOwned("native smoke", cleanupActions);
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError([failure.error, cleanupError], "Native smoke failed and cleanup also failed.");
    }
    throw cleanupError;
  }
  if (failure) throw failure.error;
  return imagesOnly ? "images-only" : policyOnly ? "policy-only" : inputOnly ? "input-only" : notificationOnly ? "notification-only" : "full";
}

try {
  const result = await runNativeSmoke();
  console.log(result === "images-only"
    ? "NATIVE IMAGE SMOKE PASSED (functional input scenarios not run)"
    : result === "policy-only"
      ? "NATIVE POLICY SMOKE PASSED (functional input scenarios not run)"
      : result === "input-only"
        ? "NATIVE INPUT SMOKE PASSED (actual X11 OS input and PTY acknowledgement verified)"
        : result === "notification-only"
          ? "NATIVE NORMAL-MODE NOTIFICATION AND PERSISTENCE SMOKE PASSED"
          : "NATIVE SMOKE PASSED");
} catch (error) {
  console.error("NATIVE SMOKE FAILED", error);
  process.exitCode = 1;
}
