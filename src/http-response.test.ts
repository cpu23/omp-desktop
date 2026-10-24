import { expect, test } from "bun:test";
import { BodyLimitError, conditionalJson, readLimitedBytes } from "./http-response";

test("conditional polling preserves changed content and revalidates unchanged entities", async () => {
  const request = new Request("http://localhost/api/state");
  const first = conditionalJson(request, { generation: "one", state: { title: "saved" } });
  const tag = first.headers.get("etag")!;
  const unchanged = conditionalJson(new Request(request, { headers: { "if-none-match": `"other", ${tag}` } }), {
    generation: "one", state: { title: "saved" },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  const changed = conditionalJson(new Request(request, { headers: { "if-none-match": tag } }), {
    generation: "two", state: { title: "new" },
  });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ generation: "two", state: { title: "new" } });
});

test("gzip delivery is lossless and explicit refusal overrides wildcard negotiation", async () => {
  const payload = { messages: [{ text: "complete transcript ".repeat(200) }] };
  const gzip = conditionalJson(new Request("http://localhost/api/state", { headers: { "accept-encoding": "gzip" } }), payload);
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer()))))).toEqual(payload);
  const plain = conditionalJson(new Request("http://localhost/api/state", { headers: { "accept-encoding": "gzip;q=0, *;q=1" } }), payload);
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.json()).toEqual(payload);
});

test("streamed request bounds cancel an oversized body without relying on Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  await expect(readLimitedBytes(new Request("http://localhost/input", { method: "POST", body }), 4)).rejects.toBeInstanceOf(BodyLimitError);
  expect(cancelled).toBe(true);
  const exact = new Request("http://localhost/input", { method: "POST", body: "éé" });
  expect(new TextDecoder().decode(await readLimitedBytes(exact, 4))).toBe("éé");
});
