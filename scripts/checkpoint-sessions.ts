/** One-time upgrade bridge for a running daemon that predates sessions.json.
 * Snapshot its actual live pool before an operator restarts the service. This
 * command never stops processes; do not restart until current work is finished.
 */
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { parseRuntimesResponse } from "../src/protocol";
import { RuntimeLedgerStore, type LiveSession } from "../src/state";

const port = Number(process.env.OMP_DESKTOP_PORT ?? 4180);
const base = `http://127.0.0.1:${port}`;
async function get(path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const payload = parseRuntimesResponse(await get("/api/runtimes"));
if (!payload) throw new Error("Daemon returned an invalid runtime list; checkpoint not written");
const state = await get("/api/state");
if (!state || typeof state !== "object" || !("path" in state) || typeof state.path !== "string") {
  throw new Error("Daemon did not report its workspace state path; checkpoint not written");
}
const sessions: LiveSession[] = [];
for (const runtime of payload.runtimes) {
  if (!runtime.alive) continue;
  if (!runtime.sessionFile || !(await stat(runtime.sessionFile).catch(() => null))?.isFile()) {
    throw new Error(`Live runtime ${runtime.id} has no saved transcript; checkpoint not written`);
  }
  sessions.push({ sessionFile: runtime.sessionFile, cwd: runtime.cwd, cols: runtime.cols, rows: runtime.rows });
}
const path = process.env.OMP_DESKTOP_LEDGER_FILE ?? join(
  process.env.OMP_DESKTOP_STATE_DIR ?? dirname(state.path), "sessions.json",
);
await new RuntimeLedgerStore(path).save(sessions);
console.log(`Checkpointed ${sessions.length} live session(s) to ${path}`);
console.log("No processes stopped. Restart the daemon only after current work finishes.");
