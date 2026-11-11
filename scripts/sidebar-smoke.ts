#!/usr/bin/env bun
/** Two real tabs, a fresh browser HOME and an isolated daemon; no provider or native shell. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startTestDaemon } from "./fixtures/daemon";
import { restoreRegressions } from "./sidebar-restore-smoke";

const KEY = "omp-desktop.sidebar.v1";
type Sidebar = { width: number; archivedWorkspaces: string[]; activeWorkspace: string | null };
declare global {
  interface Window {
    sidebarTest: { hold: boolean; events: StorageEvent[]; writes: number };
    restoreSidebarStorage?: () => void;
    restoreSidebarLocks?: () => void;
    releaseSidebarLock?: () => void;
    __OMP_SELECT_WORKSPACE_DIRECTORY__?: () => Promise<string>;
  }
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Keep the origin stable across real fixture restarts.
const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portReservation.port!;
await portReservation.stop(true);
const daemon = await startTestDaemon({ port });
const browserHome = join(daemon.root, "browser-home");
await mkdir(browserHome, { mode: 0o700 });
const browser = await chromium.launch({
  headless: true,
  env: {
    HOME: browserHome, TMPDIR: browserHome, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
    XDG_CONFIG_HOME: browserHome, XDG_CACHE_HOME: browserHome, XDG_DATA_HOME: browserHome,
  },
}).catch(async (error: unknown) => { await daemon.stop(); throw error; });
console.log(`Chromium ${browser.version()}`);
const context = await browser.newContext();
const puts: string[] = [];
context.on("request", (request) => {
  if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/state") {
    puts.push(request.postData() ?? "");
  }
});
await context.addInitScript((key) => {
  window.sidebarTest = { hold: false, events: [], writes: 0 };
  window.addEventListener("storage", (event) => {
    if (window.sidebarTest.hold && event.key === key) {
      window.sidebarTest.events.push(event);
      event.stopImmediatePropagation();
    }
  });
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    if (name === key) window.sidebarTest.writes++;
    return setItem.call(this, name, value);
  };
}, KEY);
const a = await context.newPage();
const b = await context.newPage();
const alpha = join(daemon.root, "alpha");
const beta = join(daemon.root, "beta");

async function local(page: Page): Promise<Sidebar> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), KEY);
}
async function remote(): Promise<Sidebar | null> {
  const body = await (await fetch(`${daemon.base}/api/state`)).json();
  return body.state?.sidebar ? JSON.parse(body.state.sidebar) : null;
}
async function mirrored(page: Page): Promise<void> {
  // User actions enqueue asynchronous lock requests. Wait behind this tab's
  // pending transaction before capturing the expected committed snapshot.
  await page.evaluate(async (key) => { await navigator.locks?.request(key, () => {}); }, KEY);
  await page.evaluate(async () => { await navigator.locks?.request("omp-desktop.workspace-state", () => {}); });
  const expected = await local(page);
  try {
    await waitFor(async () => JSON.stringify(await remote()) === JSON.stringify(expected), "sidebar mirror");
  } catch (error) {
    console.error("mirror mismatch:", JSON.stringify({ expected, local: await local(page), daemon: await remote(), puts: puts.slice(-4) }));
    throw error;
  }
}
async function add(page: Page, path: string): Promise<void> {
  await page.evaluate((path) => { window.__OMP_SELECT_WORKSPACE_DIRECTORY__ = async () => path; }, path);
  await page.locator("#add-workspace").click();
  await page.getByRole("button", { name: `Workspace actions for ${path.split("/").pop()}`, exact: true }).waitFor();
  await mirrored(page);
}
async function archive(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Workspace actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
  await mirrored(page);
}
async function resize(page: Page): Promise<void> {
  await page.locator("#sidebar-resizer").press("ArrowRight");
  await mirrored(page);
}
async function hold(page: Page): Promise<void> {
  await page.evaluate(() => { window.sidebarTest.hold = true; });
}
async function flushEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.sidebarTest.hold = false;
    // Deliberately replay oldest snapshots after newer local actions. Handlers
    // must read current storage, not let a delayed event roll state back.
    for (const event of window.sidebarTest.events.splice(0)) {
      window.dispatchEvent(new StorageEvent("storage", {
        key: event.key, oldValue: event.oldValue, newValue: event.newValue,
        storageArea: localStorage, url: event.url,
      }));
    }
  });
}
async function visible(page: Page, name: string): Promise<boolean> {
  return page.getByRole("button", { name: `Workspace actions for ${name}`, exact: true }).isVisible();
}
async function faultStorage(page: Page, reads: boolean, writes: boolean): Promise<void> {
  await page.evaluate(({ key, reads, writes }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key && reads) throw new DOMException("test storage denied", "SecurityError");
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key && writes) throw new DOMException("test quota exhausted", "QuotaExceededError");
      return set.call(this, name, value);
    };
    window.restoreSidebarStorage = () => {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    };
  }, { key: KEY, reads, writes });
}

async function sequentialRegressions(): Promise<void> {
  await a.goto(daemon.base);
  await add(a, alpha);
  await add(a, beta);
  await b.goto(daemon.base);
  await b.getByRole("button", { name: "Workspace actions for alpha", exact: true }).waitFor();
  await hold(b);
  await archive(a, "alpha");
  await resize(b);
  const evidence = { local: await local(b), daemon: await remote() };
  console.log("stale-tab unrelated resize:", JSON.stringify(evidence));
  assert.deepEqual(evidence.local.archivedWorkspaces, [alpha]);
  assert.deepEqual(evidence.daemon?.archivedWorkspaces, [alpha]);
  console.log("ok - stale tab's unrelated preference preserves the archive locally and in the daemon");

  // B still has queued events from A, and A has not observed B's next change.
  await hold(a);
  await archive(b, "beta");
  assert.deepEqual(new Set((await local(b)).archivedWorkspaces), new Set([alpha, beta]));
  await add(a, alpha);
  assert.deepEqual((await local(a)).archivedWorkspaces, [beta]);
  await resize(b);
  assert.deepEqual((await local(b)).archivedWorkspaces, [beta]);
  console.log("ok - independent archives survive, and stale re-add removes only its own archive");

  // Queue archive/re-add snapshots in both tabs, then archive through A's stale
  // visible row. Later event delivery must not roll that final action back.
  await archive(a, "alpha");
  await add(b, alpha);
  await flushEvents(b);
  assert.equal(await visible(b, "alpha"), true, "a delayed archive event must not undo explicit re-add");
  await hold(b);
  await a.reload();
  await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).waitFor();
  await hold(a);
  await archive(b, "alpha");
  // A's visible stale row must still issue an explicit archive after B re-adds.
  await add(b, alpha);
  await archive(a, "alpha");
  assert.deepEqual(new Set((await local(a)).archivedWorkspaces), new Set([alpha, beta]));

  const beforeEvents = puts.length;
  const beforeWrites = await Promise.all([a, b].map((page) => page.evaluate(() => window.sidebarTest.writes)));
  await flushEvents(a);
  await flushEvents(b);
  assert.equal(await visible(a, "alpha"), false);
  assert.equal(await visible(b, "alpha"), false);
  assert.equal(await visible(a, "beta"), false);
  assert.equal(await visible(b, "beta"), false);
  await Bun.sleep(300);
  assert.equal(puts.length, beforeEvents, "storage events must not republish daemon state");
  assert.deepEqual(await Promise.all([a, b].map((page) => page.evaluate(() => window.sidebarTest.writes))), beforeWrites,
    "storage events must not save back to localStorage");
  console.log("ok - delayed storage events use current state and cause no save/event feedback");

  await add(a, alpha);
  await waitFor(() => visible(b, "alpha"), "live re-add in the other tab");
  await archive(a, "alpha");
  await waitFor(async () => !await visible(b, "alpha"), "live archive in the other tab");
  await b.reload();
  await b.locator("#sidebar-resizer").waitFor();
  assert.equal(await visible(b, "alpha"), false);
  assert.deepEqual(new Set((await local(b)).archivedWorkspaces), new Set([alpha, beta]));
  console.log("ok - archive/re-add updates the other tab and survives reload");

  for (const [reads, writes] of [[false, true], [true, true], [true, false]] as const) {
    await add(a, alpha);
    await faultStorage(a, reads, writes);
    await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
    await a.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
    await add(b, beta);
    await a.locator("#sidebar-resizer").press("ArrowRight");
    assert.equal(await visible(a, "alpha"), false, "unsaved archive survives another preference change");
    // Re-add also remains usable without browser persistence.
    await a.locator("#add-workspace").click();
    await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).waitFor();
    await archive(b, "beta");
    await a.locator("#sidebar-resizer").press("ArrowLeft");
    assert.equal(await visible(a, "alpha"), true);
    await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
    await a.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
    await a.evaluate(() => window.restoreSidebarStorage!());
    await resize(a);
    assert.deepEqual(new Set((await local(a)).archivedWorkspaces), new Set([alpha, beta]));
    console.log(`ok - ${reads ? (writes ? "read/write denial" : "read-only denial") : "write-only quota failure"} keeps local archive/re-add usable and retries on recovery`);
  }

  await waitFor(async () => !await visible(b, "alpha"), "archive after storage recovery");
  for (const value of [null, "invalid JSON"]) {
    await a.evaluate(({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }, { key: KEY, value });
    await resize(b);
    assert.deepEqual(new Set((await local(b)).archivedWorkspaces), new Set([alpha, beta]));
  }
  console.log("ok - missing/corrupt cache preserves in-memory archives on the next save");

  const fresh = await browser.newContext();
  try {
    const restored = await fresh.newPage();
    await restored.goto(daemon.base);
    await waitFor(async () => (await local(restored))?.archivedWorkspaces.length === 2, "daemon restoration into an empty browser cache");
    assert.deepEqual(new Set((await local(restored)).archivedWorkspaces), new Set([alpha, beta]));
    await resize(restored);
    assert.equal(await visible(restored, "alpha"), false);
    assert.equal(await visible(restored, "beta"), false);
    console.log("ok - daemon restoration into empty browser storage survives another preference save");
  } finally { await fresh.close(); }
}

const regression = process.argv.find((arg) => arg.startsWith("--regression="))?.split("=")[1];
try {
  if (regression && !["overlap", "ordering", "delivery", "locking", "cold", "initial", "generation", "edits", "failure"].includes(regression)) {
    throw new Error(`unknown sidebar regression: ${regression}`);
  }
  if (!regression) await sequentialRegressions();

  if (!regression || regression === "overlap") {
    await a.goto(daemon.base);
    await add(a, alpha);
    await add(a, beta);
    await b.goto(daemon.base);
    await b.getByRole("button", { name: "Workspace actions for beta", exact: true }).waitFor();
    await hold(a);
    await hold(b);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Pause A after its real storage read, before merge/write. A synchronous
    // test-only request holds that JS stack while B runs in another real tab.
    await a.route("**/__sidebar_read_barrier", async (route) => {
      entered.resolve();
      await release.promise;
      await route.fulfill({ status: 200, body: "released" });
    });
    await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
    await a.evaluate((key) => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (name) {
        const value = get.call(this, name);
        if (name === key) {
          Storage.prototype.getItem = get;
          const request = new XMLHttpRequest();
          request.open("GET", "/__sidebar_read_barrier", false);
          request.send();
        }
        return value;
      };
    }, KEY);
    const clickA = a.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
    try {
      await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("read barrier not reached"); })]);
      const writes = await b.evaluate(() => window.sidebarTest.writes);
      await b.getByRole("button", { name: "Workspace actions for beta", exact: true }).click();
      await b.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
      await waitFor(async () => b.evaluate(async (writes) => {
        const locks = await navigator.locks.query();
        return window.sidebarTest.writes > writes || (locks.pending?.length ?? 0) > 0;
      }, writes), "B either writing or waiting on A's lock");
      console.log("controlled overlap while A is paused:", JSON.stringify(await b.evaluate(async () => ({
        locks: await navigator.locks.query(), sidebar: localStorage.getItem("omp-desktop.sidebar.v1"),
      }))));
    } finally { release.resolve(); }
    await clickA;
    await a.unroute("**/__sidebar_read_barrier");
    await mirrored(a);
    await flushEvents(a);
    await flushEvents(b);
    // Force unrelated writes after pending intents have cleared, then reload.
    await resize(a);
    await resize(b);
    console.log("controlled overlap final:", JSON.stringify({ local: await local(b), daemon: await remote() }));
    assert.deepEqual(new Set((await local(b)).archivedWorkspaces), new Set([alpha, beta]));
    assert.deepEqual(new Set((await remote())?.archivedWorkspaces), new Set([alpha, beta]));
    await b.reload();
    await b.locator("#sidebar-resizer").waitFor();
    assert.equal(await visible(b, "alpha"), false);
    assert.equal(await visible(b, "beta"), false);
    console.log("ok - overlapping independent archives serialize their entire read/merge/write and survive cleared intents/reload");
  }

  if (!regression || regression === "ordering") {
    await a.goto(daemon.base);
    await add(a, alpha);
    await b.goto(daemon.base);
    await b.getByRole("button", { name: "Workspace actions for alpha", exact: true }).waitFor();
    await mirrored(b);
    await b.evaluate((key) => {
      void navigator.locks.request(key, () => new Promise<void>((resolve) => { window.releaseSidebarLock = resolve; }));
    }, KEY);
    await waitFor(() => b.evaluate(() => !!window.releaseSidebarLock), "test lock holder");
    try {
      for (const page of [a, b]) {
        await page.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
        await page.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
      }
      // The last re-add must remain last even though A already has an older
      // archive transaction queued ahead of B's explicit archive.
      await a.evaluate((path) => { window.__OMP_SELECT_WORKSPACE_DIRECTORY__ = async () => path; }, alpha);
      await a.locator("#add-workspace").click();
      assert.equal(await visible(a, "alpha"), true);
    } finally { await b.evaluate(() => window.releaseSidebarLock!()); }
    await mirrored(a);
    await mirrored(b);
    assert.equal((await local(a)).archivedWorkspaces.includes(alpha), false, "queued last re-add wins");
    assert.equal((await remote())?.archivedWorkspaces.includes(alpha), false);
    assert.equal((await local(a)).activeWorkspace, alpha, "queued re-add retains its active selection");
    console.log("ok - queued archive/archive/re-add retains action ordering across tabs");
  }

  if (!regression || regression === "delivery") {
    await a.goto(daemon.base);
    await add(a, alpha);
    await add(a, beta);
    await b.goto(daemon.base);
    await b.getByRole("button", { name: "Workspace actions for beta", exact: true }).waitFor();
    await mirrored(b);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await a.route("**/api/state", async (route) => {
      if (route.request().method() === "PUT") {
        entered.resolve();
        await release.promise;
      }
      await route.continue();
    });
    await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
    const archiveA = a.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
    try {
      await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("PUT barrier not reached"); })]);
      await b.getByRole("button", { name: "Workspace actions for beta", exact: true }).click();
      await b.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
      await waitFor(async () => (await local(b)).archivedWorkspaces.length === 2, "local commit while the older PUT is held");
      await waitFor(async () => b.evaluate(async () => {
        const locks = await navigator.locks.query();
        return !!locks.pending?.some((lock) => lock.name === "omp-desktop.workspace-state");
      }), "B's mirror waiting behind A's older PUT");
    } finally { release.resolve(); }
    await archiveA;
    await mirrored(b);
    await a.unroute("**/api/state");
    assert.deepEqual(new Set((await remote())?.archivedWorkspaces), new Set([alpha, beta]));
    console.log("ok - delayed older daemon PUT cannot overtake the newer merged archive snapshot");
  }

  if (!regression || regression === "locking") {
    await a.goto(daemon.base);
    for (const failure of ["unsupported", "rejected"]) {
      await add(a, alpha);
      await add(a, beta);
      const before = await local(a);
      await a.evaluate((failure) => {
        const locks = navigator.locks;
        Object.defineProperty(navigator, "locks", { configurable: true, value: failure === "unsupported" ? undefined : {
          request: () => Promise.reject(new DOMException("test lock denied", "SecurityError")),
        } });
        window.restoreSidebarLocks = () => { Object.defineProperty(navigator, "locks", { configurable: true, value: locks }); };
      }, failure);
      await a.getByRole("button", { name: "Workspace actions for alpha", exact: true }).click();
      await a.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
      await a.locator("#workspace-picker-status").filter({ hasText: "only kept in this window" }).waitFor();
      assert.equal(await visible(a, "alpha"), false);
      await a.locator("#sidebar-resizer").press("ArrowRight");
      assert.deepEqual(await local(a), before, "no unlocked storage fallback");
      assert.deepEqual(await remote(), before, "no stale sidebar publication on lock failure");
      await a.evaluate(() => window.restoreSidebarLocks!());
      await resize(a);
      assert.ok((await local(a)).archivedWorkspaces.includes(alpha), "pending intent retries when locking recovers");
      assert.equal(await a.locator("#workspace-picker-status").isVisible(), false);
    }
    console.log("ok - unsupported/rejected locking keeps edits in memory, warns, and safely retries on recovery");
  }

  if (!regression || regression === "cold") {
    await a.goto(daemon.base);
    await add(a, alpha);
    await archive(a, "alpha");
    const durable = await (await fetch(`${daemon.base}/api/state`)).json();
    for (const cached of ["invalid JSON", "null", "[]", JSON.stringify({ width: 410, archivedWorkspaces: [] })]) {
      // Reset only this disposable daemon's document for each cold browser.
      const seeded = await fetch(`${daemon.base}/api/state`, {
        method: "PUT", headers: { "content-type": "application/json", "X-OMP-Generation": daemon.generation },
        body: JSON.stringify(durable.state),
      });
      assert.equal(seeded.ok, true);
      const fresh = await browser.newContext();
      try {
        await fresh.addInitScript(({ key, cached }) => localStorage.setItem(key, cached), { key: KEY, cached });
        const page = await fresh.newPage();
        const published = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/state");
        await page.goto(daemon.base);
        await published;
        const raw = await page.evaluate((key) => localStorage.getItem(key), KEY);
        console.log("cold cache:", JSON.stringify({ cached, local: raw, daemon: (await (await fetch(`${daemon.base}/api/state`)).json()).state.sidebar }));
        const state = await local(page);
        if (cached.startsWith("{")) {
          assert.equal(state.width, 410, "valid local preferences win over the daemon");
          assert.deepEqual(state.archivedWorkspaces, []);
        } else {
          assert.ok(state.archivedWorkspaces.includes(alpha), "invalid cold cache must adopt the daemon archive");
          await mirrored(page);
          assert.ok((await remote())?.archivedWorkspaces.includes(alpha));
          await resize(page);
          assert.equal(await visible(page, "alpha"), false);
        }
      } finally { await fresh.close(); }
    }
    const seeded = await fetch(`${daemon.base}/api/state`, {
      method: "PUT", headers: { "content-type": "application/json", "X-OMP-Generation": daemon.generation },
      body: JSON.stringify(durable.state),
    });
    assert.equal(seeded.ok, true);
    const unavailable = await browser.newContext();
    try {
      await unavailable.addInitScript((key) => {
        localStorage.setItem(key, "invalid JSON");
        Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      }, KEY);
      const page = await unavailable.newPage();
      let writes = 0;
      page.on("request", (request) => { if (request.method() === "PUT") writes++; });
      await page.goto(daemon.base);
      await page.locator("#workspace-picker-status").filter({ hasText: "only kept in this window" }).waitFor();
      await page.locator("#sidebar-resizer").press("ArrowRight");
      await Bun.sleep(300);
      assert.equal(writes, 0, "failed cold adoption must keep the publication gate closed");
      assert.equal((await (await fetch(`${daemon.base}/api/state`)).json()).state.sidebar, durable.state.sidebar);
    } finally { await unavailable.close(); }
    console.log("ok - invalid cold cache restores durable archives, valid local preferences win, failed adoption preserves the daemon");
  }
  if (!regression || ["initial", "generation", "edits", "failure"].includes(regression)) {
    // These scenarios restart the daemon. Older independent browser contexts
    // would legitimately republish their own whole-document preferences.
    await context.close();
    await restoreRegressions(browser, daemon, regression);
  }
  console.log("SIDEBAR SMOKE PASSED");
} finally {
  await context.close();
  await browser.close();
  await daemon.stop();
}
