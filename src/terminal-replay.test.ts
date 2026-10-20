import { describe, expect, test } from "bun:test";
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
