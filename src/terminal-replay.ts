import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/headless";
import { ReplayImages } from "./replay-images";
import type { RuntimeResourceLease } from "./resource-budget";
import type { RuntimeScreenSnapshot } from "./protocol";

const DEFAULT_SCROLLBACK_ROWS = 20_000;

type Snapshot = { data: string; cols: number; rows: number };
type ReplayTask =
  | { type: "write"; data: string; onParsed: () => void }
  | { type: "resize"; cols: number; rows: number }
  | { type: "snapshot"; callback: (snapshot: Snapshot) => void }
  | { type: "screen"; callback: (snapshot: RuntimeScreenSnapshot) => void };

type TerminalAttributes = {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isProtected?(): number;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
  getUnderlineStyle?(): number;
  isUnderlineColorDefault?(): boolean;
  isUnderlineColorRGB?(): boolean;
  isUnderlineColorPalette?(): boolean;
  getUnderlineColor?(): number;
};

type TerminalInternals = {
  _core?: {
    buffer?: {
      scrollTop?: number;
      scrollBottom?: number;
      tabs?: Record<string, boolean | undefined>;
      ybase?: number;
      savedX?: number;
      savedY?: number;
      savedCurAttrData?: TerminalAttributes;
    };
    buffers?: {
      normal?: { tabs?: Record<string, boolean | undefined> };
    };
    coreService?: {
      isCursorHidden?: boolean;
      decPrivateModes?: {
        cursorBlink?: boolean;
        cursorStyle?: "block" | "underline" | "bar";
      };
    };
    coreMouseService?: { activeEncoding?: string };
    _inputHandler?: { _curAttrData?: TerminalAttributes };
  };
};

/**
 * Ordered, headless mirror of the PTY stream. Snapshots are VT programs rather
 * than raw stream tails, so they remain replayable regardless of how many bytes
 * have passed through the mirror.
 */
export class TerminalReplay {
  readonly #terminal: Terminal;
  readonly #serializer: SerializeAddon;
  readonly #images: ReplayImages;
  readonly #resources?: RuntimeResourceLease;
  // Reuse expensive scrollback serialization until parsed output or geometry changes.
  #snapshotCache: Snapshot | undefined;
  #snapshotCacheBytes = 0;
  #tasks: (ReplayTask | undefined)[] = [];
  #taskIndex = 0;
  #running = false;
  #disposed = false;
  #screenRejectors = new Set<(error: Error) => void>();

