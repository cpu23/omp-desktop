/**
 * Behavioral regression coverage for `protectScrollback`.
 *
 * The failure this guards against is xterm's normal buffer exposing the
 * mutable active screen in the bottom of a scrolled-up viewport. OMP's
 * append-only renderer repaints that screen in place, so without the guard a
 * reader a few lines above the tail sees frozen history above a live window
 * that rewrites (and blanks) rows while output continues.
 *
 * The helper defers reconciliation to a microtask because the browser terminal
 * routes scrolling through an async DOM viewport. These tests drive the real
 * headless buffer and yield between actions for that microtask, but cannot
 * reproduce the browser viewport's reentrancy; the browser behavior is
 * exercised separately.
 */
import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { protectScrollback, type ScrollbackTerminal } from "./scrollback";

const COLS = 40;

function terminal(rows: number, scrollback = 2000): Terminal {
  return new Terminal({ cols: COLS, rows, scrollback, allowProposedApi: true });
}

function write(term: Terminal, data: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  term.write(data, () => resolve());
  return promise;
}

function numbered(count: number, prefix: string): string {
  let output = "";
  for (let i = 0; i < count; i++) {
    output += `${prefix}${String(i).padStart(2, "0")} xxxxxxxxxx\r\n`;
  }
  return output;
}

/** Drain the guard's microtask chain without wall-clock waits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** The visible rows, right-trimmed like terminal text. */
function viewport(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
  }
  return rows;
}

/** Models the browser terminal's defining scroll quirk: programmatic scrolling
 *  issued from inside a scroll handler is ignored while `_handleScroll` runs. */
class BrowserLikeTerminal implements ScrollbackTerminal {
  readonly rows = 20;
  readonly buffer = { active: { type: "normal" as "normal" | "alternate", baseY: 41, viewportY: 41 } };
  ignoredSynchronousScrolls = 0;
  #handlingScroll = false;
  #scrollListeners = new Set<(position: number) => void>();
  #writeListeners = new Set<() => void>();
  #resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();

