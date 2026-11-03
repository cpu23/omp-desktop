#!/usr/bin/env bun
/** Chromium integration regression for space-close recovery and the real session-stop row. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { fakeOmpRecordPath, startTestDaemon, type TestDaemon } from "./fixtures/daemon";

const filePath = "/fixture/reference with spaces.png";
const coldText = "COLD-DRAFT-SURVIVES-SPACE-CLOSE";
const pendingText = "PENDING-INPUT-SURVIVES-SPACE-CLOSE";
const waitTimeoutMs = 15_000;

type Runtime = { id: string; pid: number; cwd: string; sessionFile: string };
type Binding = {
  runtimeId: string | null;
  title: string | null;
  sessionFile: string | null;
  cwd?: string;
  drafts?: Record<string, string>;
  draftFiles?: Record<string, Array<{ path: string; text: string }>>;
  orphanDraft?: string;
};
type Layout = { tree: unknown; panes: Record<string, Binding>; focused: string };
type Workspace = { spaces: Array<{ id: string; layout: Layout }>; activeSpaceId: string };

type AckGate = { messages: string[] };

async function waitFor<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + waitTimeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function createRuntime(daemon: TestDaemon): Promise<Runtime> {
  const response = await fetch(`${daemon.base}/api/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: join(daemon.root, "project"), cols: 80, rows: 24 }),
  });
  if (response.status !== 200) throw new Error(`runtime creation failed: ${await response.text()}`);
  const payload = await response.json() as { runtime?: Record<string, unknown> };
  const id = payload.runtime?.id;
  assert.equal(typeof id, "string");
  const attachment = new WebSocket(`ws://${new URL(daemon.base).host}/ws/term?runtime=${encodeURIComponent(id as string)}`);
  try {
    const value = await waitFor(async () => {
      const result = await fetch(`${daemon.base}/api/runtimes`);
      const body = await result.json() as { runtimes?: Array<Record<string, unknown>> };
      return body.runtimes?.find((candidate) => candidate.id === id) ?? null;
    }, (runtime) => runtime !== null && runtime.alive === true && typeof runtime.pid === "number" &&
        typeof runtime.sessionFile === "string" && runtime.sessionFile.length > 0,
    `fake OMP runtime ${id} to start and announce a session transcript`);
    if (!value) throw new Error(`runtime ${id} disappeared after PTY attachment`);
    return { id: id as string, pid: value.pid as number, cwd: value.cwd as string, sessionFile: value.sessionFile as string };
  } catch (error) {
    throw new Error(`${String(error)}; isolated daemon diagnostics=${daemon.diagnostics()}`);
  } finally {
    attachment.close();
  }
}

async function writeWorkspace(daemon: TestDaemon, workspace: Workspace): Promise<void> {
  const response = await fetch(`${daemon.base}/api/runtimes`);
  const body = await response.json() as { generation?: unknown };
  assert.equal(typeof body.generation, "string", "daemon did not expose its workspace generation");
  const saved = await fetch(`${daemon.base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-OMP-Generation": body.generation as string },
    body: JSON.stringify({ version: 2, savedAt: new Date().toISOString(), layout: workspace, pins: [], cellSize: 13.33, sidebar: null }),
  });
  assert.equal(saved.status, 200, `seeding isolated workspace failed: ${await saved.text()}`);
}

async function savedWorkspace(daemon: TestDaemon): Promise<Workspace> {
  const response = await fetch(`${daemon.base}/api/state`);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { state?: { layout?: Workspace } };
  assert.ok(snapshot.state?.layout, "daemon has no saved workspace layout");
  return snapshot.state.layout;
}

async function freshBrowserPage(browser: Browser, daemon: TestDaemon, ackGate?: AckGate): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  if (ackGate) {
    await page.routeWebSocket("**/ws/term*", (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message) as { type?: string };
            if (parsed.type === "inputAck") {
              ackGate.messages.push(message);
              return;
            }
          } catch {}
        }
        route.send(message);
      });
    });
  }
  await page.goto(daemon.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#space-tabs [role='tab']", { timeout: waitTimeoutMs });
  return { context, page };
}