  constructor(cols: number, rows: number, resources?: RuntimeResourceLease) {
    this.#resources = resources;
    this.#terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cols,
      rows,
      scrollback: resources?.scrollbackRows ?? DEFAULT_SCROLLBACK_ROWS,
    });
    this.#images = new ReplayImages(this.#terminal, resources);
    resources?.setScrollbackHandler((scrollback) => {
      this.#invalidateSnapshot();
      this.#terminal.options.scrollback = scrollback;
    });

    const unicode = new UnicodeGraphemesAddon();
    this.#terminal.loadAddon(unicode as unknown as Parameters<Terminal["loadAddon"]>[0]);

    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
  }

  /** Parse bytes before notifying subscribers that those bytes are visible. */
  append(data: string, onParsed: () => void): void {
    if (this.#disposed) return;
    this.#enqueue({ type: "write", data, onParsed });
  }

  /** Resize only after every earlier PTY write has reached the parser. */
  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    this.#enqueue({ type: "resize", cols, rows });
  }

  /** Fence earlier writes and serialize at that exact parser boundary.
   * Synchronized-output mode is transient and must not stall a new client
   * when a producer stops before committing its frame. */
  snapshot(callback: (snapshot: Snapshot) => void): void {
    if (this.#disposed) return;
    this.#enqueue({ type: "snapshot", callback });
  }

  /** Fence parsed output and project only the active buffer's visible rows. */
  screenSnapshot(): Promise<RuntimeScreenSnapshot> {
    if (this.#disposed) return Promise.reject(new Error("terminal replay disposed"));
    const { promise, resolve, reject } = Promise.withResolvers<RuntimeScreenSnapshot>();
    const rejectOnce = (error: Error): void => {
      this.#screenRejectors.delete(rejectOnce);
      reject(error);
    };
    this.#screenRejectors.add(rejectOnce);
    this.#enqueue({
      type: "screen",
      callback: (snapshot) => {
        this.#screenRejectors.delete(rejectOnce);
        resolve(snapshot);
      },
    });
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tasks = [];
    this.#taskIndex = 0;
    this.#running = false;
    for (const reject of this.#screenRejectors) reject(new Error("terminal replay disposed"));
    this.#screenRejectors.clear();
    this.#invalidateSnapshot();
    this.#images.dispose();
    this.#resources?.setScrollbackHandler(undefined);
    this.#terminal.dispose();
  }

  #enqueue(task: ReplayTask): void {
    this.#tasks.push(task);
    this.#drain();
  }

  #drain(): void {
    if (this.#running || this.#disposed) return;


    while (true) {
      const task = this.#tasks[this.#taskIndex];
      if (!task) {
        this.#tasks = [];
        this.#taskIndex = 0;
        return;
      }
      this.#tasks[this.#taskIndex] = undefined;
      this.#taskIndex += 1;
      if (this.#taskIndex >= 512 && this.#taskIndex * 2 >= this.#tasks.length) {
        this.#tasks = this.#tasks.slice(this.#taskIndex);
        this.#taskIndex = 0;
      }

      if (task.type === "resize") {
        if (task.cols !== this.#terminal.cols || task.rows !== this.#terminal.rows) {
          if (this.#resources && !this.#resources.setGeometry(task.cols, task.rows)) continue;
          this.#invalidateSnapshot();
          this.#terminal.resize(task.cols, task.rows);
        }
        continue;
      }
      if (task.type === "snapshot") {
        this.#writeSnapshotFence(task);
        return;
      }
      if (task.type === "screen") {
        this.#writeScreenFence(task);
        return;
      }

      this.#invalidateSnapshot();
      const data = this.#images.prepare(task.data);
      this.#running = true;
      this.#terminal.write(data, () => {
        if (this.#disposed) return;
        try {
          this.#images.prune();
          task.onParsed();
        } finally {
          this.#finishTask();
        }
      });
      return;
    }
  }

  #writeSnapshotFence(task: Extract<ReplayTask, { type: "snapshot" }>): void {
    this.#running = true;
    this.#terminal.write("", () => {
      if (this.#disposed) return;
      try {
        task.callback(this.#takeSnapshot());
      } finally {
        this.#finishTask();
      }
    });
  }

  #writeScreenFence(task: Extract<ReplayTask, { type: "screen" }>): void {
    this.#running = true;
    this.#terminal.write("", () => {
      if (this.#disposed) return;
      try {
        const terminal = this.#terminal;
        const buffer = terminal.buffer.active;
        const lines = new Array<string>(terminal.rows);
        for (let row = 0; row < terminal.rows; row += 1) {
          lines[row] = buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? "";
        }
        task.callback({ cols: terminal.cols, rows: terminal.rows, screen: lines.join("\n") });
      } finally {
        this.#finishTask();
      }
    });
  }

  #finishTask(): void {
    this.#running = false;
    this.#drain();
  }

  #invalidateSnapshot(): void {
    if (!this.#snapshotCache) return;
    this.#resources?.releaseSnapshot(this.#snapshotCacheBytes);
    this.#snapshotCache = undefined;
    this.#snapshotCacheBytes = 0;
  }

  #takeSnapshot(): Snapshot {
    if (this.#snapshotCache) return { ...this.#snapshotCache };

    const terminal = this.#terminal;
    const internal = (terminal as unknown as TerminalInternals)._core;
    const serialized = this.#serializer.serialize({ scrollback: this.#resources?.scrollbackRows ?? DEFAULT_SCROLLBACK_ROWS });
    const data =
      "\x1bc" +
      this.#tabStopsSequence(internal?.buffers?.normal?.tabs, false) +
      this.#images.restore(serialized) +
      this.#images.pendingImageData() +
      this.#mouseEncodingSequence() +
      this.#scrollRegionSequence() +
      this.#tabStopsSequence(internal?.buffer?.tabs, terminal.modes.originMode) +
      this.#cursorStyleSequence() +
      this.#savedCursorSequence() +
      this.#cursorPositionSequence() +
      this.#cursorVisibilitySequence() +
      this.#images.pendingSequence();
    const snapshot = { data, cols: terminal.cols, rows: terminal.rows };
    const bytes = Buffer.byteLength(data);
    if (!this.#resources || this.#resources.reserveSnapshot(bytes)) {
      this.#snapshotCache = snapshot;
      this.#snapshotCacheBytes = this.#resources ? bytes : 0;
    }
    return { ...snapshot };
  }


  /** Restore DECSTBM before origin-mode cursor positioning. */
  #scrollRegionSequence(): string {
    const terminal = this.#terminal;
    const buffer = (terminal as unknown as TerminalInternals)._core?.buffer;
    const top = buffer?.scrollTop ?? 0;
    const bottom = buffer?.scrollBottom ?? terminal.rows - 1;
    let sequence = terminal.modes.originMode ? "\x1b[?6l" : "";
    sequence += `\x1b[${top + 1};${bottom + 1}r`;
    if (terminal.modes.originMode) sequence += "\x1b[?6h";
    return sequence;
  }

  /** Serialize DECSCUSR, which addon-serialize does not currently include. */
  #cursorStyleSequence(): string {
    const terminal = this.#terminal;
    const modes = (terminal as unknown as TerminalInternals)._core?.coreService?.decPrivateModes;
    if (!modes || (modes.cursorStyle === undefined && modes.cursorBlink === undefined)) {
      return "\x1b[0 q";
    }

    const style = modes.cursorStyle ?? terminal.options.cursorStyle;
    const blinking = modes.cursorBlink ?? terminal.options.cursorBlink;
    const shape = style === "underline" ? 3 : style === "bar" ? 5 : 1;
    return `\x1b[${shape + (blinking ? 0 : 1)} q`;
  }

  /** addon-serialize restores mouse tracking but omits its coordinate encoding. */
  #mouseEncodingSequence(): string {
    const encoding = (this.#terminal as unknown as TerminalInternals)._core?.coreMouseService?.activeEncoding;
    if (encoding === "SGR") return "\x1b[?1006h";
    if (encoding === "SGR_PIXELS") return "\x1b[?1016h";
    return "";
  }
  #savedCursorSequence(): string {
    const terminal = this.#terminal;
    const internal = (terminal as unknown as TerminalInternals)._core;
    const buffer = internal?.buffer;
    const savedAttributes = buffer?.savedCurAttrData;
    const currentAttributes = internal?._inputHandler?._curAttrData;
    if (
      buffer?.savedX === undefined ||
      buffer.savedY === undefined ||
      buffer.ybase === undefined ||
      !savedAttributes ||
      !currentAttributes
    ) {
      return "";
    }

    const savedRow = Math.max(1, Math.min(terminal.rows, buffer.savedY - buffer.ybase + 1));
    const savedCol = Math.max(1, Math.min(terminal.cols, buffer.savedX + 1));
    const restoreOrigin = terminal.modes.originMode;
    let sequence = restoreOrigin ? "\x1b[?6l" : "";
    sequence += this.#attributeSequence(savedAttributes);
    sequence += `\x1b[${savedRow};${savedCol}H\x1b7`;
    if (restoreOrigin) sequence += "\x1b[?6h";
    return sequence + this.#attributeSequence(currentAttributes);
  }

  /** Encode an xterm attribute state as SGR for a saved cursor register. */
  #attributeSequence(attributes: TerminalAttributes): string {
    const parameters: (number | string)[] = [0];
    if (attributes.isBold()) parameters.push(1);
    if (attributes.isDim()) parameters.push(2);
    if (attributes.isItalic()) parameters.push(3);

    const underlineStyle = attributes.getUnderlineStyle?.() ?? (attributes.isUnderline() ? 1 : 0);
    if (underlineStyle > 0) {
      parameters.push(underlineStyle === 1 ? 4 : `4:${underlineStyle}`);
    }
    if (attributes.isBlink()) parameters.push(5);
    if (attributes.isInverse()) parameters.push(7);
    if (attributes.isInvisible()) parameters.push(8);
    if (attributes.isStrikethrough()) parameters.push(9);
    if (attributes.isOverline()) parameters.push(53);

    if (attributes.isFgRGB()) {
      const color = attributes.getFgColor();
      parameters.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    } else if (attributes.isFgPalette()) {
      parameters.push(38, 5, attributes.getFgColor());
    }
    if (attributes.isBgRGB()) {
      const color = attributes.getBgColor();
      parameters.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    } else if (attributes.isBgPalette()) {
      parameters.push(48, 5, attributes.getBgColor());
    }
    if (attributes.isUnderline() && attributes.isUnderlineColorDefault?.() === false) {
      const color = attributes.getUnderlineColor?.() ?? 0;
      if (attributes.isUnderlineColorRGB?.()) {
        parameters.push(58, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
      } else if (attributes.isUnderlineColorPalette?.()) {
        parameters.push(58, 5, color);
      }
    }

    let sequence = `\x1b[0"q\x1b[${parameters.join(";")}m`;
    if (attributes.isProtected?.()) sequence += "\x1b[1\"q";
    return sequence;
  }

  /** Recreate tab stops for a buffer while leaving its cursor at its origin. */
  #tabStopsSequence(
    tabs: Record<string, boolean | undefined> | undefined,
    restoreOrigin: boolean,
  ): string {
    const terminal = this.#terminal;
    if (!tabs) return "";

    let sequence = restoreOrigin ? "\x1b[?6l" : "";
    sequence += "\x1b[3g";
    for (const [column, enabled] of Object.entries(tabs)) {
      const index = Number(column);
      if (enabled && index >= 0 && index < terminal.cols) {
        sequence += `\x1b[1;${index + 1}H\x1bH`;
      }
    }
    sequence += "\x1b[H";
    if (restoreOrigin) sequence += "\x1b[?6h";
    return sequence;
  }

  /** addon-serialize does not preserve DECTCEM cursor visibility. */
  #cursorVisibilitySequence(): string {
    const hidden = (this.#terminal as unknown as TerminalInternals)._core?.coreService?.isCursorHidden;
    return hidden ? "\x1b[?25l" : "\x1b[?25h";
  }

  /** Restore the cursor after mode/scroll-region sequences, which may home it. */
  #cursorPositionSequence(): string {
    const terminal = this.#terminal;
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.cursorY + 1;
    const internal = (terminal as unknown as TerminalInternals)._core;
    const scrollTop = internal?.buffer?.scrollTop ?? 0;
    const originRow = terminal.modes.originMode ? buffer.cursorY - scrollTop + 1 : cursorRow;
    const row = Math.max(1, Math.min(terminal.rows, originRow));
    if (buffer.cursorX === terminal.cols && terminal.modes.wraparoundMode) {
      const absoluteRow = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(absoluteRow);
      let column = terminal.cols - 1;
      let cell = line?.getCell(column);
      if (cell?.getWidth() === 0) {
        column--;
        cell = line?.getCell(column);
      }
      if (cell) {
        const currentAttributes = internal?._inputHandler?._curAttrData;
        const chars = cell.getChars() || " ";
        let sequence = terminal.modes.insertMode ? "\x1b[4l" : "";
        sequence += `\x1b[${row};${column + 1}H`;
        sequence += this.#attributeSequence(cell as unknown as TerminalAttributes) + chars;
        if (currentAttributes) sequence += this.#attributeSequence(currentAttributes);
        if (terminal.modes.insertMode) sequence += "\x1b[4h";
        return sequence;
      }
    }
    const col = Math.max(1, Math.min(terminal.cols, buffer.cursorX + 1));
    return `\x1b[${row};${col}H`;
  }
}
