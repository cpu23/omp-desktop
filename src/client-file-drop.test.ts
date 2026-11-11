import { expect, test } from "bun:test";
import { insertFilePaths, type FileDropOptions } from "./file-drop";

const source = await Bun.file(new URL("./client.ts", import.meta.url)).text();
const end = source.indexOf("// xterm stops paste propagation");
const start = source.lastIndexOf("    this.#wireDrop();", end) + "    this.#wireDrop();".length;
if (end < 0 || start < 20) throw new Error("pane file-drop wiring not found");
const snippet = source.slice(start, end);
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`
  class Fixture {
    el = { append(element) { appendStatus(element); } }; binding = { runtimeId: "rt-starting" };
    #inputReady = false; #disposeFileDrop;
    #sendOrStageInput() { return false; }
    constructor() { ${snippet} }
  }
`);
function fixture(saveError: boolean) {
  let options!: FileDropOptions;
  const warnings: Array<[string, string]> = [];
  const statuses: Array<{ textContent: string; hidden: boolean }> = [];
  let uploads = 0;
  new Function("wireFileDrop", "insertFilePaths", "uploadPaste", "setStatus", "document", "appendStatus", `${code}; new Fixture();`)(
    (_el: unknown, value: FileDropOptions) => { options = value; return () => {}; },
    insertFilePaths,
    async () => { uploads++; return "/fixture/upload.png"; },
    (message: string, kind: string) => { if (!saveError) warnings.push([message, kind]); },
    { createElement: () => ({ textContent: "", hidden: false, setAttribute() {} }) },
    (element: { textContent: string; hidden: boolean }) => statuses.push(element),
  );
  return { options, warnings, statuses, uploads: () => uploads };
}

test("starting-pane file drops give retry feedback without sending or uploading", async () => {
  const f = fixture(false);
  f.options.onPaths(["/fixture/dropped.txt"]);
  expect(f.warnings).toHaveLength(1);
  expect(f.warnings[0]![0]).toMatch(/drop.*again/i);
  expect(f.warnings[0]![1]).toBe("warn");
  expect(await f.options.upload(new File(["image"], "image.png", { type: "image/png" }))).toBeNull();
  expect(f.warnings).toHaveLength(2);
  expect(f.uploads()).toBe(0);
});

test("a pinned save error cannot hide the pane's rejected-drop feedback", async () => {
  const f = fixture(true);
  f.options.onPaths(["/fixture/dropped.txt"]);
  expect(f.statuses[0]?.textContent ?? "").toMatch(/drop.*again/i);
  expect(f.statuses[0]?.hidden).toBe(false);
  expect(await f.options.upload(new File(["image"], "image.png", { type: "image/png" }))).toBeNull();
  expect(f.statuses[0]?.textContent ?? "").toMatch(/drop.*again/i);
  expect(f.warnings).toHaveLength(0);
  expect(f.uploads()).toBe(0);
});
