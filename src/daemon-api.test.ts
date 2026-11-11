import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect as connectTcp } from "node:net";
import { IMAGE_FILE_LIMIT } from "./image-limits";
import { isRecord } from "./guards";
import { parseServerMessage } from "./protocol";
import { fakeOmpRecordPath, startTestDaemon, testSessionsRoot, writeTestTranscript } from "../scripts/fixtures/daemon";

type RuntimeInfo = { id: string; alive: boolean; pid: number | null; sessionFile: string | null; cwd: string };

function binaryMessagesContain(
  messages: ReadonlyArray<{ raw: string | ArrayBuffer }>,
  marker: string,
): boolean {
  return messages
    .filter((entry) => entry.raw instanceof ArrayBuffer)
    .map((entry) => new TextDecoder().decode(entry.raw as ArrayBuffer))
    .join("")
    .includes(marker);
}

test("readiness markers can span binary WebSocket messages", () => {
  const messages = ["FAKE-OMP RE", "ADY"].map((part) => ({
    raw: new TextEncoder().encode(part).buffer as ArrayBuffer,
  }));
  expect(binaryMessagesContain(messages, "FAKE-OMP READY")).toBe(true);
});

async function createRuntime(base: string, request: Record<string, unknown> = {}): Promise<RuntimeInfo> {
  const response = await fetch(`${base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`POST /api/runtimes -> ${response.status}: ${await response.text()}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.runtime)) throw new Error("bad runtime create payload");
  const value = body.runtime;
  return {
    id: typeof value.id === "string" ? value.id : "",
    alive: value.alive === true,
    pid: typeof value.pid === "number" ? value.pid : null,
    sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
  };
}

async function runtimeList(base: string): Promise<RuntimeInfo[]> {
  const response = await fetch(`${base}/api/runtimes`);
  if (!response.ok) throw new Error(`GET /api/runtimes -> ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.runtimes)) throw new Error("bad runtime list payload");
  return body.runtimes.map((value): RuntimeInfo => {
    const record = isRecord(value) ? value : {};
    return {
      id: typeof record.id === "string" ? record.id : "",
      alive: record.alive === true,
      pid: typeof record.pid === "number" ? record.pid : null,
      sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
      cwd: typeof record.cwd === "string" ? record.cwd : "",
    };
  });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function inputRequest(base: string, runtimeId: string, body: BodyInit): Promise<Response> {
  return fetch(`${base}/api/runtimes/${runtimeId}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  const socket = connectTcp(port, "127.0.0.1");
  try {
    return await new Promise<string>((resolve, reject) => {
      let received = "";
      const timeout = setTimeout(() => reject(new Error("timed out waiting for raw HTTP response")), 5_000);
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.once("connect", () => socket.write(request));
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) {
          clearTimeout(timeout);
          resolve(received);
        }
      });
    });
  } finally {
    socket.destroy();
  }
}

