#!/usr/bin/env bun
/** Exercise session tooltip pointer/focus transitions with the product stylesheet in Chromium. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

const bundleDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "omp-session-hover-"));
let browser: Browser | undefined;
try {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/session-hover-browser-entry.ts`],
    target: "browser",
    format: "iife",
    outdir: bundleDir,
  });
  assert(build.success, build.logs.map((log) => log.message).join("\n"));
  const bundlePath = join(bundleDir, "session-hover-browser-entry.js");
  const stylesheet = await readFile(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`
    <div id="app">
      <aside id="sidebar">
        <div id="session-list">
          <div id="row-a" class="row recent" tabindex="0" role="button">
            <span class="sub">/work/row-a</span>
            <span class="name"><span class="title">Row A</span></span>
            <div class="row-actions"></div>
          </div>
          <div id="row-b" class="row recent" tabindex="0" role="button">
            <span class="sub">/work/row-b</span>
            <span class="name"><span class="title">Row B</span></span>
            <div class="row-actions"></div>
          </div>

        </div>
      </aside>
      <main style="flex: 1; min-width: 0"><button id="outside">Outside</button></main>
    </div>
  `);
  await page.addStyleTag({ content: stylesheet });
  await page.evaluate(() => {
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    const refreshTimers = new Set<number>();
    (window as Window & { sessionHoverRefreshTimers?: Set<number> }).sessionHoverRefreshTimers = refreshTimers;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: number[]) => {
      const timer = originalSetInterval(handler, timeout, ...args);
      if (timeout === 30_000 && typeof handler === "function") {
        (window as Window & { sessionHoverRefresh?: () => void }).sessionHoverRefresh = handler as () => void;
        refreshTimers.add(timer);
      }
      return timer;
    }) as typeof window.setInterval;
    window.clearInterval = ((timer?: number) => {
      if (timer !== undefined) refreshTimers.delete(timer);
      originalClearInterval(timer);
    }) as typeof window.clearInterval;
  });
  await page.addScriptTag({ path: bundlePath });
  await page.evaluate(() => {
    const wire = (window as unknown as {
      wireSessionHover: (row: HTMLElement, readDetails: () => {
        title: string; directory: string; lastActivity: string | null; costUsd: number | null;
      }) => void;
    }).wireSessionHover;
    for (const id of ["row-a", "row-b"]) {
      wire(document.getElementById(id)!, () => ({
        title: id,
        directory: `/work/${id}`,
        lastActivity: null,
        costUsd: null,
      }));
    }
  });
  const card = page.locator("#session-hover-card");
  const expectTitle = async (expected: string): Promise<void> => {
    try {
      await page.waitForFunction((title) => {
        const card = document.querySelector<HTMLElement>("#session-hover-card");
        return card !== null && !card.hidden && card.querySelector(".session-hover-title")?.textContent === title;
      }, expected, { timeout: 5_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        card: document.querySelector<HTMLElement>("#session-hover-card")?.outerHTML ?? null,
        focused: (document.activeElement as HTMLElement | null)?.id ?? null,
        events: (window as unknown as { hoverEvents: string[] }).hoverEvents,
        rows: ["row-a", "row-b"].map((id) => ({
          id,
          rect: document.getElementById(id)?.getBoundingClientRect().toJSON() ?? null,
          describedBy: document.getElementById(id)?.getAttribute("aria-describedby") ?? null,
        })),
      }));
      throw new Error(`Tooltip ${expected} was not shown: ${JSON.stringify(state)}; ${String(error)}`);
    }
  };
  const moveIntoCard = async (rowId: "row-a" | "row-b"): Promise<void> => {
    const row = await page.locator(`#${rowId}`).boundingBox();
    const box = await card.boundingBox();
    assert.ok(row && box, "The real session row and tooltip must have browser geometry.");
    assert.ok(box.x >= row.x + row.width, "The stylesheet must place this tooltip beyond the hovered row.");
    assert.equal(await card.evaluate((element) => getComputedStyle(element).position), "fixed");
    assert.equal(await card.evaluate((element) => getComputedStyle(element).pointerEvents), "auto");
    await page.evaluate(() => {
      const cardElement = document.querySelector<HTMLElement>("#session-hover-card")!;
      (window as unknown as { cardPointerEntered: boolean }).cardPointerEntered = false;
      cardElement.addEventListener("pointerenter", () => {
        (window as unknown as { cardPointerEntered: boolean }).cardPointerEntered = true;
      }, { once: true });
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => (window as unknown as { cardPointerEntered: boolean }).cardPointerEntered);
    await page.waitForTimeout(180); // Exceed the 120 ms row-to-card transition window.
  };

  await page.locator("#row-a").focus();
  await expectTitle("row-a");
  await page.locator("#row-b").hover();
  await expectTitle("row-b");
  await moveIntoCard("row-b");
  await expectTitle("row-b");
  await page.mouse.move(700, 500);
  await expectTitle("row-a");
  assert.equal(await page.locator("#row-a").evaluate((row) => row.matches(":focus")), true);

  await page.locator("#row-b").focus();
  await expectTitle("row-b");
  await page.locator("#row-a").hover();
  await expectTitle("row-a");
  await moveIntoCard("row-a");
  await expectTitle("row-a");
  await page.mouse.move(700, 500);
  await expectTitle("row-b");

  await page.locator("#outside").focus();
  await card.waitFor({ state: "hidden" });
  await page.locator("#row-a").focus();
  await expectTitle("row-a");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "hidden" });
  await page.locator("#outside").focus();
  await page.locator("#row-a").focus();
  await expectTitle("row-a");
  await page.locator("#row-b").hover();
  await expectTitle("row-b");
  await moveIntoCard("row-b");
  await page.locator("#row-b").evaluate((row) => row.remove());
  await page.evaluate(() => {
    const refresh = (window as Window & { sessionHoverRefresh?: () => void }).sessionHoverRefresh;
    if (!refresh) throw new Error("The production tooltip refresh timer was not registered.");
    refresh();
  });
  await expectTitle("row-a");
  assert.equal(await page.locator("#row-a").getAttribute("aria-describedby"), "session-hover-card");

  await page.locator("#outside").focus();
  await card.waitFor({ state: "hidden" });
  const lifecyclePage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await lifecyclePage.setContent('<button id="row-a">Row A</button><button id="row-b">Row B</button><button id="row-c">Row C</button>');
  await lifecyclePage.addStyleTag({ content: stylesheet });
  await lifecyclePage.evaluate(() => {
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    const refreshTimers = new Set<number>();
    (window as Window & { sessionHoverRefreshTimers?: Set<number> }).sessionHoverRefreshTimers = refreshTimers;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: number[]) => {
      const timer = originalSetInterval(handler, timeout, ...args);
      if (timeout === 30_000 && typeof handler === "function") refreshTimers.add(timer);
      return timer;
    }) as typeof window.setInterval;
    window.clearInterval = ((timer?: number) => {
      if (timer !== undefined) refreshTimers.delete(timer);
      originalClearInterval(timer);
    }) as typeof window.clearInterval;
  });
  await lifecyclePage.addScriptTag({ path: bundlePath });
  await lifecyclePage.evaluate(() => {
    const wire = (window as unknown as {
      wireSessionHover: (row: HTMLElement, readDetails: () => {
        title: string; directory: string; lastActivity: string | null; costUsd: number | null;
      }) => void;
    }).wireSessionHover;
    for (const id of ["row-a", "row-b", "row-c"]) {
      wire(document.getElementById(id)!, () => ({ title: id, directory: id, lastActivity: null, costUsd: null }));
    }
  });
  const lifecycleCard = lifecyclePage.locator("#session-hover-card");
  const expectLifecycleTitle = async (expected: string): Promise<void> => {
    await lifecyclePage.waitForFunction((title) => {
      const card = document.querySelector<HTMLElement>("#session-hover-card");
      return card !== null && !card.hidden && card.querySelector(".session-hover-title")?.textContent === title;
    }, expected);
  };
  await lifecyclePage.locator("#row-b").dispatchEvent("pointerenter");
  await expectLifecycleTitle("row-b");
  await lifecyclePage.locator("#row-c").dispatchEvent("focusin", { bubbles: true });
  await expectLifecycleTitle("row-c");
  await lifecycleCard.dispatchEvent("pointerenter");
  await lifecyclePage.locator("#row-c").evaluate((row) => row.remove());
  await lifecycleCard.dispatchEvent("pointerleave");
  await expectLifecycleTitle("row-b");
  await lifecyclePage.keyboard.press("Escape");
  await lifecycleCard.waitFor({ state: "hidden" });
  const remainingRefreshTimers = await lifecyclePage.evaluate(() =>
    (window as Window & { sessionHoverRefreshTimers?: Set<number> }).sessionHoverRefreshTimers?.size ?? -1);
  assert.equal(remainingRefreshTimers, 0, "hiding the fallback tooltip must clear every refresh interval");
  console.log("ok - product CSS tooltip accepts real pointer entry and preserves independent focus/pointer anchors");
} finally {
  await browser?.close();
  await rm(bundleDir, { recursive: true, force: true });
}