async function clickSpaceClose(page: Page): Promise<void> {
  await page.locator("#space-tabs .space-tab-group").first().locator(".space-close")
    .evaluate((button) => (button as HTMLButtonElement).click());
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function stopAndReap(page: Page, daemon: TestDaemon, runtime: Runtime): Promise<void> {
  const staleSelector = `#session-list .row[title*="${runtime.id}"] .kill`;
  assert.equal(await page.locator(staleSelector).count(), 0,
    "runtime sidebar title unexpectedly acts as an identity selector again");
  const selector = `#session-list .row[data-runtime-id="${runtime.id}"] .kill`;
  await page.waitForSelector(selector, { timeout: waitTimeoutMs });
  await page.locator(selector).evaluate((button) => (button as HTMLButtonElement).click());
  await waitFor(async () => {
    const response = await fetch(`${daemon.base}/api/runtimes`);
    const body = await response.json() as { runtimes?: Array<{ id: string }> };
    return body.runtimes ?? [];
  }, (runtimes) => !runtimes.some((entry) => entry.id === runtime.id), `stop control to remove runtime ${runtime.id}`);
  await waitFor(() => processAlive(runtime.pid), (alive) => !alive, `owned PTY ${runtime.pid} to be reaped`);
  console.log(`ok - Chromium found no title-based stop row, selected runtime ${runtime.id} by data-runtime-id; stop removed it and reaped pid ${runtime.pid}`);
}

async function testNonLastSpaceColdDraft(browser: Browser): Promise<void> {
  const daemon = await startTestDaemon();
  let context: BrowserContext | undefined;
  try {
    const runtime = await createRuntime(daemon);
    const identity = `new:${runtime.cwd}`;
    await writeWorkspace(daemon, {
      spaces: [
        {
          id: "source",
          layout: {
            tree: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", pane: "p1" }, b: { kind: "leaf", pane: "p2" } },
            panes: {
              p1: { runtimeId: runtime.id, title: "running fixture", sessionFile: runtime.sessionFile, cwd: runtime.cwd },
              p2: { runtimeId: null, title: null, sessionFile: null, cwd: runtime.cwd },
            },
            focused: "p2",
          },
        },
        {
          id: "target",
          layout: {
            tree: { kind: "leaf", pane: "p3" },
            panes: { p3: { runtimeId: null, title: null, sessionFile: null, cwd: runtime.cwd } },
            focused: "p3",
          },
        },
      ],
      activeSpaceId: "source",
    });

    ({ context } = await freshBrowserPage(browser, daemon));
    const page = context.pages()[0]!;
    const sourceComposer = page.locator('#panes .pane[data-pane="p2"] textarea[aria-label="Message this session"]');
    await sourceComposer.waitFor({ state: "visible", timeout: waitTimeoutMs });
    await sourceComposer.fill(coldText);
    await sourceComposer.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(input.value.length, input.value.length);
      const pane = input.closest<HTMLElement>(".pane")!;
      const rect = pane.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent("omp-desktop-file-drop", {
        detail: { paths: ["/fixture/reference with spaces.png"], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      }));
    });
    const expectedDraft = `${coldText} '/fixture/reference with spaces.png' `;
    await waitFor(() => sourceComposer.inputValue(), (value) => value === expectedDraft,
      "cold composer to stage a shell-quoted file reference without submitting it");
    assert.deepEqual((await savedWorkspace(daemon)).spaces.length, 2);

    await clickSpaceClose(page);
    await page.waitForFunction(() => document.querySelectorAll("#space-tabs [role='tab']").length === 1,
      undefined, { timeout: waitTimeoutMs });
    const durable = await waitFor(() => savedWorkspace(daemon), (value) => value.spaces.length === 1 &&
      value.spaces[0]!.layout.panes.p3?.drafts?.[identity] === expectedDraft &&
      (value.spaces[0]!.layout.panes.p3?.draftFiles?.[identity]?.some((file) =>
        file.path === filePath && file.text === "'/fixture/reference with spaces.png'") ?? false),
    "closed non-last space's unsent draft and file reference to reach daemon state");
    assert.equal(durable.spaces[0]!.layout.panes.p3!.runtimeId, null, "recovery was attached to a runtime");
    assert.deepEqual(await (await fetch(`${daemon.base}/api/runtimes`)).json().then((body: { runtimes?: unknown[] }) => body.runtimes?.length), 1,
      "closing the source space stopped or duplicated its running session");

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    const targetComposer = page.locator('#panes .pane[data-pane="p3"] textarea[aria-label="Message this session"]');
    await targetComposer.waitFor({ state: "visible", timeout: waitTimeoutMs });
    await waitFor(() => targetComposer.inputValue(), (value) => value === expectedDraft,
      "fresh Chromium workspace to restore the closed-space cold draft");
    await Bun.sleep(500);
    const afterReload = await savedWorkspace(daemon);
    assert.equal(afterReload.spaces[0]!.layout.panes.p3!.draftFiles?.[identity]?.[0]?.path, filePath,
      "fresh workspace lost the draft file reference");
    const inputRecord = await readFile(fakeOmpRecordPath(daemon.root, runtime.id)).catch(() => Buffer.alloc(0));
    assert.equal(inputRecord.includes(Buffer.from(coldText)), false, "cold draft was automatically sent to the detached runtime");
    assert.equal((await (await fetch(`${daemon.base}/api/runtimes`)).json() as { runtimes: Array<{ id: string }> }).runtimes
      .some((item) => item.id === runtime.id), true, "closed space did not leave the PTY running");
    console.log("ok - Chromium closed a non-last space and restored the unsent cold draft plus file reference from daemon state");
    await stopAndReap(page, daemon, runtime);
  } finally {
    await context?.close();
    await daemon.stop();
  }
}

