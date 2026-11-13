/** Asynchronous initial restore through real UI events, locks and daemon restarts. */
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import type { TestDaemon } from "./fixtures/daemon";

const KEY = "omp-desktop.sidebar.v1";
type Sidebar = { width: number; view: string; workspaces: string[]; activeWorkspace: string | null; collapsedWorkspaces: string[]; archivedWorkspaces: string[] };
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error(`timed out: ${label}`);
}
const local = (page: Page): Promise<Sidebar | null> => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), KEY);
async function seed(daemon: TestDaemon, archives: string[]): Promise<void> {
  const sidebar: Sidebar = { width: 410, view: "sessions", workspaces: archives, activeWorkspace: null, collapsedWorkspaces: archives, archivedWorkspaces: archives };
  const response = await fetch(`${daemon.base}/api/state`, {
    method: "PUT", headers: { "content-type": "application/json", "X-OMP-Generation": daemon.generation },
    body: JSON.stringify({ version: 2, savedAt: new Date().toISOString(), sidebar: JSON.stringify(sidebar), pins: [], layout: null }),
  });
  assert.equal(response.ok, true, await response.text());
}
async function remote(daemon: TestDaemon): Promise<Sidebar> {
  return JSON.parse((await (await fetch(`${daemon.base}/api/state`)).json()).state.sidebar);
}
async function lock(page: Page): Promise<void> {
  await page.evaluate((key) => { void navigator.locks.request(key, () => new Promise<void>((resolve) => { window.releaseSidebarLock = resolve; })); }, KEY);
  await until(() => page.evaluate(() => !!window.releaseSidebarLock), "held sidebar lock");
}
async function queued(page: Page): Promise<void> {
  await until(() => page.evaluate(async (key) => !!(await navigator.locks.query()).pending?.some((entry) => entry.name === key), KEY), "queued restoration");
}
async function settle(page: Page, daemon: TestDaemon): Promise<void> {
  await page.evaluate(async (key) => { await navigator.locks.request(key, () => {}); }, KEY);
  await until(async () => JSON.stringify(await local(page)) === JSON.stringify(await remote(daemon)), "restored daemon mirror");
}

async function addLocal(page: Page, path: string): Promise<void> {
  await page.evaluate((path) => { window.__OMP_SELECT_WORKSPACE_DIRECTORY__ = async () => path; }, path);
  await page.locator("#add-workspace").click();
  await page.getByRole("button", { name: `Workspace actions for ${path.split("/").pop()}`, exact: true }).waitFor();
}
async function archiveLocal(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name: `Workspace actions for ${name}`, exact: true });
  const box = await button.boundingBox();
  assert.ok(box, `Workspace actions for ${name} must have a bounding box.`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await button.evaluate((element) => getComputedStyle(element).pointerEvents), "auto",
    `Workspace actions for ${name} must accept pointer input after heading hover.`);
  await button.click();
  await page.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
}
async function chooseView(page: Page, view: string): Promise<void> {
  await page.locator("#sidebar-settings-open").click();
  await page.locator(`[data-sidebar-view="${view}"]`).click();
  await page.locator("#sidebar-settings-back").click();
}

