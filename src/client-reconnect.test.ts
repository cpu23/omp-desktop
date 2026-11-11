import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./client.ts", import.meta.url)).text();
const start = source.indexOf("  #unlockStartup(): void {");
const end = source.indexOf("  #clearStartup(): void {", start);
if (start < 0 || end < start) throw new Error("renderer readiness methods missing");
const methods = source.slice(start, end);
const code = new Bun.Transpiler({loader:"ts"}).transformSync(`
  class Fixture {
    retry = 5; id = "fixture"; visible = true; ws = { readyState: 1 };
    term = { write(_data, callback) { callback(); }, focus() {} };
    #startupTimer; #rendererReady = false; #startupDiagnostic = true;
    #starting = {hidden:false}; #body = {removeAttribute() {}}; #host = {inert:true};
    #serverReady = false; #replayComplete = false; #writeFencePending = false; #replaying = false;
    ${methods}
    readiness(server, replay, replaying = false) {
      this.#serverReady = server; this.#replayComplete = replay; this.#replaying = replaying;
      this.#maybeFinishStartup(this.ws);
    }
    get ready() { return this.#rendererReady; }
  }
`);

test("reconnect failures reset only after server readiness and rendered replay", () => {
  const pane = new Function("window", "layout", "WebSocket", `${code}; return new Fixture();`)(
    {clearTimeout() {}}, {focused:null}, {OPEN:1},
  );
  pane.readiness(false, true);
  expect(pane.retry).toBe(5);
  expect(pane.ready).toBe(false);
  pane.readiness(true, false);
  expect(pane.retry).toBe(5);
  pane.readiness(true, true, true);
  expect(pane.retry).toBe(5);
  pane.readiness(true, true);
  expect(pane.ready).toBe(true);
  expect(pane.retry).toBe(0);
});
