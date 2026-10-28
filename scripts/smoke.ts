import { isRecord } from "../src/guards";
import { parseServerMessage } from "../src/protocol";
import { startTestDaemon, writeTestTranscript } from "./fixtures/daemon";

const requestedOmp = process.env.OMP_DESKTOP_OMP ?? "omp";
const omp = Bun.which(requestedOmp) ?? requestedOmp;
const args = (process.env.OMP_DESKTOP_OMP_ARGS ?? "").split(" ").filter((part) => part.length > 0);
const daemon = await startTestDaemon({ omp, args });

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runtimeList(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${daemon.base}/api/runtimes`);
  if (!response.ok) throw new Error(`GET /api/runtimes -> ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.runtimes)) throw new Error("bad /api/runtimes response");
  return payload.runtimes.filter(isRecord);
}

try {
  const cwd = `${daemon.root}/project`;
  const created = await fetch(`${daemon.base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!created.ok) throw new Error(`could not reserve a real OMP runtime: ${created.status} ${await created.text()}`);
  const createdBody: unknown = await created.json();
  if (!isRecord(createdBody) || !isRecord(createdBody.runtime)) throw new Error("bad create-runtime response");
  const runtimeId = typeof createdBody.runtime.id === "string" ? createdBody.runtime.id : "";
  if (!runtimeId) throw new Error("new runtime id is missing");
  if (createdBody.runtime.pid !== null) throw new Error("new runtime spawned before a pane attached");
  console.log("ok - real OMP runtime is reserved without a PTY");

  const messages: Array<string | ArrayBuffer> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/term?runtime=${encodeURIComponent(runtimeId)}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (event) => messages.push(event.data as string | ArrayBuffer);
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error("WebSocket attachment to real OMP failed"));
  await opened.promise;
  await waitFor(async () => {
    const runtime = (await runtimeList()).find((entry) => entry.id === runtimeId);
    return runtime?.alive === true && typeof runtime.pid === "number" &&
      typeof runtime.sessionFile === "string" && runtime.sessionFile.endsWith(".jsonl");
  }, "real OMP startup and its OSC 1337 transcript announcement");
  await waitFor(
    () => messages.some((message) => typeof message === "string" && parseServerMessage(message)?.type === "hello") &&
      messages.some((message) => message instanceof ArrayBuffer),
    "the real terminal's hello and output stream",
  );
  const first = (await runtimeList()).find((entry) => entry.id === runtimeId);
  if (!first) throw new Error("real OMP runtime disappeared after attach");
  const firstPid = first.pid;
  const firstSessionFile = first.sessionFile;
  if (typeof firstPid !== "number" || typeof firstSessionFile !== "string") {
    throw new Error("real OMP runtime was not alive with a transcript after attach");
  }
  const screenResponse = await fetch(`${daemon.base}/api/runtimes/${runtimeId}/screen`);
  if (!screenResponse.ok) throw new Error(`GET /screen -> ${screenResponse.status}`);
  const screen: unknown = await screenResponse.json();
  if (!isRecord(screen) || typeof screen.screen !== "string" || screen.screen.trim().length === 0) {
    throw new Error("real OMP did not paint terminal content through the daemon");
  }
  console.log(`ok - real OMP pid ${firstPid} announced ${firstSessionFile} over OSC 1337 and rendered terminal output`);
  ws.close();

  const resumeTranscript = await writeTestTranscript(daemon.root, "real-omp-resume", { cwd });
  const resumeResponse = await fetch(`${daemon.base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: resumeTranscript }),
  });
  if (!resumeResponse.ok) {
    throw new Error(`could not start real OMP from fixture transcript: ${resumeResponse.status} ${await resumeResponse.text()}`);
  }
  const resumePayload: unknown = await resumeResponse.json();
  if (!isRecord(resumePayload) || !isRecord(resumePayload.runtime)) {
    throw new Error("real OMP resume request returned an invalid runtime");
  }
  const resumedId = resumePayload.runtime.id;
  const resumedPid = resumePayload.runtime.pid;
  if (
    typeof resumedId !== "string" || typeof resumedPid !== "number" ||
    resumePayload.runtime.sessionFile !== resumeTranscript
  ) throw new Error("real OMP did not start the requested transcript");

  const resumeMessages: Array<string | ArrayBuffer> = [];
  const resumeWs = new WebSocket(
    `ws://127.0.0.1:${daemon.port}/ws/term?runtime=${encodeURIComponent(resumedId)}`,
  );
  resumeWs.binaryType = "arraybuffer";
  resumeWs.onmessage = (event) => resumeMessages.push(event.data as string | ArrayBuffer);
  const resumeOpened = Promise.withResolvers<void>();
  resumeWs.onopen = () => resumeOpened.resolve();
  resumeWs.onerror = () => resumeOpened.reject(new Error("WebSocket attachment to resumed OMP failed"));
  await resumeOpened.promise;
  await waitFor(
    () => resumeMessages.some((message) => typeof message === "string" && parseServerMessage(message)?.type === "hello") &&
      resumeMessages.some((message) => message instanceof ArrayBuffer),
    "the resumed real OMP terminal's hello and output stream",
  );
  const resumeScreenResponse = await fetch(`${daemon.base}/api/runtimes/${resumedId}/screen`);
  if (!resumeScreenResponse.ok) throw new Error(`resumed GET /screen -> ${resumeScreenResponse.status}`);
  const resumeScreen: unknown = await resumeScreenResponse.json();
  if (!isRecord(resumeScreen) || typeof resumeScreen.screen !== "string") {
    throw new Error("real OMP returned an invalid resumed screen snapshot");
  }
  console.log(`ok - real OMP resumed fixture transcript ${resumeTranscript} with pid ${resumedPid}`);

  resumeWs.close();
  await daemon.restart();
  try {
    await waitFor(
      async () => (await runtimeList()).some((entry) => entry.sessionFile === resumeTranscript),
      "the real OMP transcript to return after daemon restart",
    );
  } catch (error) {
    const current = await runtimeList().catch((failure) => String(failure));
    const transcript = await Bun.file(resumeTranscript).text().catch((failure) => `unreadable: ${String(failure)}`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `runtime list: ${JSON.stringify(current)}\n` +
        `transcript: ${transcript}\n${daemon.diagnostics()}`,
    );
  }
  const restored = (await runtimeList()).find((entry) => entry.sessionFile === resumeTranscript);
  if (!restored || restored.alive !== true || typeof restored.pid !== "number") {
    throw new Error("the real OMP transcript was not resumed after daemon restart");
  }
  if (restored.pid === resumedPid) throw new Error("daemon restart reused the previous PTY process");
  const restoredScreenResponse = await fetch(`${daemon.base}/api/runtimes/${String(restored.id)}/screen`);
  if (!restoredScreenResponse.ok) throw new Error(`restored GET /screen -> ${restoredScreenResponse.status}`);
  const restoredSnapshot: unknown = await restoredScreenResponse.json();
  if (!isRecord(restoredSnapshot) || typeof restoredSnapshot.screen !== "string") {
    throw new Error("real OMP returned an invalid screen after daemon restart");
  }
  console.log(`ok - daemon restart resumed ${resumeTranscript} as a new live PTY (${restored.pid})`);
  console.log("SMOKE PASSED");
} finally {
  await daemon.stop();
}