export async function restoreRegressions(browser: Browser, daemon: TestDaemon, mode?: string): Promise<void> {
  const alpha = `${daemon.root}/alpha`;
  const beta = `${daemon.root}/beta`;
  if (!mode || mode === "initial") {
    await seed(daemon, [alpha, beta]);
    const context = await browser.newContext();
    const release = Promise.withResolvers<void>();
    try {
      const page = await context.newPage();
      let gets = 0;
      let runtimeGets = 0;
      let puts = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/runtimes" && request.method() === "GET") runtimeGets++;
        if (new URL(request.url()).pathname === "/api/state" && request.method() === "PUT") puts++;
      });
      await page.route("**/api/state", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch(); gets++;
        await release.promise;
        await route.fulfill({ response });
      });
      await page.goto(daemon.base);
      await until(async () => gets === 1, "initial GET barrier");
      await page.locator("#sidebar-resizer").press("ArrowRight");
      await page.evaluate(async (key) => { await navigator.locks.request(key, () => {}); }, KEY);
      const edited = await local(page);
      assert.equal(await page.locator("#sidebar-resizer").getAttribute("aria-valuenow"), "294", "sidebar really is interactive during boot");
      assert.equal(edited, null, "unhydrated edits must not publish a fallback cache");
      await Bun.sleep(2800);
      assert.equal(runtimeGets, 1, "boot has not enabled polling while initial GET is pending");
      assert.equal(puts, 0, "initial GET gates publication");
      release.resolve();
      await settle(page, daemon);
      console.log("initial GET + interactive resize:", JSON.stringify({ edited, local: await local(page), remote: await remote(daemon), runtimeGets }));
      assert.deepEqual(new Set((await local(page))?.archivedWorkspaces), new Set([alpha, beta]));
      assert.equal((await local(page))?.width, 294);
      console.log("ok - initial GET retains restore eligibility and explicit local width");
    } finally { release.resolve(); await context.close(); }
  }
  if (!mode || mode === "initial") {
    await seed(daemon, [alpha]);
    const context = await browser.newContext();
    const release = Promise.withResolvers<void>();
    try {
      const established = await context.newPage();
      await established.goto(daemon.base);
      await settle(established, daemon);
      await established.evaluate((key) => localStorage.removeItem(key), KEY);
      const cold = await context.newPage();
      let entered = false;
      await cold.route("**/api/state", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch(); entered = true;
        await release.promise;
        await route.fulfill({ response });
      });
      await cold.goto(daemon.base);
      await until(async () => entered, "cold tab's old archive snapshot");
      await cold.locator("#sidebar-resizer").press("ArrowRight");
      await cold.evaluate(async (key) => { await navigator.locks.request(key, () => {}); }, KEY);
      await addLocal(established, alpha);
      await settle(established, daemon);
      assert.deepEqual((await remote(daemon)).archivedWorkspaces, []);
      release.resolve();
      await settle(cold, daemon);
      assert.deepEqual((await local(cold))?.archivedWorkspaces, [], "old restore must not resurrect another tab's explicit re-add");
      assert.equal((await local(cold))?.width, 294, "cold tab's explicit width remains local intent");
      console.log("ok - cold fallback edit cannot resurrect a newer explicit re-add from another tab");
    } finally { release.resolve(); await context.close(); }
  }
  if (!mode || mode === "edits") {
    for (const phase of ["boot-read", "GET", "queued", "valid-local"] as const) {
      await seed(daemon, [alpha, beta]);
      const context = await browser.newContext();
      const release = Promise.withResolvers<void>();
      try {
        if (phase === "valid-local") await context.addInitScript(({ key, alpha }) => localStorage.setItem(key, JSON.stringify({
          width: 326, view: "sessions", workspaces: [alpha], activeWorkspace: alpha, collapsedWorkspaces: [], archivedWorkspaces: [],
        })), { key: KEY, alpha });
        const page = await context.newPage();
        let entered = false;
        let puts = 0;
        page.on("request", (request) => { if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/state") puts++; });
        await page.route(phase === "boot-read" ? "**/api/runtimes" : "**/api/state", async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const response = await route.fetch(); entered = true;
          await release.promise;
          await route.fulfill({ response });
        });
        await page.goto(daemon.base);
        await until(async () => entered, `${phase} barrier`);
        const gamma = `${daemon.root}/gamma`;
        await addLocal(page, alpha); // Explicit re-add before the baseline is known.
        await addLocal(page, gamma);
        await archiveLocal(page, "gamma");
        await addLocal(page, alpha);
        await chooseView(page, "workspaces");
        await page.locator(".folder-heading").filter({ hasText: "alpha" }).click();
        await page.locator("#sidebar-resizer").press("ArrowRight");
        await page.evaluate(async (key) => { await navigator.locks.request(key, () => {}); }, KEY);
        assert.equal(puts, 0);
        if (phase === "queued") {
          await lock(page);
          release.resolve();
          await queued(page);
          assert.equal(await page.locator("#sidebar-resizer").getAttribute("aria-valuenow"), "294", "queued restore must not mutate live width");
          // These actions run after the restore request, while it still waits.
          await addLocal(page, gamma);
          await archiveLocal(page, "alpha");
          await page.locator("#sidebar-resizer").press("ArrowRight");
          await chooseView(page, "sessions");
          await page.evaluate(() => window.releaseSidebarLock!());
        } else release.resolve();
        await settle(page, daemon);
        const state = (await local(page))!;
        assert.deepEqual(new Set(state.archivedWorkspaces), new Set([...(phase === "valid-local" ? [] : [beta]), phase === "queued" ? alpha : gamma]));
        assert.equal(state.activeWorkspace, phase === "queued" ? gamma : alpha);
        assert.ok(state.collapsedWorkspaces.includes(alpha), "explicit folder collapse survives restoration");
        assert.equal(state.collapsedWorkspaces.includes(beta), phase !== "valid-local", "unrelated baseline folder preference is preserved");
        assert.equal(state.width, phase === "queued" ? 310 : phase === "valid-local" ? 342 : 294);
        assert.equal(state.view, phase === "queued" ? "sessions" : "workspaces");
        assert.deepEqual(new Set(state.workspaces), new Set(phase === "valid-local" ? [alpha, gamma] : [alpha, beta, gamma]));
        console.log(`ok - ${phase}: width/view/active workspace and explicit archive/re-add survive the initial transaction`);
      } finally { release.resolve(); await context.close(); }
    }
  }
  if (!mode || mode === "failure") {
    for (const failure of ["read", "write", "locks", "rejected", "GET", "unsupported"] as const) {
      await seed(daemon, [alpha, beta]);
      const context = await browser.newContext();
      try {
        await context.addInitScript(({ key, failure }) => {
          const get = Storage.prototype.getItem;
          const set = Storage.prototype.setItem;
          const locks = navigator.locks;
          Storage.prototype.getItem = function (name) {
            if (name === key && failure === "read") throw new DOMException("test read denial", "SecurityError");
            return get.call(this, name);
          };
          Storage.prototype.setItem = function (name, value) {
            if (name === key && failure === "write") throw new DOMException("test write denial", "QuotaExceededError");
            return set.call(this, name, value);
          };
          if (failure === "locks" || failure === "rejected") Object.defineProperty(navigator, "locks", {
            configurable: true, value: failure === "locks" ? undefined : { request: () => Promise.reject(new Error("test lock rejection")) },
          });
          window.restoreSidebarStorage = () => {
            Storage.prototype.getItem = get; Storage.prototype.setItem = set;
            Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
          };
        }, { key: KEY, failure });
        const page = await context.newPage();
        let puts = 0;
        let runtimeGets = 0;
        page.on("request", (request) => {
          if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/state") puts++;
          if (request.method() === "GET" && new URL(request.url()).pathname === "/api/runtimes") runtimeGets++;
        });
        if (failure === "GET" || failure === "unsupported") await page.route("**/api/state", (route) => route.request().method() !== "GET"
          ? route.continue() : route.fulfill(failure === "GET" ? { status: 503, body: "test read failure" } : { json: { state: { version: 999 } } }));
        await page.goto(daemon.base);
        await until(async () => runtimeGets >= 2, "failed boot completed and real polling resumed");
        await addLocal(page, alpha);
        await page.locator("#sidebar-resizer").press("ArrowRight");
        await Bun.sleep(100);
        assert.equal(puts, 0, `${failure} stays fail closed`);
        assert.deepEqual((await remote(daemon)).archivedWorkspaces, [alpha, beta]);
        assert.ok(await page.locator("#status").innerText() || await page.locator("#workspace-picker-status").innerText(), "failure is observable");
        await page.evaluate(() => window.restoreSidebarStorage!());
        await page.unroute("**/api/state");
        // A successful preference save retries the same generation's initial transaction.
        await page.locator("#sidebar-resizer").press("ArrowRight");
        await settle(page, daemon);
        assert.deepEqual((await local(page))?.archivedWorkspaces, [beta]);
        assert.equal((await local(page))?.width, 310);
        assert.equal((await local(page))?.activeWorkspace, alpha);
        console.log(`ok - ${failure}: closed publication, visible failure, same-window recovery retains local edits`);
      } finally { await context.close(); }
    }
  }
  if (!mode || mode === "failure") {
    await seed(daemon, [alpha, beta]);
    const context = await browser.newContext();
    try {
      await context.addInitScript(({ key, alpha, beta }) => {
        localStorage.setItem(key, JSON.stringify({ width: 350, view: "sessions", workspaces: [alpha], activeWorkspace: alpha,
          collapsedWorkspaces: [beta], archivedWorkspaces: [] }));
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (name) {
          if (name === key) throw new DOMException("initial cache read denied", "SecurityError");
          return get.call(this, name);
        };
        window.restoreSidebarStorage = () => { Storage.prototype.getItem = get; };
      }, { key: KEY, alpha, beta });
      const page = await context.newPage();
      await page.goto(daemon.base);
      await page.locator("#workspace-picker-status").filter({ hasText: "only kept in this window" }).waitFor();
      await page.locator("#sidebar-resizer").press("ArrowRight");
      await page.evaluate(() => window.restoreSidebarStorage!());
      await page.locator("#sidebar-resizer").press("ArrowRight");
      await settle(page, daemon);
      const state = await local(page);
      console.log("temporarily unreadable existing preferences:", JSON.stringify(state));
      assert.equal(state?.width, 310);
      assert.equal(state?.view, "sessions");
      assert.equal(state?.activeWorkspace, alpha);
      assert.deepEqual(state?.workspaces, [alpha]);
      assert.deepEqual(state?.collapsedWorkspaces, [beta]);
      assert.deepEqual(state?.archivedWorkspaces, []);
      console.log("ok - temporary read denial preserves existing local preferences plus newer explicit edits");
    } finally { await context.close(); }
  }
  if (!mode || mode === "generation") {
    for (const scenario of ["plain", "edits", "blocked"] as const) {
      const editDuringCancellation = scenario === "edits";
      await seed(daemon, [alpha]);
      const context = await browser.newContext();
      const releaseG2 = Promise.withResolvers<void>();
      try {
        const page = await context.newPage();
        let reads = 0;
        let runtimeGets = 0;
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/runtimes" && request.method() === "GET") runtimeGets++; });
        await page.route("**/api/state", async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          reads++;
          if (reads === 1) return route.fulfill({ status: 503, body: "temporary initial read failure" });
          const response = await route.fetch();
          if (reads === 3) {
            await releaseG2.promise;
            if (scenario === "blocked") return route.fulfill({ json: { state: { version: 999 } } });
          }
          await route.fulfill({ response });
        });
        await page.goto(daemon.base);
        await until(async () => runtimeGets >= 2, "normal post-boot polling after failed read");
        await lock(page);
        await daemon.restart();
        await queued(page);
        console.log("G1 queued:", JSON.stringify({ local: await local(page), reads, runtimeGets }));
        if (editDuringCancellation) {
          await addLocal(page, alpha);
          await page.locator("#sidebar-resizer").press("ArrowRight");
        }
        await seed(daemon, [beta]);
        await daemon.restart();
        await until(async () => reads === 3, "G2 observed by real runtime polling");
        await page.evaluate(() => window.releaseSidebarLock!());
        await page.evaluate(async (key) => { await navigator.locks.request(key, () => {}); }, KEY);
        console.log("canceled G1 drained before G2 GET:", JSON.stringify(await local(page)));
        if (editDuringCancellation) {
          assert.equal(await local(page), null, "explicit edits stay in memory until G2 commits a valid baseline");
        } else assert.equal(await local(page), null, "canceled lock callback performs no cache mutation");
        assert.equal(await page.locator("#sidebar-resizer").getAttribute("aria-valuenow"), editDuringCancellation ? "294" : "278", "canceled restore never mutates live preferences");
        // Capture the final outcome too, so the pre-repair evidence shows contamination.
        const g2Response = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/state");
        releaseG2.resolve();
        await g2Response;
        if (scenario === "blocked") {
          await Bun.sleep(100);
          assert.equal(await page.locator("#status").getAttribute("data-kind"), "warn");
          assert.equal(await local(page), null, "canceled G1 cannot reopen a blocked G2 gate");
          assert.deepEqual((await remote(daemon)).archivedWorkspaces, [beta]);
          await page.locator("#sidebar-resizer").press("ArrowRight");
        }
        await settle(page, daemon);
        console.log("generation overlap final:", JSON.stringify({ local: await local(page), remote: await remote(daemon), reads }));
        assert.deepEqual((await local(page))?.archivedWorkspaces, [beta], "canceled G1 must not poison G2's baseline");
        if (editDuringCancellation) {
          assert.equal((await local(page))?.width, 294);
          assert.equal((await local(page))?.activeWorkspace, alpha);
        }
        console.log(`ok - real post-boot restarts cancel a lock-queued older restore (${scenario})`);
      } finally { releaseG2.resolve(); await context.close(); }
    }
  }
  if (!mode || mode === "generation") {
    await seed(daemon, [alpha]);
    const context = await browser.newContext();
    const releaseOld = Promise.withResolvers<void>();
    try {
      const page = await context.newPage();
      let reads = 0;
      let runtimeGets = 0;
      let puts = 0;
      let oldReturned = false;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/runtimes" && request.method() === "GET") runtimeGets++;
        if (new URL(request.url()).pathname === "/api/state" && request.method() === "PUT") puts++;
      });
      await page.route("**/api/state", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const read = ++reads;
        if (read === 1) return route.fulfill({ status: 503, body: "temporary initial read failure" });
        const response = await route.fetch();
        if (read === 2) await releaseOld.promise;
        await route.fulfill({ response });
        if (read === 2) oldReturned = true;
      });
      await page.goto(daemon.base);
      await until(async () => runtimeGets >= 2, "post-boot polling");
      await daemon.restart();
      await until(async () => reads === 2, "G1 GET held");
      await seed(daemon, [beta]);
      await daemon.restart();
      await until(async () => reads === 3, "G2 GET before older response");
      await settle(page, daemon);
      assert.deepEqual((await local(page))?.archivedWorkspaces, [beta]);
      const before = await local(page);
      const beforePuts = puts;
      releaseOld.resolve();
      await until(async () => oldReturned, "old GET delivered");
      await Bun.sleep(300);
      assert.deepEqual(await local(page), before);
      assert.equal(puts, beforePuts, "late canceled GET never reopens the gate or republishes");
      assert.deepEqual(await remote(daemon), before);
      console.log("ok - late G1 response after G2 commit has no live/cache/publication side effects");
    } finally { releaseOld.resolve(); await context.close(); }
  }
}
