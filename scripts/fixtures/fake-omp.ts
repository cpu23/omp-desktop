#!/usr/bin/env bun
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/guards";

const args = process.argv.slice(2);

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

// The deterministic harness has the same standalone offline-render entry point
// as OMP; this path never creates a runtime socket or touches the PTY record.
if (args[0] === "render") {
  if (!args[1]) throw new Error("render requires a fixture transcript");
  for (const line of readFileSync(args[1], "utf8").split("\n")) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    process.stdout.write(`\x1b[1m${role === "user" ? "User" : "Assistant"}\x1b[0m\r\n${messageText(entry.message.content).replace(/\r?\n/g, "\r\n")}\r\n\r\n`);
  }
  process.exit(0);
}

const FIXED_TIMESTAMP = "2026-10-05T00:00:00.000Z";
const runtimeId = process.env.OMP_DESKTOP_RUNTIME ?? "rt-fixture";
const recordDir = process.env.OMP_DESKTOP_TEST_RECORD_DIR;
const recordFile = recordDir ? join(recordDir, `${runtimeId}.bin`) : null;
const sessionsDir = process.env.OMP_DESKTOP_SESSIONS_DIR;
let transcript = "";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--resume" && args[index + 1]) {
    transcript = args[index + 1]!;
    break;
  }
}

