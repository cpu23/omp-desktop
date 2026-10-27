import { describe, expect, spyOn, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { RuntimeResourceBudget } from "./resource-budget";
import { TerminalReplay } from "./terminal-replay";

function append(replay: TerminalReplay, data: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  replay.append(data, resolve);
  return promise;
}

function snapshot(replay: TerminalReplay): Promise<{ data: string; cols: number; rows: number }> {
  const { promise, resolve } = Promise.withResolvers<{ data: string; cols: number; rows: number }>();
  replay.snapshot(resolve);
  return promise;
}

function write(term: Terminal, data: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  term.write(data, resolve);
  return promise;
}

function lines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)!.translateToString(true));
}
function cursorHidden(term: Terminal): boolean {
  const internal = term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } };
  return internal._core?.coreService?.isCursorHidden ?? false;
}

describe("terminal replay snapshots", () => {
  test("retains rows painted before more than 512 KiB of footer-only updates", async () => {
    const replay = new TerminalReplay(40, 8);
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      await append(replay, "original first row\r\noriginal second row");
      const footer = "\x1b[7;1H\x1b[2Kworking";
      await append(replay, footer.repeat(Math.ceil((600 * 1024) / footer.length)));
      const state = await snapshot(replay);
      await write(restored, state.data);
      expect(lines(restored).slice(0, 2)).toEqual(["original first row", "original second row"]);
      expect(restored.buffer.active.getLine(restored.buffer.active.baseY + 6)!.translateToString(true)).toBe("working");
      await write(restored, " done");
      expect(restored.buffer.active.getLine(restored.buffer.active.baseY + 6)!.translateToString(true)).toBe("working done");
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  test("reuses snapshots until parsed output or actual geometry changes", async () => {
    const replay = new TerminalReplay(40, 8);
    const serializeSpy = spyOn(SerializeAddon.prototype, "serialize");
    try {
      await append(replay, "before");
      const first = await snapshot(replay);
      first.data = "caller mutation";
      const cached = await snapshot(replay);
      expect(cached.data).not.toBe("caller mutation");
      expect(cached).not.toBe(first);
      expect(serializeSpy).toHaveBeenCalledTimes(1);

      replay.resize(40, 8);
      const unchangedGeometry = await snapshot(replay);
      expect({ cols: unchangedGeometry.cols, rows: unchangedGeometry.rows }).toEqual({ cols: 40, rows: 8 });
      expect(serializeSpy).toHaveBeenCalledTimes(1);

      await append(replay, " after");
      const updated = await snapshot(replay);
      expect(updated.data).toContain("before after");
      expect(serializeSpy).toHaveBeenCalledTimes(2);

      replay.resize(80, 24);
      const resized = await snapshot(replay);
      expect({ cols: resized.cols, rows: resized.rows }).toEqual({ cols: 80, rows: 24 });
      expect(serializeSpy).toHaveBeenCalledTimes(3);
    } finally {
      serializeSpy.mockRestore();
      replay.dispose();
    }
  });

  test("keeps cached inline-image replay data until its marker is overwritten", async () => {
    const replay = new TerminalReplay(40, 8);
    try {
      await append(replay, "\x1b]1337;File=inline=1;width=1:YWJj\x07");
      const withImage = await snapshot(replay);
      expect(withImage.data).toContain("YWJj");
      expect((await snapshot(replay)).data).toBe(withImage.data);

      await append(replay, "x");
      const afterOverwrite = await snapshot(replay);
      expect(afterOverwrite.data).not.toContain("YWJj");
    } finally {
      replay.dispose();
    }
  });

  test("preserves a split escape sequence instead of exposing its payload", async () => {
    const replay = new TerminalReplay(40, 8);
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      await append(replay, "before\r\n\x1b]0;private");
      await append(replay, " title\x07after");
      await write(restored, (await snapshot(replay)).data);
      expect(lines(restored).slice(0, 2)).toEqual(["before", "after"]);
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  test("resolves historical geometry before taking the snapshot", async () => {
    const replay = new TerminalReplay(10, 5);
    const original = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    let restored: Terminal | undefined;
    try {
      const initial = "abcdefghijklmnop\r\nsecond row";
      await append(replay, initial);
      await write(original, initial);
      replay.resize(20, 7);
      original.resize(20, 7);
      const update = "\x1b[6;1Hfooter";
      await append(replay, update);
      await write(original, update);
      const state = await snapshot(replay);
      expect({ cols: state.cols, rows: state.rows }).toEqual({ cols: 20, rows: 7 });
      restored = new Terminal({ cols: state.cols, rows: state.rows, allowProposedApi: true });
      await write(restored, state.data);
      expect(lines(restored)).toEqual(lines(original));
      await write(restored, "!");
      await write(original, "!");
      expect(lines(restored)).toEqual(lines(original));
    } finally {
      replay.dispose();
      original.dispose();
      restored?.dispose();
    }
  });
  test("restores DECSTBM margins before live output in origin mode", async () => {
    const replay = new TerminalReplay(24, 5);
    const original = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
    let restored: Terminal | undefined;
    try {
      const initial =
        "\x1b[1;1Houtside top" +
        "\x1b[2;1Hfirst" +
        "\x1b[3;1Hsecond" +
        "\x1b[4;1Hthird" +
        "\x1b[5;1Houtside bottom" +
        "\x1b[2;4r\x1b[?6h\x1b[3;1H";
      await append(replay, initial);
      await write(original, initial);
      const state = await snapshot(replay);
      restored = new Terminal({ cols: state.cols, rows: state.rows, allowProposedApi: true });
      await write(restored, state.data);
      expect(lines(restored)).toEqual(lines(original));

      const update = "\r\nafter scroll";
      await append(replay, update);
      await write(original, update);
      await write(restored, update);
      expect(lines(restored)).toEqual(lines(original));
      expect(lines(restored)).toEqual(["outside top", "second", "third", "after scroll", "outside bottom"]);
    } finally {
      replay.dispose();
      original.dispose();
      restored?.dispose();
    }
  });

  for (const row of [1, 17, 34]) {
    for (const pendingRestore of [false, true]) {
      test(`image repaint preserves saved row ${row}, including a ${pendingRestore ? "pending" : "completed"} restore`, async () => {
        const replay = new TerminalReplay(40, 34);
        const original = new Terminal({ cols: 40, rows: 34, allowProposedApi: true });
        const restored = new Terminal({ cols: 40, rows: 34, allowProposedApi: true });
        try {
          // Native transcript repaint can request an image origin above the
          // viewport. CUU clamps; it is not the inverse of a later CUD.
          const image = `\x1b[${row};1H\x1b7\x1b[19A\x1b]1337;File=inline=1;width=5:YWJj\x07`;
          const before = image + (pendingRestore ? "" : "\x1b8");
          await append(replay, before);
          await write(original, before);
          await write(restored, (await snapshot(replay)).data);
          const continuation = (pendingRestore ? "\x1b8" : "") +
            Array.from({ length: 40 }, (_, i) => `\r\nline ${i}`).join("");
          await append(replay, continuation);
          await write(original, continuation);
          await write(restored, continuation);
          expect(lines(restored).map((line) => line.trimEnd())).toEqual(lines(original).map((line) => line.trimEnd()));
          expect(restored.buffer.active.cursorY).toBe(original.buffer.active.cursorY);
          await write(restored, (await snapshot(replay)).data);
          expect(lines(restored).map((line) => line.trimEnd())).toEqual(lines(original).map((line) => line.trimEnd()));
        } finally {
          replay.dispose();
          original.dispose();
          restored.dispose();
        }
      });
    }
  }

  test("preserves a hidden cursor in a restored snapshot", async () => {
    const replay = new TerminalReplay(40, 8);
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      await append(replay, "hidden cursor\x1b[?25l");
      const state = await snapshot(replay);
      expect(state.data).toContain("\x1b[?25l");
      await write(restored, state.data);
      expect(cursorHidden(restored)).toBe(true);
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  test("a producer left in synchronized output cannot block a new viewer", async () => {
    const replay = new TerminalReplay(40, 8);
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      await append(replay, "\x1b[?2026hvisible on reconnect");
      await write(restored, (await snapshot(replay)).data);
      expect(lines(restored)[0]).toBe("visible on reconnect");
      expect(restored.modes.synchronizedOutputMode).toBe(false);
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  test("continues a control sequence that straddles the snapshot boundary", async () => {
    const replay = new TerminalReplay(40, 8);
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      await append(replay, "before\r\n\x1b]0;private");
      await write(restored, (await snapshot(replay)).data);
      await write(restored, " title\x07after");
      expect(lines(restored).slice(0, 2)).toEqual(["before", "after"]);
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  test("fences a plain-text visible-screen projection without serializing history", async () => {
    const replay = new TerminalReplay(40, 3);
    const serializeSpy = spyOn(SerializeAddon.prototype, "serialize");
    try {
      const before = append(replay, "history-only\r\nscreen-one\r\nscreen-two\r\nscreen-three");
      const screenPromise = replay.screenSnapshot();
      const after = append(replay, "\r\nlater-only");

      const screen = await screenPromise;
      await Promise.all([before, after]);
      expect(screen.cols).toBe(40);
      expect(screen.rows).toBe(3);
      expect(screen.screen).toContain("screen-one");
      expect(screen.screen).not.toContain("history-only");
      expect(screen.screen).not.toContain("later-only");
      expect(screen.screen.split("\n")).toHaveLength(3);
      expect(serializeSpy).not.toHaveBeenCalled();
    } finally {
      serializeSpy.mockRestore();
      replay.dispose();
    }
  });

  test("image budget exhaustion preserves ordinary VT controls and split suffix text", async () => {
    const resources = new RuntimeResourceBudget({
      imageBytesPerRuntime: 0,
      imageBytesTotal: 0,
    }, 1);
    const lease = resources.createLease(40, 8);
    const replay = new TerminalReplay(40, 8, lease);
    try {
      await append(replay, "\x1b[31mred\x1b[0m\x1b]1337;File=inline=1;width=1:YWJj");
      await append(replay, "\x07after");
      const screen = await replay.screenSnapshot();
      expect(screen.screen).toContain("red");
      expect(screen.screen).toContain("after");
    } finally {
      replay.dispose();
      lease.release();
    }
  });

  for (const introduction of ["\x1bP0;1;0q", "\x900;1;0q"]) {
    test(`budgets parameterized Sixel across split headers ${JSON.stringify(introduction)}`, async () => {
      const resources = new RuntimeResourceBudget({
        imageBytesPerRuntime: 32,
        imageBytesTotal: 32,
      }, 1);
      const lease = resources.createLease(40, 8);
      const replay = new TerminalReplay(40, 8, lease);
      try {
        for (const character of introduction) await append(replay, character);
        await append(replay, "SIXEL-PAYLOAD");
        expect((await snapshot(replay)).data).toContain("SIXEL-PAYLOAD");
        await append(replay, "?".repeat(32));
        expect((await snapshot(replay)).data).not.toContain("SIXEL-PAYLOAD");
        await append(replay, "\x1b\\after");
        expect((await replay.screenSnapshot()).screen).toContain("after");
        expect(lease.reserveImage(32)).toBe(true);
        lease.releaseImage(32);
      } finally {
        replay.dispose();
        lease.release();
      }
    });
  }

  test("new attachments reflect scrollback trimmed by another runtime's grant", async () => {
    const resources = new RuntimeResourceBudget({
      replayRowsPerRuntime: 4,
      replayCellsTotal: 320,
    }, 2);
    const lease = resources.createLease(40, 2);
    const replay = new TerminalReplay(40, 2, lease);
    try {
      await append(replay, [
        "oldest-sentinel", "older-two", "older-three", "older-four", "recent-five", "latest-six",
      ].join("\r\n"));
      expect((await snapshot(replay)).data).toContain("oldest-sentinel");
      const other = resources.createLease(40, 2);
      try {
        const trimmed = await snapshot(replay);
        expect(trimmed.data).not.toContain("oldest-sentinel");
        expect(trimmed.data).toContain("latest-six");
      } finally {
        other.release();
      }
    } finally {
      replay.dispose();
      lease.release();
    }
  });

  test("retains the newest image when admission requires evicting an older sidecar", async () => {
    const first = "\x1b]1337;File=inline=1;width=1:YWJj\x07";
    const latest = "\x1b]1337;File=inline=1;width=1:ZGVm\x07";
    const limit = Math.ceil(Buffer.byteLength(first) * 1.5);
    const resources = new RuntimeResourceBudget({
      imageBytesPerRuntime: limit,
      imageBytesTotal: limit,
    }, 1);
    const lease = resources.createLease(40, 8);
    const replay = new TerminalReplay(40, 8, lease);
    try {
      await append(replay, first);
      expect((await snapshot(replay)).data).toContain(first);
      await append(replay, `\r\n${latest}`);
      const restored = await snapshot(replay);
      expect(restored.data).toContain(latest);
      expect(restored.data).not.toContain(first);
    } finally {
      replay.dispose();
      lease.release();
    }
  });
});
