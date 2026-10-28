import { isRecord } from "../src/guards";
import { startTestDaemon } from "./fixtures/daemon";

const daemon = await startTestDaemon();
try {
  const response = await fetch(`${daemon.base}/api/runtimes`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`/api/runtimes returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.runtimes) || payload.runtimes.length !== 0) {
    throw new Error("Fresh daemon /api/runtimes did not return an empty runtime list.");
  }
  console.log(`ok - isolated real daemon responds at ${daemon.base} with generation ${daemon.generation}`);
  console.log("DAEMON SMOKE PASSED");
} finally {
  await daemon.stop();
}