if (!transcript && sessionsDir) {
  const sessionId = runtimeId.replace(/^rt-/, "");
  const directory = join(sessionsDir, process.cwd().replaceAll("/", "-"));
  transcript = join(directory, `${FIXED_TIMESTAMP.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "session",
          version: 2,
          id: sessionId,
          timestamp: FIXED_TIMESTAMP,
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: `u-${FIXED_TIMESTAMP}`,
          parentId: null,
          timestamp: FIXED_TIMESTAMP,
          message: { role: "user", content: "deterministic fake OMP fixture" },
        }),
        JSON.stringify({ type: "title", v: 1, title: "fake OMP fixture", updatedAt: FIXED_TIMESTAMP }),
      ].join("\n") + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

if (recordDir) mkdirSync(recordDir, { recursive: true, mode: 0o700 });

function announceSessionFile(): void {
  if (!transcript) return;
  const encodedPath = Buffer.from(transcript, "utf8").toString("base64");
  process.stdout.write(`\x1b]1337;SetUserVar=omp_session_file=${encodedPath}\x07`);
}
if (process.env.OMP_DESKTOP_TEST_DEFER_SESSION_FILE !== "1") announceSessionFile();
const startupGate = process.env.OMP_DESKTOP_TEST_STARTUP_GATE;
const cleanupHold = process.env.OMP_DESKTOP_TEST_CLEANUP_HOLD_UNLOAD;
const cleanupPrecheckHold = process.env.OMP_DESKTOP_TEST_CLEANUP_PRECHECK_HOLD;
const cleanupPrecheckMarker = process.env.OMP_DESKTOP_TEST_CLEANUP_PRECHECK_MARKER;
const pidMarker = process.env.OMP_DESKTOP_TEST_PID_MARKER;
if (pidMarker) writeFileSync(pidMarker, String(process.pid));
if (process.env.OMP_DESKTOP_TEST_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    const marker = process.env.OMP_DESKTOP_TEST_SIGTERM_MARKER;
    if (marker) writeFileSync(marker, "received");
  });
}
// OMP reads terminal negotiation replies in raw mode during startup.
if (startupGate) process.stdin.setRawMode?.(true);

let idleSince = Date.now();
let unloading = process.env.OMP_DESKTOP_TEST_START_UNLOADING === "1";
let idleStatusUnavailable = false;
let idleStatusRequests = 0;
let revision = 0;
const idleDir = process.env.OMP_DESKTOP_IDLE_IPC_DIR;
const idleToken = process.env.OMP_DESKTOP_IDLE_IPC_TOKEN;
if (idleDir && idleToken) {
  mkdirSync(idleDir, { recursive: true, mode: 0o700 });
  const socket = join(idleDir, `${runtimeId}.sock`);
  const idleServer = Bun.serve({
    unix: socket,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${idleToken}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/status") {
        idleStatusRequests += 1;
        if (unloading && idleStatusRequests > 1 && cleanupPrecheckHold) {
          if (cleanupPrecheckMarker) writeFileSync(cleanupPrecheckMarker, "attempted");
          while (existsSync(cleanupPrecheckHold)) await Bun.sleep(10);
        }
        if (idleStatusUnavailable) {
          return Response.json({ kind: "unavailable", reason: "fixture status unavailable" }, { status: 503 });
        }
        return Response.json({
          hostId: `fixture-${process.pid}`, sessionId: runtimeId, sessionFile: transcript || null,
          idleSince: unloading ? null : idleSince, reasons: unloading ? ["unloading"] : [],
          revision, unloading,
        });
      }
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || body.sessionFile !== transcript || unloading) {
        return Response.json({ kind: "conflict", reason: "session changed or unloading" }, { status: 409 });
      }
      if (request.method === "POST" && path === "/prompt") {
        if (process.env.OMP_DESKTOP_TEST_REJECT_PROMPT === "unavailable") {
          return Response.json({ kind: "unavailable", reason: "fixture acknowledgement unavailable" }, { status: 503 });
        }
        if (process.env.OMP_DESKTOP_TEST_REJECT_PROMPT === "1") {
          return Response.json({ kind: "conflict", reason: "fixture rejected request before admission" }, { status: 409 });
        }
        if (typeof body.text !== "string" || !body.text.trim()) return new Response("empty request", { status: 400 });
        const timestamp = new Date().toISOString();
        const userId = crypto.randomUUID();
        const assistantId = crypto.randomUUID();
        let parentId: string | null = null;
        for (const line of readFileSync(transcript, "utf8").split("\n")) {
          try {
            const entry: unknown = JSON.parse(line);
            if (isRecord(entry) && entry.type === "message" && typeof entry.id === "string") parentId = entry.id;
          } catch {}
        }
        appendFileSync(transcript, [
          { type: "message", id: userId, parentId, timestamp, message: { role: "user", content: body.text } },
          { type: "message", id: assistantId, parentId: userId, timestamp, message: { role: "assistant", content: `ACK:${body.text}` } },
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
        idleSince = Date.now();
        revision += 1;
        process.stdout.write(`ACK:${body.text}\r\n`);
        return Response.json({ kind: "accepted" }, { status: 202 });
      }
      if (request.method === "POST" && path === "/unload") {
        if (process.env.OMP_DESKTOP_TEST_CLEANUP_STATUS_UNAVAILABLE === "1") {
          if (startupGate) writeFileSync(`${startupGate}.unload-attempted`, "attempted");
          while (cleanupHold && existsSync(cleanupHold)) await Bun.sleep(10);
          idleStatusUnavailable = true;
          return Response.json({ kind: "unavailable", reason: "fixture unload acknowledgement lost" }, { status: 503 });
        }
        if (process.env.OMP_DESKTOP_TEST_PROTECT_UNLOAD === "1") {
          return Response.json({ kind: "conflict", reason: "fixture active work" }, { status: 409 });
        }
        if (typeof body.idleTimeoutMs !== "number" || body.idleTimeoutMs <= 0 ||
            Date.now() - idleSince < body.idleTimeoutMs) {
          return Response.json({ kind: "conflict", reason: "not idle long enough" }, { status: 409 });
        }
        unloading = true;
        setTimeout(() => process.exit(0), 25);
        return Response.json({ kind: "accepted" }, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  chmodSync(socket, 0o600);
  if (startupGate) writeFileSync(`${startupGate}.online`, "idle IPC listening");
  process.on("exit", () => {
    idleServer.stop(true);
    try { unlinkSync(socket); } catch {}
  });
}

let pending = "";
const decoder = new TextDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  idleSince = Date.now();
  revision += 1;
  if (recordFile) appendFileSync(recordFile, chunk);
  pending += decoder.decode(chunk, { stream: true });
  for (;;) {
    const lineEnd = pending.search(/[\r\n]/);
    if (lineEnd < 0) break;
    const line = pending.slice(0, lineEnd);
    let consume = lineEnd + 1;
    if (pending[lineEnd] === "\r" && pending[lineEnd + 1] === "\n") consume += 1;
    pending = pending.slice(consume);
    if (line === "announce session") announceSessionFile();
    if (line === "exit 7") {
      process.exit(7);
      return;
    }
    if (line === "exit 0") {
      process.exit(0);
      return;
    }
    process.stdout.write(`ACK:${line}\r\n`);
  }
});

process.stdin.resume();

const startupMode = process.env.OMP_DESKTOP_TEST_STARTUP_MODE;
if (startupMode === "no-frame") {
  await new Promise<void>(() => {});
} else {
  while (startupGate && existsSync(startupGate)) await Bun.sleep(10);
  if (startupGate) process.stdin.setRawMode?.(false);
  process.stdout.write("\x1b[2JFAKE-OMP READY\r\n");
}
