import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { IMAGE_FILE_LIMIT } from "./image-limits";
import { isRecord } from "./guards";
import { parseServerMessage } from "./protocol";
import { fakeOmpRecordPath, startTestDaemon, testSessionsRoot, writeTestTranscript } from "../scripts/fixtures/daemon";

type RuntimeInfo = { id: string; alive: boolean; pid: number | null; sessionFile: string | null; cwd: string };

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

describe("real daemon API behavior", () => {
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
          messages.some((entry) => entry.raw instanceof ArrayBuffer),
        "WebSocket hello and replay",
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
      await waitFor(async () => {
        const bytes = await Bun.file(fakeOmpRecordPath(daemon.root, reserved.id)).arrayBuffer().catch(() => null);
        return bytes !== null && Buffer.from(bytes).equals(Buffer.from(data));
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
