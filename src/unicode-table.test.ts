import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

test("Unicode table cells retain their right border at the producer's column", async () => {
  const term = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
  try {
    // The addon uses only the Unicode service shared by browser and headless xterm.
    const addon = new UnicodeGraphemesAddon();
    addon.activate(term as unknown as Parameters<typeof addon.activate>[0]);
    const labels = ["plain", "🎮", "👨‍👩‍👧‍👦", "中文", "e\u0301", "❤️"];
    const lines = labels.map((label) => `│ ${label}${" ".repeat(21 - Bun.stringWidth(label))}│`);
    await new Promise<void>((resolve) => term.write("\x1b[?7l" + lines.join("\r\n"), resolve));
    for (let row = 0; row < labels.length; row++) {
      const line = term.buffer.active.getLine(row)!;
      expect(line.getCell(23)?.getChars()).toBe("│");
      expect(line.translateToString(true)).toBe(lines[row]);
    }
  } finally {
    term.dispose();
  }
});