  scrollToLine(line: number): void {
    if (this.#handlingScroll) {
      this.ignoredSynchronousScrolls++;
      return;
    }
    this.buffer.active.viewportY = line;
    for (const listener of this.#scrollListeners) listener(line);
  }

  onScroll(listener: (position: number) => void): { dispose(): void } {
    this.#scrollListeners.add(listener);
    return { dispose: () => { this.#scrollListeners.delete(listener); } };
  }

  onWriteParsed(listener: () => void): { dispose(): void } {
    this.#writeListeners.add(listener);
    return { dispose: () => { this.#writeListeners.delete(listener); } };
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.#resizeListeners.add(listener);
    return { dispose: () => { this.#resizeListeners.delete(listener); } };
  }

  /** Deliver a reader scroll the way the browser viewport does: inside the
   *  scrollable handler, before the terminal has finished handling it. */
  userScrollTo(line: number): void {
    this.#handlingScroll = true;
    this.buffer.active.viewportY = line;
    for (const listener of this.#scrollListeners) listener(line);
    this.#handlingScroll = false;
  }
}

describe("protectScrollback", () => {
  test("defers corrections past the browser viewport's own scroll handling", async () => {
    const term = new BrowserLikeTerminal();
    protectScrollback(term);

    term.userScrollTo(38);
    expect(term.ignoredSynchronousScrolls).toBe(0);
    expect(term.buffer.active.viewportY).toBe(38);
    await settle();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - term.rows);

    // Crossing down into the band must land on live, not on the seam.
    term.userScrollTo(term.buffer.active.baseY - term.rows + 1);
    await settle();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

    // And up from live must land entirely in history.
    term.userScrollTo(term.buffer.active.baseY - 1);
    await settle();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - term.rows);
  });

  test("keeps a scrolled viewport in committed history across appends and live repaints", async () => {
    const term = terminal(10);
    try {
      await write(term, numbered(30, "L"));
      protectScrollback(term);

      // Three rows up would leave seven mutable active rows in the viewport.
      term.scrollLines(-3);
      await settle();
      const buffer = term.buffer.active;
      expect(buffer.viewportY).toBe(buffer.baseY - term.rows);
      expect(buffer.viewportY + term.rows).toBeLessThanOrEqual(buffer.baseY);

      const frozen = viewport(term);
      expect(frozen[0]).toBe("L11 xxxxxxxxxx");
      expect(frozen[9]).toBe("L20 xxxxxxxxxx");
      const frozenBaseY = buffer.baseY;
      const frozenViewportY = buffer.viewportY;

      // Ordinary append: rows enter history at the bottom, the reader stays.
      await write(term, "A0\r\nA1\r\nA2\r\n");
      await settle();
      expect(buffer.viewportY).toBe(frozenViewportY);
      expect(buffer.viewportY + term.rows).toBeLessThanOrEqual(buffer.baseY);
      expect(buffer.baseY).toBeGreaterThan(frozenBaseY);
      expect(viewport(term)).toEqual(frozen);

      // Cursor-addressed live-window repaint, sync-wrapped like OMP's frames.
      let frame = "\x1b[?2026h\x1b[H\x1b[2J";
      for (let y = 0; y < term.rows; y++) frame += `R${y} repainted\r\n`;
      frame += "\x1b[?2026l";
      await write(term, frame);
      await settle();

      expect(buffer.viewportY).toBe(frozenViewportY);
      expect(buffer.viewportY + term.rows).toBeLessThanOrEqual(buffer.baseY);
      expect(viewport(term)).toEqual(frozen);

      // Crossing down into the mutable band snaps to the live tail.
      const baseY = buffer.baseY;
      term.scrollLines(baseY - term.rows + 1 - buffer.viewportY);
      await settle();
      expect(buffer.viewportY).toBe(baseY);

      // One row up from the live tail snaps to a full screen of history.
      term.scrollLines(-1);
      await settle();
      expect(buffer.viewportY).toBe(baseY - term.rows);

      // Downward movement that stays inside history is not interrupted.
      term.scrollLines(-(baseY - term.rows));
      await settle();
      expect(buffer.viewportY).toBe(0);
      term.scrollLines(2);
      await settle();
      expect(buffer.viewportY).toBe(2);
      term.scrollLines(1);
      await settle();
      expect(buffer.viewportY).toBe(3);
    } finally {
      term.dispose();
    }
  });

  test("does not move an at-bottom viewport or stop it following output", async () => {
    const term = terminal(8);
    try {
      await write(term, numbered(5, "B"));
      protectScrollback(term);
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

      await write(term, numbered(12, "C"));
      await settle();
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

      await write(term, "D0\r\nD1\r\n");
      await settle();
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
      expect(viewport(term).at(-1)).toBe("");
      expect(viewport(term).at(-2)).toBe("D1");
    } finally {
      term.dispose();
    }
  });

  test("leaves the alternate buffer alone", async () => {
    const term = terminal(8);
    try {
      await write(term, numbered(20, "E"));
      protectScrollback(term);

      await write(term, "\x1b[?1049h");
      await settle();
      expect(term.buffer.active.type).toBe("alternate");
      await write(term, numbered(6, "ALT"));
      await settle();
      expect(term.buffer.active.type).toBe("alternate");
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

      await write(term, "\x1b[?1049l");
      await settle();
      expect(term.buffer.active.type).toBe("normal");
      // The normal buffer returns where it was left: at the tail.
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    } finally {
      term.dispose();
    }
  });

  test("snaps to live while there is not yet a full screen of history", async () => {
    const term = terminal(10);
    try {
      // 15 lines over a 10-row screen leaves baseY 6: less than one screen.
      await write(term, numbered(15, "S"));
      const buffer = term.buffer.active;
      expect(buffer.baseY).toBeLessThan(term.rows);

      const dispose = protectScrollback(term);
      term.scrollLines(-2);
      await settle();
      // No all-history viewport exists, so the only coherent view is live.
      expect(buffer.viewportY).toBe(buffer.baseY);

      dispose();
      term.scrollLines(-2);
      await settle();
      expect(buffer.viewportY).toBe(buffer.baseY - 2);
    } finally {
      term.dispose();
    }
  });

  test("scrollback trim while reading history does not snap to live", async () => {
    const term = terminal(8, 12);
    try {
      await write(term, numbered(30, "T"));
      protectScrollback(term);
      term.scrollLines(-3);
      await settle();
      const buffer = term.buffer.active;
      expect(buffer.viewportY).toBe(buffer.baseY - term.rows);

      // The buffer is full, so each new line trims the top and decrements
      // ydisp to keep the visible bytes still. That is not a reader gesture.
      await write(term, numbered(5, "U"));
      await settle();
      expect(buffer.viewportY).toBeLessThan(buffer.baseY);
      expect(buffer.viewportY + term.rows).toBeLessThanOrEqual(buffer.baseY);
    } finally {
      term.dispose();
    }
  });
});
