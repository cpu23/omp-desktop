import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXED_TIMESTAMP = "2026-10-05T00:00:00.000Z";
const runtimeId = process.env.OMP_DESKTOP_RUNTIME ?? "rt-fixture";
const recordDir = process.env.OMP_DESKTOP_TEST_RECORD_DIR;
const recordFile = recordDir ? join(recordDir, `${runtimeId}.bin`) : null;
const sessionsDir = process.env.OMP_DESKTOP_SESSIONS_DIR;
const args = process.argv.slice(2);
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

if (transcript) {
  const encodedPath = Buffer.from(transcript, "utf8").toString("base64");
  process.stdout.write(`\x1b]1337;SetUserVar=omp_session_file=${encodedPath}\x07`);
}
process.stdout.write("FAKE-OMP READY\r\n");

let pending = "";
const decoder = new TextDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  if (recordFile) appendFileSync(recordFile, chunk);
  pending += decoder.decode(chunk, { stream: true });
  for (;;) {
    const lineEnd = pending.search(/[\r\n]/);
    if (lineEnd < 0) break;
    const line = pending.slice(0, lineEnd);
    let consume = lineEnd + 1;
    if (pending[lineEnd] === "\r" && pending[lineEnd + 1] === "\n") consume += 1;
    pending = pending.slice(consume);
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
