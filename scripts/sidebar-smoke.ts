#!/usr/bin/env bun
/** Two real tabs, a fresh browser HOME and an isolated daemon; no provider or native shell. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startTestDaemon } from "./fixtures/daemon";

const KEY = "omp-desktop.sidebar.v1";
type Sidebar = { width: number; archivedWorkspaces: string[] };
declare global {
  interface Window {
    sidebarTest: { hold: boolean; events: StorageEvent[]; writes: number };
    restoreSidebarStorage?: () => void;
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

const daemon = await startTestDaemon();
const browserHome = join(daemon.root, "browser-home");
await mkdir(browserHome, { mode: 0o700 });
const browser = await chromium.launch({
  headless: true,
  env: {
    HOME: browserHome, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
    XDG_CONFIG_HOME: browserHome, XDG_CACHE_HOME: browserHome, XDG_DATA_HOME: browserHome,
  },
}).catch(async (error: unknown) => { await daemon.stop(); throw error; });
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
  const expected = await local(page);
  await waitFor(async () => JSON.stringify(await remote()) === JSON.stringify(expected), "sidebar mirror");
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
async function faultStorage(page: Page, reads: boolean): Promise<void> {
  await page.evaluate(({ key, reads }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key && reads) throw new DOMException("test storage denied", "SecurityError");
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("test quota exhausted", "QuotaExceededError");
      return set.call(this, name, value);
    };
    window.restoreSidebarStorage = () => {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    };
  }, { key: KEY, reads });
}

try {
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

  for (const reads of [false, true]) {
    await add(a, alpha);
    await faultStorage(a, reads);
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
    console.log(`ok - ${reads ? "read/write denial" : "write-only quota failure"} keeps local archive/re-add usable and retries on recovery`);
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
  console.log("SIDEBAR SMOKE PASSED");
} finally {
  await context.close();
  await browser.close();
  await daemon.stop();
}
