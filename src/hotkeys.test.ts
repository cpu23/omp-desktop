import { describe, expect, test } from "bun:test";
import {
  parseShortcutSetting,
  ShortcutMatcher,
  shortcutStrokeForEvent,
  validateShortcutBindings,
} from "./hotkeys";

describe("desktop shortcut settings", () => {
  test("parses chords, alternatives, and bounded multi-stroke sequences", () => {
    expect(parseShortcutSetting("Ctrl+K, Ctrl+1; Meta+Shift+ArrowUp")).toEqual({
      sequences: [["Ctrl+K", "Ctrl+1"], ["Meta+Shift+ArrowUp"]],
    });
    expect(parseShortcutSetting("")).toEqual({ sequences: [] });
  });

  test("requires a modified first press and limits sequence length", () => {
    expect(parseShortcutSetting("K, Ctrl+1").sequences).toEqual([]);
    expect(parseShortcutSetting("Ctrl+K, 1").sequences).toEqual([["Ctrl+K", "1"]]);
    expect(parseShortcutSetting("Ctrl+K, Ctrl+1, Ctrl+2, Ctrl+3").sequences)
      .toEqual([["Ctrl+K", "Ctrl+1", "Ctrl+2", "Ctrl+3"]]);
    expect(parseShortcutSetting("Ctrl+K, Ctrl+1, Ctrl+2, Ctrl+3, Ctrl+4").sequences).toEqual([]);
  });

  test("reports identical bindings as conflicts and permits cleared actions", () => {
    const validation = validateShortcutBindings({
      splitLayout: "Ctrl+K",
      closePane: "Ctrl+K",
      togglePaneFocus: "",
    });
    expect(validation.errors).toHaveLength(1);
  });
});

describe("shortcut sequence matching", () => {
  test("consumes every stroke and dispatches only a complete sequence", () => {
    const matcher = new ShortcutMatcher({ selectSpace1: "Ctrl+K, Ctrl+1" });
    expect(matcher.match("Ctrl+K", 10)).toEqual({ consumed: true, actions: [], pending: true });
    expect(matcher.match("Ctrl+1", 20)).toEqual({
      consumed: true,
      actions: ["selectSpace1"],
      pending: false,
    });
  });

  test("resolves a direct shortcut sharing a sequence prefix on timeout or mismatch", () => {
    const matcher = new ShortcutMatcher({
      splitLayout: "Ctrl+K",
      selectSpace1: "Ctrl+K, Ctrl+1",
    }, 50);
    expect(matcher.match("Ctrl+K", 100).pending).toBe(true);
    expect(matcher.expire(149)).toEqual([]);
    expect(matcher.expire(150)).toEqual(["splitLayout"]);

    expect(matcher.match("Ctrl+K", 200).pending).toBe(true);
    expect(matcher.match("x", 210)).toEqual({ consumed: false, actions: ["splitLayout"], pending: false });
  });

  test("does not dispatch repeats and still consumes repeated shortcut keys", () => {
    const matcher = new ShortcutMatcher({ closePane: "Ctrl+Shift+X" });
    expect(matcher.match("Ctrl+Shift+X", 10, true)).toEqual({ consumed: true, actions: [], pending: false });
    expect(matcher.match("Ctrl+Shift+X", 20)).toEqual({ consumed: true, actions: ["closePane"], pending: false });
  });

  test("normalizes keyboard event modifiers and shifted letters", () => {
    expect(shortcutStrokeForEvent({ key: "K", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }))
      .toBe("Ctrl+K");
    expect(shortcutStrokeForEvent({ key: "E", ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }))
      .toBe("Meta+Shift+E");
    expect(parseShortcutSetting("Ctrl+Plus").sequences).toEqual([["Ctrl+Shift+="]]);
    expect(shortcutStrokeForEvent({ key: "+", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }))
      .toBe("Ctrl+Shift+=");
  });
});
