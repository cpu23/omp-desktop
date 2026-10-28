import { spawn } from "node:child_process";
import { resolve } from "node:path";

const action = process.argv[2];
if (action !== "dev" && action !== "build") {
  throw new Error("Usage: bun run scripts/app.ts <dev|build>");
}

const root = resolve(import.meta.dir, "..");
const linux = process.platform === "linux";
const executableName = linux ? "cargo" : "tauri";
const executable = Bun.which(executableName);
if (!executable) {
  throw new Error(linux
    ? "cargo is required to build the Linux GTK4/WebKitGTK 6 shell."
    : "The local @tauri-apps/cli executable is unavailable; run bun install first.");
}

const args = linux
  ? action === "dev"
    ? ["run", "--manifest-path", "src-tauri/Cargo.toml"]
    : ["build", "--manifest-path", "src-tauri/Cargo.toml", "--release", "--locked"]
  : action === "dev"
    ? ["dev"]
    : ["build", "--no-bundle"];

const child = spawn(executable, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
let forwardedSignal: NodeJS.Signals | null = null;
const signals: NodeJS.Signals[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = new Map<NodeJS.Signals, () => void>();
for (const signal of signals) {
  const handler = () => {
    forwardedSignal ??= signal;
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between signal delivery and this handler.
    }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

const { promise, resolve: resolveResult, reject } =
  Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
child.once("error", reject);
child.once("exit", (code, signal) => resolveResult({ code, signal }));
try {
  const result = await promise;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);

  const signal = forwardedSignal ?? result.signal;
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  console.error(error);
  process.exitCode = 1;
}
