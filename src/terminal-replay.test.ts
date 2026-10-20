import { describe, expect, spyOn, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
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
});