async function testLastSpaceBeforeAck(browser: Browser): Promise<void> {
  const daemon = await startTestDaemon();
  let context: BrowserContext | undefined;
  try {
    const runtime = await createRuntime(daemon);
    const coldIdentity = `new:${runtime.cwd}`;
    await writeWorkspace(daemon, {
      spaces: [{
        id: "last",
        layout: {
          tree: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", pane: "p1" }, b: { kind: "leaf", pane: "p2" } },
          panes: {
            p1: { runtimeId: runtime.id, title: "pending input fixture", sessionFile: runtime.sessionFile, cwd: runtime.cwd },
            p2: { runtimeId: null, title: null, sessionFile: null, cwd: runtime.cwd },
          },
          focused: "p1",
        },
      }],
      activeSpaceId: "last",
    });
    const ackGate: AckGate = { messages: [] };
    ({ context } = await freshBrowserPage(browser, daemon, ackGate));
    const page = context.pages()[0]!;
    const coldComposer = page.locator('#panes .pane[data-pane="p2"] textarea[aria-label="Message this session"]');
    await coldComposer.waitFor({ state: "visible", timeout: waitTimeoutMs });
    await coldComposer.fill(coldText);
    await coldComposer.evaluate((element, path) => {
      const pane = element.closest<HTMLElement>(".pane")!;
      const rect = pane.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent("omp-desktop-file-drop", {
        detail: { paths: [path], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      }));
    }, filePath);
    const expectedColdDraft = `${coldText} '${filePath}' `;
    await waitFor(() => coldComposer.inputValue(), (value) => value === expectedColdDraft,
      "last-space cold composer to stage unsent text and a file reference");
    await waitFor(() => savedWorkspace(daemon), (workspace) =>
      workspace.spaces[0]!.layout.panes.p2?.drafts?.[coldIdentity] === expectedColdDraft &&
      (workspace.spaces[0]!.layout.panes.p2?.draftFiles?.[coldIdentity]?.some((file) => file.path === filePath) ?? false),
    "last-space cold draft and file reference to reach daemon state before close");
    const terminalInput = page.locator('#panes .pane[data-pane="p1"] .xterm-helper-textarea');
    await terminalInput.waitFor({ state: "visible", timeout: waitTimeoutMs });
    await page.waitForFunction(() => {
      const starting = document.querySelector<HTMLElement>('#panes .pane[data-pane="p1"] .pane-starting');
      return !starting || starting.hidden;
    }, undefined, { timeout: waitTimeoutMs });
    await terminalInput.click({ force: true });
    await page.keyboard.type(pendingText);
    await page.keyboard.press("Enter");
    await waitFor(() => ackGate.messages.length, (count) => count > 0,
      "daemon inputAck to arrive while the Chromium route withholds it");
    const recordPath = fakeOmpRecordPath(daemon.root, runtime.id);
    const beforeClose = await waitFor(async () => await readFile(recordPath).catch(() => Buffer.alloc(0)),
      (bytes) => bytes.includes(Buffer.from(pendingText)), "PTY to accept terminal input while its browser ACK is withheld");
    const heldAcks = ackGate.messages.length;
    assert.ok(heldAcks > 0, "the client processed inputAck before closeSpace; the required race was not exercised");
    assert.equal(beforeClose.toString("utf8").split(pendingText).length - 1, 1, "fixture did not receive the pending input exactly once before close");

    await clickSpaceClose(page);
    await page.waitForFunction(() => document.querySelectorAll("#space-tabs [role='tab']").length === 1,
      undefined, { timeout: waitTimeoutMs });
    const durable = await waitFor(() => savedWorkspace(daemon), (value) => value.spaces.length === 1 &&
      Object.values(value.spaces[0]!.layout.panes).some((binding) => binding.orphanDraft?.includes(pendingText)) &&
      Object.values(value.spaces[0]!.layout.panes).some((binding) =>
        binding.drafts?.[coldIdentity] === expectedColdDraft && binding.draftFiles?.[coldIdentity]?.some((file) => file.path === filePath)),
    "last-space close to durably retain both ACK-raced input and the cold draft/file reference");
    assert.equal(Object.values(durable.spaces[0]!.layout.panes).some((binding) => binding.runtimeId === runtime.id), false,
      "replacement recovery pane remained bound to the runtime");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    const review = page.locator(".orphan-draft-review");
    await review.waitFor({ state: "visible", timeout: waitTimeoutMs });
    assert.match(await review.innerText(), new RegExp(pendingText));
    const restoredColdComposer = page.locator('.cold-composer textarea[aria-label="Message this session"]');
    await restoredColdComposer.waitFor({ state: "visible", timeout: waitTimeoutMs });
    assert.equal(await restoredColdComposer.inputValue(), expectedColdDraft,
      "last-space close did not restore the cold draft into a reviewable composer");
    const restoredWorkspace = await savedWorkspace(daemon);
    assert.ok(Object.values(restoredWorkspace.spaces[0]!.layout.panes).some((binding) =>
      binding.draftFiles?.[coldIdentity]?.some((file) => file.path === filePath)),
    "last-space cold file reference did not survive fresh-profile restore");
    await Bun.sleep(750);
    const afterReload = await readFile(recordPath);
    assert.deepEqual(afterReload, beforeClose, "closing/reloading automatically resubmitted the unacknowledged bytes");
    assert.equal(afterReload.toString("utf8").split(pendingText).length - 1, 1,
      "the detached runtime received the unacknowledged input more than once");
    assert.equal(afterReload.includes(Buffer.from(coldText)), false, "last-space cold draft was automatically sent");
    assert.ok((await (await fetch(`${daemon.base}/api/runtimes`)).json() as { runtimes: Array<{ id: string }> }).runtimes
      .some((item) => item.id === runtime.id), "closing the last space killed the runtime");
    console.log("ok - Chromium held inputAck, closed the last space, durably restored pending/cold drafts and file reference, and did not send either draft");
    await stopAndReap(page, daemon, runtime);
  } finally {
    await context?.close();
    await daemon.stop();
  }
}

const browserHome = await mkdtemp(join(tmpdir(), "omp-recovery-chromium-home-"));
let browser: Browser | undefined;
try {
  const launchedBrowser = await chromium.launch({
    headless: true,
    env: {
      HOME: browserHome,
      XDG_CONFIG_HOME: join(browserHome, ".config"),
      XDG_CACHE_HOME: join(browserHome, ".cache"),
      XDG_DATA_HOME: join(browserHome, ".local/share"),
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    },
  });
  browser = launchedBrowser;
  if (process.argv.includes("--last-only")) {
    await testLastSpaceBeforeAck(launchedBrowser);
  } else {
    await testNonLastSpaceColdDraft(launchedBrowser);
    await testLastSpaceBeforeAck(launchedBrowser);
  }
} finally {
  await browser?.close();
  await rm(browserHome, { recursive: true, force: true });
}