describe("real daemon API behavior", () => {
  test("session request IPC boundary includes the resolved path and attachments", async () => {
    const daemon = await startTestDaemon();
    try {
      const path = await writeTestTranscript(daemon.root, "ipc-boundary");
      const files = [join(daemon.root, 'attachment-"é".txt')];
      const room = 128 * 1024 - Buffer.byteLength(JSON.stringify({ sessionFile: path, text: "", files }));
      const text = "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
      const send = (text: string) => fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, text, files }),
      });
      expect((await send(text + "x")).status).toBe(413);
      expect(await runtimeList(daemon.base)).toEqual([]);
      expect((await send(text)).status).toBe(200);
      const transcript = await Bun.file(path).text();
      expect(transcript).toContain(JSON.stringify(text));
      expect(transcript).not.toContain(JSON.stringify(text + "x"));
    } finally { await daemon.stop(); }
  }, 60_000);

  test("fresh request final envelope rejection is definite and safely retires the draft", async () => {
    const daemon = await startTestDaemon();
    try {
      const text = "x".repeat(128 * 1024 - Buffer.byteLength(JSON.stringify({ sessionFile: "", text: "" })));
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toContain("the request was not sent");
      const runtimes = await runtimeList(daemon.base);
      expect(runtimes.every((runtime) => !runtime.alive)).toBe(true);
      for (const runtime of runtimes) {
        if (runtime.sessionFile) expect(await Bun.file(runtime.sessionFile).text()).not.toContain(text);
      }
    } finally { await daemon.stop(); }
  }, 60_000);

  test("near-limit ASCII session requests reject before starting a runtime", async () => {
    const daemon = await startTestDaemon();
    try {
      const body = JSON.stringify({ text: "x".repeat(128 * 1024 - 11) });
      expect(Buffer.byteLength(body)).toBe(128 * 1024);
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      const message = await response.text();
      const runtimes = await runtimeList(daemon.base);
      expect({ status: response.status, message, runtimes: runtimes.length }).toEqual({
        status: 413, message: "session request exceeds the 128 KiB IPC envelope; the request was not sent", runtimes: 0,
      });
    } finally { await daemon.stop(); }
  }, 60_000);

  test("invalid explicit request directories never fall back to the daemon project", async () => {
    const daemon = await startTestDaemon();
    try {
      const regularFile = join(daemon.root, "not-a-directory.txt");
      await Bun.write(regularFile, "fixture");
      for (const cwd of [join(daemon.root, "missing-directory"), "relative-directory", regularFile, 42, null]) {
        const response = await fetch(`${daemon.base}/api/sessions/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, text: "do not run in another project" }),
        });
        expect(response.status, `invalid cwd ${JSON.stringify(cwd)} must not start a fallback runtime`).toBe(400);
        expect(await runtimeList(daemon.base)).toEqual([]);
      }
    } finally { await daemon.stop(); }
  }, 60_000);

  test("saved history rendering forwards configured OMP arguments as argv, not shell text", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-history-configured-args-"));
    const executable = join(root, "omp with spaces");
    const invocationPath = join(root, "argv.txt");
    await writeFile(executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(invocationPath)}\nprintf 'configured history output\\n'\n`);
    await chmod(executable, 0o700);
    const configuredArgs = ["--fixture-option", "fixed;literal"];
    const daemon = await startTestDaemon({ omp: executable, args: configuredArgs });
    try {
      const transcript = await writeTestTranscript(daemon.root, "configured-history-render-args");
      const response = await fetch(`${daemon.base}/api/sessions/history?path=${encodeURIComponent(transcript)}&cols=80&rows=24`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("configured history output");
      expect((await readFile(invocationPath, "utf8")).trimEnd().split("\n")).toEqual([
        ...configuredArgs, "render", transcript, "--width", "80", "--height", "24",
      ]);
    } finally {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("cross-origin simple prompt submissions are rejected before any runtime or transcript side effect", async () => {
    const daemon = await startTestDaemon();
    const marker = `blocked-cross-origin-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://untrusted.invalid",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ text: marker }),
      });
      let delivered = false;
      if (response.ok) {
        const payload: unknown = await response.json();
        const sessionFile = isRecord(payload) && isRecord(payload.runtime) &&
          typeof payload.runtime.sessionFile === "string" ? payload.runtime.sessionFile : null;
        if (sessionFile) {
          const transcript = await Bun.file(sessionFile).text().catch(() => "");
          delivered = transcript.includes(marker);
        }
      }
      expect(response.status, `cross-origin prompt was accepted; fake transcript side effect=${delivered}`).toBe(403);
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("a DNS-rebound Host cannot authorize its own cross-origin prompt request", async () => {
    const daemon = await startTestDaemon();
    const marker = `rebound-origin-${crypto.randomUUID()}`;
    try {
      const body = JSON.stringify({ text: marker });
      const response = await rawHttpRequest(daemon.port, [
        `POST /api/sessions/request HTTP/1.1`,
        `Host: rebound.invalid:${daemon.port}`,
        `Origin: http://rebound.invalid:${daemon.port}`,
        "Sec-Fetch-Site: same-origin",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
      expect(response).toMatch(/^HTTP\/1\.1 403 /);
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("DNS-rebound GET API requests cannot read sessions or start a reserved runtime", async () => {
    const daemon = await startTestDaemon();
    try {
      const transcript = await writeTestTranscript(daemon.root, "rebound-get-history", {
        title: "private rebound history",
        firstPrompt: "private transcript contents",
      });
      const reserved = await createRuntime(daemon.base);
      const reboundGet = (path: string) => rawHttpRequest(daemon.port, [
        `GET ${path} HTTP/1.1`,
        `Host: rebound.invalid:${daemon.port}`,
        `Origin: http://rebound.invalid:${daemon.port}`,
        "Sec-Fetch-Site: same-origin",
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      const sessions = await reboundGet("/api/sessions");
      const history = await reboundGet(`/api/sessions/history?path=${encodeURIComponent(transcript)}`);
      const screen = await reboundGet(`/api/runtimes/${reserved.id}/screen`);

      const responseStatus = (response: string) => Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      const runtimesAfterRebound = await runtimeList(daemon.base);
      expect({
        sessions: responseStatus(sessions),
        history: responseStatus(history),
        screen: responseStatus(screen),
        runtime: runtimesAfterRebound.find((entry) => entry.id === reserved.id),
      }).toEqual({
        sessions: 403,
        history: 403,
        screen: 403,
        runtime: expect.objectContaining({ alive: false, pid: null }),
      });

      const headerlessRebound = await rawHttpRequest(daemon.port, [
        "GET /api/sessions HTTP/1.1",
        `Host: rebound.invalid:${daemon.port}`,
        "Connection: close", "", "",
      ].join("\r\n"));
      expect(headerlessRebound).toMatch(/^HTTP\/1\.1 403 /);
      const appRead = await fetch(`${daemon.base}/api/sessions`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(appRead.status).toBe(200);
      const localToolRead = await fetch(`${daemon.base}/api/sessions`);
      expect(localToolRead.status).toBe(200);
      const navigationRead = await fetch(`${daemon.base}/api/sessions`, {
        headers: { "sec-fetch-site": "none" },
      });
      expect(navigationRead.status).toBe(200);
      const documentNavigation = await rawHttpRequest(daemon.port, [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${daemon.port}`,
        "Sec-Fetch-Site: none",
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      expect(documentNavigation).toMatch(/^HTTP\/1\.1 200 /);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("same-origin JSON prompt submissions are accepted and recorded by the real fixture endpoint", async () => {
    const daemon = await startTestDaemon();
    const marker = `same-origin-prompt-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(daemon.base).origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ cwd: join(daemon.root, "project"), text: marker }),
      });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      const sessionFile = isRecord(payload) && isRecord(payload.runtime) &&
        typeof payload.runtime.sessionFile === "string" ? payload.runtime.sessionFile : null;
      expect(sessionFile).toBeTruthy();
      const transcript = await Bun.file(sessionFile!).text();
      expect(transcript).toContain(marker);
      expect(await runtimeList(daemon.base)).toHaveLength(1);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("same-origin non-JSON prompt bodies are rejected without starting a runtime", async () => {
    const daemon = await startTestDaemon();
    try {
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ text: "wrong media type" }),
      });
      expect(response.status).toBe(415);
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("cross-origin WebSocket upgrades are rejected before a reserved runtime starts", async () => {
    const daemon = await startTestDaemon();
    let socket: ReturnType<typeof connectTcp> | undefined;
    try {
      const reserved = await createRuntime(daemon.base);
      expect(reserved.alive).toBe(false);
      socket = connectTcp(daemon.port, "127.0.0.1");
      const response = await new Promise<string>((resolve, reject) => {
        let received = "";
        const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket rejection")), 5_000);
        socket!.on("error", (error) => { clearTimeout(timeout); reject(error); });
        socket!.on("connect", () => {
          socket!.write([
            `GET /ws/term?runtime=${encodeURIComponent(reserved.id)} HTTP/1.1`,
            `Host: 127.0.0.1:${daemon.port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "Origin: https://untrusted.invalid",
            "Sec-Fetch-Site: cross-site",
            "\r\n",
          ].join("\r\n"));
        });
        socket!.on("data", (chunk) => {
          received += chunk.toString();
          if (received.includes("\r\n\r\n")) {
            clearTimeout(timeout);
            resolve(received);
          }
        });
      });
      expect(response).toMatch(/^HTTP\/1\.1 403 /);
      const current = await runtimeList(daemon.base);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ id: reserved.id, alive: false, pid: null });
    } finally {
      socket?.destroy();
      await daemon.stop();
    }
  }, 60_000);

  test("non-browser prompt tooling without Origin or Fetch Metadata remains supported", async () => {
    const daemon = await startTestDaemon();
    const marker = `tooling-prompt-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: join(daemon.root, "project"), text: marker }),
      });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      const sessionFile = isRecord(payload) && isRecord(payload.runtime) &&
        typeof payload.runtime.sessionFile === "string" ? payload.runtime.sessionFile : null;
      expect(sessionFile).toBeTruthy();
      expect(await Bun.file(sessionFile!).text()).toContain(marker);
    } finally { await daemon.stop(); }
  }, 60_000);

  test("failed admission never force-stops protected or ambiguously admitted work", async () => {
    for (const ambiguous of [false, true]) {
      const daemon = await startTestDaemon({ env: {
        OMP_DESKTOP_TEST_REJECT_PROMPT: ambiguous ? "unavailable" : "1",
        OMP_DESKTOP_TEST_PROTECT_UNLOAD: "1",
      } });
      try {
        const response = await fetch(`${daemon.base}/api/sessions/request`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: join(daemon.root, "project"), text: "protected request" }),
        });
        expect(response.status).toBe(ambiguous ? 503 : 409);
        const remaining = await runtimeList(daemon.base);
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.alive).toBe(true);
      } finally { await daemon.stop(); }
    }
  }, 60_000);
  test("rejected new requests retire only their unadmitted runtime", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_TEST_REJECT_PROMPT: "1" } });
    try {
      const path = await writeTestTranscript(daemon.root, "existing-rejected-request");
      const existing = await createRuntime(daemon.base, { resume: path });
      for (const request of [{ cwd: join(daemon.root, "project") }, { path }]) {
        const response = await fetch(`${daemon.base}/api/sessions/request`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, text: "rejected before admission" }),
        });
        expect(response.status).toBe(409);
        expect((await runtimeList(daemon.base)).map((runtime) => runtime.id)).toEqual([existing.id]);
      }
    } finally { await daemon.stop(); }
  }, 60_000);
  test("reserves runtimes, starts one PTY on WebSocket attach, and preserves exact input", async () => {
    const daemon = await startTestDaemon();
    let ws: WebSocket | null = null;
    try {
      const reserved = await createRuntime(daemon.base);
      expect(reserved.id).toMatch(/^rt-/);
      expect(reserved.alive).toBe(false);
      expect(reserved.pid).toBeNull();
      expect(await runtimeList(daemon.base)).toHaveLength(1);

      expect((await fetch(`${daemon.base}/api/runtimes/unknown-runtime/screen`)).status).toBe(404);
      expect((await inputRequest(daemon.base, reserved.id, JSON.stringify({ data: "too-early\n" }))).status).toBe(409);
      expect((await inputRequest(daemon.base, "unknown-runtime", JSON.stringify({ data: "x" }))).status).toBe(404);

      const messages: Array<{ raw: string | ArrayBuffer; parsed: ReturnType<typeof parseServerMessage> }> = [];
      ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/term?runtime=${encodeURIComponent(reserved.id)}`);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        const raw = event.data as string | ArrayBuffer;
        messages.push({ raw, parsed: typeof raw === "string" ? parseServerMessage(raw) : null });
      };
      const opened = Promise.withResolvers<void>();
      ws.onopen = () => opened.resolve();
      ws.onerror = () => opened.reject(new Error("runtime WebSocket failed"));
      await opened.promise;
      await waitFor(
        () => messages.some((entry) => entry.parsed?.type === "hello") &&
          binaryMessagesContain(messages, "FAKE-OMP READY"),
        "WebSocket hello and ready marker replay",
      );
      const helloIndex = messages.findIndex((entry) => entry.parsed?.type === "hello");
      const replayIndex = messages.findIndex((entry) => entry.raw instanceof ArrayBuffer);
      expect(helloIndex).toBeGreaterThanOrEqual(0);
      expect(helloIndex).toBeLessThan(replayIndex);
      const replayText = messages
        .filter((entry) => entry.raw instanceof ArrayBuffer)
        .map((entry) => new TextDecoder().decode(entry.raw as ArrayBuffer))
        .join("");
      expect(replayText).toContain("FAKE-OMP READY");
      const attached = (await runtimeList(daemon.base)).find((entry) => entry.id === reserved.id);
      expect(attached?.alive).toBe(true);
      expect(attached?.pid).toEqual(expect.any(Number));
      expect((await inputRequest(daemon.base, reserved.id, "{")).status).toBe(400);
      expect((await inputRequest(daemon.base, reserved.id, new Uint8Array(128 * 1024 + 1))).status).toBe(413);
      expect((await inputRequest(
        daemon.base,
        reserved.id,
        JSON.stringify({ data: "x".repeat(16_385) }),
      )).status).toBe(400);

      const data = "api-byte-check-✓\n";
      expect((await inputRequest(daemon.base, reserved.id, JSON.stringify({ data }))).status).toBe(200);
      await waitFor(async () => {
        const response = await fetch(`${daemon.base}/api/runtimes/${reserved.id}/screen`);
        if (!response.ok) return false;
        const snapshot: unknown = await response.json();
        return isRecord(snapshot) && typeof snapshot.screen === "string" && snapshot.screen.includes("ACK:api-byte-check-✓");
      }, "the exact acknowledged input in the screen snapshot");
      const wsData = "acknowledged-ws-input\n";
      ws.send(JSON.stringify({ type: "input", id: "input-1", data: wsData }));
      await waitFor(
        () => messages.some((entry) => entry.parsed?.type === "inputAck" && entry.parsed.id === "input-1"),
        "accepted WebSocket input acknowledgement",
      );
      await waitFor(async () => {
        const bytes = await Bun.file(fakeOmpRecordPath(daemon.root, reserved.id)).arrayBuffer().catch(() => null);
        return bytes !== null && Buffer.from(bytes).equals(Buffer.from(data + wsData));
      }, "the fake OMP's exact PTY input bytes");
      expect(await runtimeList(daemon.base)).toHaveLength(1);
    } finally {
      ws?.close();
      await daemon.stop();
    }
  }, 60_000);
  test("the deterministic fake OMP exits with its requested status through a real PTY", async () => {
    const daemon = await startTestDaemon();
    let ws: WebSocket | null = null;
    try {
      const transcript = await writeTestTranscript(daemon.root, "exit-status-seven");
      const runtime = await createRuntime(daemon.base, { resume: transcript });
      if (runtime.pid === null) throw new Error("resumed runtime did not start");
      const messages: Array<ReturnType<typeof parseServerMessage>> = [];
      ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/term?runtime=${encodeURIComponent(runtime.id)}`);
      ws.onmessage = (event) => {
        if (typeof event.data === "string") messages.push(parseServerMessage(event.data));
      };
      const opened = Promise.withResolvers<void>();
      ws.onopen = () => opened.resolve();
      ws.onerror = () => opened.reject(new Error("fake OMP exit-status WebSocket failed"));
      await opened.promise;
      await waitFor(() => messages.some((message) => message?.type === "hello"), "the PTY attachment hello");
      expect((await inputRequest(daemon.base, runtime.id, JSON.stringify({ data: "exit 7\n" }))).status).toBe(200);
      await waitFor(
        () => messages.some((message) => message?.type === "exit" && message.exitCode === 7),
        "exit code 7 from the fake terminal process",
      );
      await waitFor(async () => !(await runtimeList(daemon.base)).some((entry) => entry.id === runtime.id), "runtime removal after exit");
      expect(Buffer.from(await Bun.file(fakeOmpRecordPath(daemon.root, runtime.id)).arrayBuffer())).toEqual(Buffer.from("exit 7\n"));
    } finally {
      ws?.close();
      await daemon.stop();
    }
  }, 60_000);


  test("concurrent resume requests join one runtime and invalid transcript paths return 400", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_MAX_RUNTIMES: "2" } });
    try {
      const projectDir = join(daemon.root, "project");
      const title = "Concurrent resume fixture title";
      const valid = await writeTestTranscript(daemon.root, "concurrent-resume", { cwd: projectDir, title });
      const outside = join(daemon.root, "outside.jsonl");
      await Bun.write(outside, "{}\n");
      const missing = join(testSessionsRoot(daemon.root), "-test-fixtures", "missing.jsonl");
      for (const resume of [
        outside,
        missing,
        join(testSessionsRoot(daemon.root), "..", "..", "..", "..", "outside.jsonl"),
      ]) {
        const rejected = await fetch(`${daemon.base}/api/runtimes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resume }),
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain("resume must be an existing session file under the session store");
      }

      const requests = [
        { resume: valid },
        { resume: valid, cwd: daemon.root },
      ];
      const responses = await Promise.all(requests.map((body) => fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const payloads = await Promise.all(responses.map((response) => response.json() as Promise<unknown>));
      const ids = payloads.map((payload) =>
        isRecord(payload) && isRecord(payload.runtime) && typeof payload.runtime.id === "string"
          ? payload.runtime.id
          : null,
      );
      const pids = payloads.map((payload) =>
        isRecord(payload) && isRecord(payload.runtime) && typeof payload.runtime.pid === "number"
          ? payload.runtime.pid
          : null,
      );
      expect(ids[0]).toEqual(expect.any(String));
      expect(ids[1]).toBe(ids[0]);
      const firstPid = pids[0];
      const secondPid = pids[1];
      if (typeof firstPid !== "number" || typeof secondPid !== "number") {
        throw new Error("concurrent resume responses did not include numeric PTY process ids");
      }
      expect(secondPid).toBe(firstPid);
      const current = await runtimeList(daemon.base);
      expect(current).toHaveLength(1);
      expect(current[0]!.sessionFile).toBe(valid);
      expect(current[0]!.alive).toBe(true);
      expect(current[0]!.pid).toEqual(expect.any(Number));
      expect(current[0]!.pid).toBe(pids[0]);
      expect(current[0]!.cwd).toBe(projectDir);
      const indexed = await fetch(`${daemon.base}/api/sessions?limit=5&search=${encodeURIComponent(title)}`);
      expect(indexed.status).toBe(200);
      const indexPayload: unknown = await indexed.json();
      if (!isRecord(indexPayload) || !Array.isArray(indexPayload.sessions)) throw new Error("bad /api/sessions payload");
      const summary = indexPayload.sessions.find((entry) => isRecord(entry) && entry.path === valid);
      expect(isRecord(summary) && summary.title).toBe(title);
      expect(isRecord(summary) && typeof summary.costUsd === "number" && Number.isFinite(summary.costUsd)).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("history and request paths reject session-store symlink escapes without starting an agent", async () => {
    const daemon = await startTestDaemon();
    try {
      const fixture = await writeTestTranscript(daemon.root, "inside-history-root");
      const outside = join(daemon.root, "outside-session.jsonl");
      await Bun.write(outside, '{"type":"session","id":"outside"}\n');
      const escaped = join(testSessionsRoot(daemon.root), "-test-fixtures", "escape.jsonl");
      await symlink(outside, escaped);
      for (const path of [outside, escaped, `${fixture}/not-a-file.jsonl`]) {
        const history = await fetch(`${daemon.base}/api/sessions/history?path=${encodeURIComponent(path)}`);
        expect(history.status).toBe(400);
        const request = await fetch(`${daemon.base}/api/sessions/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, text: "must not execute" }),
        });
        expect(request.status).toBe(400);
      }
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("desktop session titles are renamed, searched, and retained across daemon restart", async () => {
    const daemon = await startTestDaemon();
    try {
      const originalTitle = "Transcript-owned title";
      const transcript = await writeTestTranscript(daemon.root, "custom-title-persistence", { title: originalTitle });
      const transcriptBefore = await Bun.file(transcript).text();
      const outside = join(daemon.root, "outside-title-session.jsonl");
      await Bun.write(outside, "{}\n");
      const missing = join(testSessionsRoot(daemon.root), "-test-fixtures", "missing-title-session.jsonl");
      const invalidPaths = [
        outside,
        missing,
        join(testSessionsRoot(daemon.root), "..", "..", "..", "..", "outside-title-session.jsonl"),
      ];
      for (const path of invalidPaths) {
        const rejected = await fetch(`${daemon.base}/api/sessions/title`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, title: "Rejected title" }),
        });
        expect(rejected.status).toBe(400);
      }
      for (const body of [
        { path: transcript, title: "" },
        { path: transcript, title: " \t\n " },
        { path: transcript, title: "😀".repeat(513) },
        { path: transcript, title: 42 },
        { path: 42, title: "Not a path" },
        null,
      ]) {
        const rejected = await fetch(`${daemon.base}/api/sessions/title`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(rejected.status).toBe(400);
      }

      const rename = async (title: string): Promise<void> => {
        const response = await fetch(`${daemon.base}/api/sessions/title`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: transcript, title }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, path: transcript, title: title.trim() });
      };
      const matchingTitles = async (search: string): Promise<string[]> => {
        const response = await fetch(`${daemon.base}/api/sessions?limit=5&search=${encodeURIComponent(search)}`);
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.sessions)) throw new Error("bad /api/sessions payload");
        return payload.sessions.flatMap((entry) =>
          isRecord(entry) && typeof entry.title === "string" && typeof entry.path === "string"
            ? [entry.path === transcript ? entry.title : ""]
            : [],
        ).filter(Boolean);
      };

      await rename("😀".repeat(512));
      expect(await matchingTitles("😀".repeat(512))).toEqual(["😀".repeat(512)]);
      await rename(`  ${"x".repeat(1024)}  `);
      expect(await matchingTitles("x".repeat(1024))).toEqual(["x".repeat(1024)]);
      const oversized = await fetch(`${daemon.base}/api/sessions/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: transcript, title: "y".repeat(1025) }),
      });
      expect(oversized.status).toBe(400);
      expect(await oversized.text()).toContain("1024");
      expect(await matchingTitles("x".repeat(1024))).toEqual(["x".repeat(1024)]);

      await rename("  First desktop title  ");
      expect(await matchingTitles("First desktop title")).toEqual(["First desktop title"]);
      await rename("  Renamed desktop session  ");
      expect(await matchingTitles("Renamed desktop session")).toEqual(["Renamed desktop session"]);
      expect(await matchingTitles(originalTitle)).toEqual([]);
      expect(await Bun.file(transcript).text()).toBe(transcriptBefore);

      await daemon.restart();
      expect(await matchingTitles("Renamed desktop session")).toEqual(["Renamed desktop session"]);
      expect(await Bun.file(transcript).text()).toBe(transcriptBefore);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("session archives persist without changing transcripts or desktop titles", async () => {
    const daemon = await startTestDaemon();
    try {
      const [firstPath, secondPath] = await Promise.all([
        writeTestTranscript(daemon.root, "archive-api-first", { title: "Archive coverage first" }),
        writeTestTranscript(daemon.root, "archive-api-second", { title: "Archive coverage second" }),
      ]);
      const transcriptBefore = new Map([
        [firstPath, await Bun.file(firstPath).text()],
        [secondPath, await Bun.file(secondPath).text()],
      ]);
      const outside = join(daemon.root, "outside-archive-session.jsonl");
      await Bun.write(outside, "{}\n");
      const missing = join(testSessionsRoot(daemon.root), "-test-fixtures", "missing-archive-session.jsonl");
      for (const path of [
        outside,
        missing,
        join(testSessionsRoot(daemon.root), "..", "..", "..", "..", "outside-archive-session.jsonl"),
      ]) {
        const rejected = await fetch(`${daemon.base}/api/sessions/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        expect(rejected.status).toBe(400);
      }
      for (const body of [{ path: 42 }, { path: "" }, null]) {
        const rejected = await fetch(`${daemon.base}/api/sessions/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(rejected.status).toBe(400);
      }

      const readIndex = async (limit: number): Promise<{ sessions: unknown[]; archivedPaths: unknown[] }> => {
        const response = await fetch(
          `${daemon.base}/api/sessions?limit=${limit}&search=${encodeURIComponent("Archive coverage")}`,
        );
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.sessions) || !Array.isArray(payload.archivedPaths)) {
          throw new Error("bad /api/sessions payload");
        }
        if (!payload.archivedPaths.every((path) => typeof path === "string")) {
          throw new Error("/api/sessions archivedPaths must contain strings");
        }
        return { sessions: payload.sessions, archivedPaths: payload.archivedPaths };
      };
      const initial = await readIndex(10);
      expect(initial.archivedPaths).toEqual([]);
      expect(initial.sessions).toHaveLength(2);
      const first = initial.sessions[0];
      const second = initial.sessions[1];
      if (!isRecord(first) || typeof first.path !== "string" || !isRecord(second) || typeof second.path !== "string") {
        throw new Error("session list omitted transcript paths");
      }
      const archivedPath = first.path;
      const visiblePath = second.path;
      const titled = await fetch(`${daemon.base}/api/sessions/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: archivedPath, title: "  Archive coverage retained title  " }),
      });
      expect(titled.status).toBe(200);
      expect(await titled.json()).toEqual({ ok: true, path: archivedPath, title: "Archive coverage retained title" });
      const titlesBeforeArchive = await Bun.file(join(daemon.root, "state", "session-titles.json")).text();

      const runtime = await createRuntime(daemon.base, { resume: archivedPath });
      if (runtime.pid === null) throw new Error("archive runtime did not start");
      const otherRuntime = await createRuntime(daemon.base, { resume: visiblePath });

      const archiveUrl = `${daemon.base}/api/sessions/archive`;
      const archiveRequest = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: archivedPath }),
      };
      const archived = await fetch(archiveUrl, archiveRequest);
      expect(archived.status).toBe(200);
      expect(await archived.json()).toEqual({ ok: true, path: archivedPath });
      expect((await runtimeList(daemon.base)).map((entry) => entry.id)).toEqual([otherRuntime.id]);
      expect(() => process.kill(runtime.pid!, 0)).toThrow();
      expect((await fetch(archiveUrl, archiveRequest)).status).toBe(200);
      const resumedArchive = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: archivedPath }),
      });
      expect(resumedArchive.status).toBe(400);
      const requestedArchive = await fetch(`${daemon.base}/api/sessions/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: archivedPath, text: "Do not revive an archived conversation" }),
      });
      expect(requestedArchive.status).toBe(400);
      expect((await runtimeList(daemon.base)).map((entry) => entry.id)).toEqual([otherRuntime.id]);

      const afterArchive = await readIndex(1);
      expect(afterArchive.archivedPaths).toContain(archivedPath);
      expect(afterArchive.sessions).toHaveLength(1);
      expect(isRecord(afterArchive.sessions[0]) && afterArchive.sessions[0].path).toBe(visiblePath);
      expect(await Bun.file(join(daemon.root, "state", "session-titles.json")).text()).toBe(titlesBeforeArchive);
      expect(transcriptBefore.get(firstPath)).toBe(await Bun.file(firstPath).text());
      expect(transcriptBefore.get(secondPath)).toBe(await Bun.file(secondPath).text());

      await daemon.restart();
      const afterRestart = await readIndex(1);
      expect((await runtimeList(daemon.base)).some((entry) => entry.sessionFile === archivedPath)).toBe(false);
      expect((await runtimeList(daemon.base)).some((entry) => entry.sessionFile === visiblePath)).toBe(true);
      expect(afterRestart.archivedPaths).toContain(archivedPath);
      expect(afterRestart.sessions).toHaveLength(1);
      expect(isRecord(afterRestart.sessions[0]) && afterRestart.sessions[0].path).toBe(visiblePath);
      expect(await Bun.file(join(daemon.root, "state", "session-titles.json")).text()).toBe(titlesBeforeArchive);
      expect(transcriptBefore.get(firstPath)).toBe(await Bun.file(firstPath).text());
      expect(transcriptBefore.get(secondPath)).toBe(await Bun.file(secondPath).text());
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("archive stops a fresh runtime when its delayed transcript announcement arrives", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_TEST_DEFER_SESSION_FILE: "1" } });
    try {
      const runtime = await createRuntime(daemon.base);
      expect((await fetch(`${daemon.base}/api/runtimes/${runtime.id}/screen`)).status).toBe(200);
      await waitFor(async () => {
        const response = await fetch(`${daemon.base}/api/runtimes/${runtime.id}/screen`);
        const screen: unknown = await response.json();
        return isRecord(screen) && typeof screen.screen === "string" && screen.screen.includes("FAKE-OMP READY");
      }, "fresh runtime ready before transcript announcement");
      const started = (await runtimeList(daemon.base)).find((entry) => entry.id === runtime.id)!;
      expect(started.sessionFile).toBeNull();
      expect(started.pid).toEqual(expect.any(Number));
      const index: unknown = await (await fetch(`${daemon.base}/api/sessions`)).json();
      if (!isRecord(index) || !Array.isArray(index.sessions) || !isRecord(index.sessions[0]) ||
          typeof index.sessions[0].path !== "string") throw new Error("fresh transcript missing from index");
      const path = index.sessions[0].path;
      const before = await Bun.file(path).text();
      const archived = await fetch(`${daemon.base}/api/sessions/archive`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
      });
      expect(archived.status).toBe(200);
      expect((await inputRequest(daemon.base, runtime.id, JSON.stringify({ data: "announce session\n" }))).status).toBe(200);
      await waitFor(async () => !(await runtimeList(daemon.base)).some((entry) => entry.id === runtime.id),
        "late-discovered archived runtime to stop", 2000);
      await waitFor(() => {
        try { process.kill(started.pid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }, "late-discovered archived PTY to be reaped");
      expect(await Bun.file(path).text()).toBe(before);
      await daemon.restart();
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("startup skips archived entries left in a legacy runtime ledger", async () => {
    const daemon = await startTestDaemon();
    try {
      const archivedPath = await writeTestTranscript(daemon.root, "legacy-archived");
      const visiblePath = await writeTestTranscript(daemon.root, "legacy-visible");
      const archived = await fetch(`${daemon.base}/api/sessions/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: archivedPath }),
      });
      expect(archived.status).toBe(200);
      const ledgerFile = join(daemon.root, "state", "sessions.json");
      await Bun.write(ledgerFile, JSON.stringify({
        version: 1,
        sessions: [archivedPath, visiblePath].map((sessionFile) => ({ sessionFile, cwd: join(daemon.root, "project") })),
      }));
      await daemon.restart();
      expect((await runtimeList(daemon.base)).map((runtime) => runtime.sessionFile)).toEqual([visiblePath]);
      await waitFor(async () => {
        const ledger: unknown = await Bun.file(ledgerFile).json();
        return isRecord(ledger) && Array.isArray(ledger.sessions) && ledger.sessions.length === 1 &&
          isRecord(ledger.sessions[0]) && ledger.sessions[0].sessionFile === visiblePath;
      }, "legacy archived entry removed from ledger");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("archive and overlapping resumes leave no hidden runtime", async () => {
    const daemon = await startTestDaemon();
    try {
      for (const [route, archiveFirst] of [
        ["runtimes", false], ["runtimes", true],
        ["sessions/request", false], ["sessions/request", true],
      ] as const) {
        const path = await writeTestTranscript(daemon.root, `overlapping-archive-${route}-${archiveFirst}`);
        const send = (route: string, body: unknown) => fetch(`${daemon.base}/api/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const resumeBody = route === "runtimes" ? { resume: path } : { path, text: "Concurrent explicit request" };
        const requests = archiveFirst
          ? [send("sessions/archive", { path }), send(route, resumeBody)]
          : [send(route, resumeBody), send("sessions/archive", { path })];
        const responses = await Promise.all(requests);
        const archive = responses[archiveFirst ? 0 : 1]!;
        const resume = responses[archiveFirst ? 1 : 0]!;
        expect(archive.status).toBe(200);
        expect(route === "runtimes" ? [200, 400] : [200, 400, 503]).toContain(resume.status);
        expect((await runtimeList(daemon.base)).some((runtime) => runtime.sessionFile === path)).toBe(false);
        // Future resumes must not recreate an invisible process either.
        expect((await send("runtimes", { resume: path })).status).toBe(400);
        expect((await send("sessions/request", { path, text: "Must remain archived" })).status).toBe(400);
      }
      await daemon.restart();
      expect(await runtimeList(daemon.base)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("runtime capacity rejects new transcripts and DELETE stops and reaps the PTY", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_MAX_RUNTIMES: "1" } });
    try {
      const [firstPath, secondPath] = await Promise.all([
        writeTestTranscript(daemon.root, "capacity-resume-first"),
        writeTestTranscript(daemon.root, "capacity-resume-second"),
      ]);
      const first = await createRuntime(daemon.base, { resume: firstPath });
      if (first.pid === null) throw new Error("resumed runtime did not start");
      const full = await fetch(`${daemon.base}/api/runtimes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: secondPath }),
      });
      expect(full.status).toBe(409);
      expect(await full.text()).toContain("session limit reached");

      const deleted = await fetch(`${daemon.base}/api/runtimes/${first.id}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      await waitFor(async () => !(await runtimeList(daemon.base)).some((runtime) => runtime.id === first.id), "runtime removal");
      await waitFor(() => {
        try {
          process.kill(first.pid!, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, "the deleted PTY process to be reaped");
      const deletedAgain = await fetch(`${daemon.base}/api/runtimes/${first.id}`, { method: "DELETE" });
      expect(deletedAgain.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("workspace writes enforce generation and schema and preserve committed state on rejection", async () => {
    const daemon = await startTestDaemon();
    try {
      const document = {
        version: 2,
        savedAt: "2026-10-05T00:00:00.000Z",
        spaces: [{ id: "space-fixture", layout: { tree: { kind: "leaf", pane: "p1" }, panes: { p1: { runtimeId: null } }, focused: "p1" } }],
        activeSpaceId: "space-fixture",
      };
      const currentGeneration = daemon.generation;
      const save = await fetch(`${daemon.base}/api/state`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-OMP-Generation": currentGeneration },
        body: JSON.stringify(document),
      });
      expect(save.status).toBe(200);
      const saved = await save.json();
      expect(isRecord(saved) && saved.ok).toBe(true);
      const getState = async (): Promise<unknown> => {
        const response = await fetch(`${daemon.base}/api/state`);
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        return isRecord(payload) ? payload.state : undefined;
      };
      expect(await getState()).toEqual(document);

      for (const generation of ["stale-generation", null]) {
        const headers = new Headers({ "content-type": "application/json" });
        if (generation !== null) headers.set("X-OMP-Generation", generation);
        const rejected = await fetch(`${daemon.base}/api/state`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...document, savedAt: "2026-10-06T00:00:00.000Z" }),
        });
        expect(rejected.status).toBe(409);
        expect(await getState()).toEqual(document);
      }
      const badSchema = await fetch(`${daemon.base}/api/state`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-OMP-Generation": currentGeneration },
        body: JSON.stringify({ version: 8, savedAt: "2026-10-05T00:00:00.000Z" }),
      });
      expect(badSchema.status).toBe(400);
      expect(await getState()).toEqual(document);
      const oversized = await fetch(`${daemon.base}/api/state`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-OMP-Generation": currentGeneration },
        body: JSON.stringify({ ...document, note: "x".repeat(1024 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      expect(await getState()).toEqual(document);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("PNG paste stores the uploaded bytes and reports type, size, and aggregate quota failures", async () => {
    const daemon = await startTestDaemon({ env: { OMP_DESKTOP_PASTE_BUDGET_BYTES: String(IMAGE_FILE_LIMIT) } });
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x7f, 0xff, 0x10]);
      const uploaded = await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png,
      });
      expect(uploaded.status).toBe(200);
      const result: unknown = await uploaded.json();
      if (!isRecord(result) || typeof result.path !== "string") throw new Error("paste did not return an uploaded path");
      expect(Buffer.from(await Bun.file(result.path).arrayBuffer())).toEqual(Buffer.from(png));

      expect((await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not an image",
      })).status).toBe(415);
      expect((await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(0),
      })).status).toBe(400);

      const fillsBudget = await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(IMAGE_FILE_LIMIT - png.byteLength),
      });
      if (fillsBudget.status !== 200) {
        throw new Error(`upload at the aggregate byte limit returned ${fillsBudget.status}: ${await fillsBudget.text()}`);
      }
      const aggregateOver = await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array([1]),
      });
      expect(aggregateOver.status).toBe(507);
      expect((await fetch(`${daemon.base}/api/paste`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(IMAGE_FILE_LIMIT + 1),
      })).status).toBe(413);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("root assets serve their referenced JS, CSS, and fonts with ETag, HEAD, and method semantics", async () => {
    const daemon = await startTestDaemon();
    try {
      const root = await fetch(`${daemon.base}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type")).toContain("text/html");
      const html = await root.text();
      const references = [...html.matchAll(/(?:href|src)=["'](\/[^"']+)["']/g)].map((match) => match[1]!);
      const cssPaths = references.filter((path) => /\.css(?:\?|$)/.test(path));
      const jsPaths = references.filter((path) => /\.js(?:\?|$)/.test(path));
      expect(cssPaths.length).toBeGreaterThan(0);
      expect(jsPaths.length).toBeGreaterThan(0);

      const assetResponses = new Map<string, Response>();
      for (const path of [...cssPaths, ...jsPaths]) {
        const response = await fetch(new URL(path, daemon.base), { headers: { "accept-encoding": "identity" } });
        expect(response.status).toBe(200);
        const bytes = await response.arrayBuffer();
        expect(bytes.byteLength).toBeGreaterThan(0);
        expect(response.headers.get("content-type")).toContain(path.endsWith(".js") ? "javascript" : "text/css");
        assetResponses.set(path, new Response(bytes, { headers: response.headers }));
      }
      let fontPaths: string[] = [];
      for (const path of cssPaths) {
        const text = await (await assetResponses.get(path)!.clone()).text();
        fontPaths.push(...[...text.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf)(?:\?[^"')]*)?)["']?\)/gi)]
          .map((match) => new URL(match[1]!, new URL(path, daemon.base)).pathname));
      }
      fontPaths = [...new Set(fontPaths)];
      expect(fontPaths.length).toBeGreaterThan(0);
      for (const path of fontPaths) {
        const response = await fetch(`${daemon.base}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("font/");
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }

      const jsPath = jsPaths[0]!;
      const js = assetResponses.get(jsPath)!;
      const etag = js.headers.get("etag");
      expect(etag).toBeTruthy();
      expect((await fetch(`${daemon.base}${jsPath}`, {
        headers: { "accept-encoding": "identity", "if-none-match": etag! },
      })).status).toBe(304);
      const head = await fetch(`${daemon.base}${jsPath}`, { method: "HEAD", headers: { "accept-encoding": "identity" } });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-length")).toBe(String((await js.clone().arrayBuffer()).byteLength));
      expect((await fetch(`${daemon.base}/missing-asset.js`)).status).toBe(404);
      expect((await fetch(`${daemon.base}/`, { method: "POST" })).status).toBe(405);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
