#!/usr/bin/env bun
/** Real session-composer focus across tab creation, closure and renumbering. */
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startTestDaemon, writeTestTranscript } from "./fixtures/daemon";

const daemon = await startTestDaemon();
let browser: Browser | undefined;
try {
  await writeTestTranscript(daemon.root, "shortcut-draft", { title: "Shortcut draft" });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(daemon.base);
  const saved = page.locator("#session-list [data-session-file]").filter({ hasText: "Shortcut draft" });
  await saved.waitFor();
  const tabs = page.getByRole("tab");
  const selected = () => page.getByRole("tab", { selected: true });
  const select = async (index: number) => {
    await page.keyboard.press(`Alt+${index}`);
    await page.waitForFunction((name) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === name, `Tab ${index}`);
  };
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  assert.equal(await tabs.count(), 3);
  await saved.click();
  const composer = page.locator(".pane:not([hidden]) .cold-composer textarea:visible");
  await composer.fill("preserved draft");
  await select(2);
  assert.equal(await selected().textContent(), "Tab 2");
  await select(3);
  assert.equal(await composer.inputValue(), "preserved draft");
  await page.getByRole("button", { name: "Close Tab 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await tabs.count(), 2);
  await composer.focus();
  await select(1);
  await select(2);
  assert.equal(await composer.inputValue(), "preserved draft");
  // A settings editor must still receive keys without switching tabs.
  await page.evaluate(() => {
    const editor = document.createElement("input");
    editor.id = "test-shortcut-editor";
    document.body.append(editor);
    editor.focus();
  });
  await page.keyboard.press("Alt+1");
  assert.equal(await selected().textContent(), "Tab 2");
  const pool = await (await fetch(`${daemon.base}/api/runtimes`)).json();
  assert.equal(pool.runtimes.length, 0, "navigation must not start saved agents");
  console.log("PASS Alt+2 from saved-session drafts, closed-tab renumbering, draft retention and editor isolation");
} finally {
  await browser?.close();
  await daemon.stop();
}
