import type { Terminal } from "@xterm/headless";

type SequenceKind = "escape" | "csi" | "osc" | "dcs" | "string";
type ScannerState = "ground" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";

const ESC = "\x1b";
const BEL = "\x07";
const CSI = `${ESC}[`;
const CURSOR_LEFT = `${CSI}1D`;
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const MARKER_RANGES: readonly [number, number][] = [
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd]
];

/** Streams complete VT controls while retaining only the one unfinished control. */
class VtSequenceScanner {
  private state: ScannerState = "ground";
  private kind: SequenceKind | undefined;
  private stringIsOsc = false;
  private parts: string[] = [];
  private pendingLength = 0;
  private overflow = false;

  feed(data: string, onText: (text: string) => void, onSequence: (kind: SequenceKind, sequence: string) => void): void {
    let index = 0;
    let textStart = 0;
    let sequenceStart = this.state === "ground" ? -1 : 0;

    while (index < data.length) {
      if (this.state === "ground") {
        const ch = data[index];
        let kind: SequenceKind | undefined;
        let nextState: ScannerState | undefined;

        if (ch === ESC) {
          kind = "escape";
          nextState = "escape";
        } else if (ch === "\x9b") {
          kind = "csi";
          nextState = "csi";
        } else if (ch === "\x9d") {
          kind = "osc";
          nextState = "string";
          this.stringIsOsc = true;
        } else if (ch === "\x90") {
          kind = "dcs";
          nextState = "string";
        } else if (ch === "\x98" || ch === "\x9e" || ch === "\x9f") {
          kind = "string";
          nextState = "string";
        }

        if (kind && nextState) {
          if (textStart < index) onText(data.slice(textStart, index));
          this.parts = [];
          this.kind = kind;
          this.state = nextState;
          sequenceStart = index;
          index += 1;
          textStart = index;
          continue;
        }

        index += 1;
        continue;
      }

      const ch = data[index];
      const code = data.charCodeAt(index);
      let complete = false;
      let restartAtEscape = false;

      switch (this.state) {
        case "escape":
          if (ch === "[") {
            this.kind = "csi";
            this.state = "csi";
          } else if (ch === "]") {
            this.kind = "osc";
            this.stringIsOsc = true;
            this.state = "string";
          } else if (ch === "P") {
            this.kind = "dcs";
            this.stringIsOsc = false;
            this.state = "string";
          } else if (ch === "X" || ch === "^" || ch === "_") {
            this.kind = "string";
            this.stringIsOsc = false;
            this.state = "string";
          } else if (code >= 0x20 && code <= 0x2f) {
            this.state = "escape-intermediate";
          } else if (ch === ESC) {
            complete = true;
            restartAtEscape = true;
          } else {
            complete = true;
          }
          break;
        case "escape-intermediate":
          if (ch === ESC) {
            complete = true;
            restartAtEscape = true;
          } else if (code >= 0x30 && code <= 0x7e) {
            complete = true;
          }
          break;
        case "csi":
          if (ch === ESC) {
            complete = true;
            restartAtEscape = true;
          } else if ((code >= 0x40 && code <= 0x7e) || ch === "\x18" || ch === "\x1a") {
            complete = true;
          }
          break;
        case "string":
          if (ch === "\x9c" || (this.stringIsOsc && ch === BEL) || ch === "\x18" || ch === "\x1a") {
            complete = true;
          } else if (ch === ESC) {
            this.state = "string-escape";
          }
          break;
        case "string-escape":
          if (ch === "\\" || ch === "\x9c" || (this.stringIsOsc && ch === BEL) || ch === "\x18" || ch === "\x1a") {
            complete = true;
          } else if (ch !== ESC) {
            this.state = "string";
          }
          break;
      }

      if (restartAtEscape) {
        this.appendPart(data.slice(sequenceStart, index));
        if (!this.overflow) onSequence(this.kind!, this.parts.join(""));
        this.reset();
        sequenceStart = index;
        this.kind = "escape";
        this.state = "escape";
        this.parts = [];
        index += 1;
        textStart = index;
        continue;
      }

      if (complete) {
        this.appendPart(data.slice(sequenceStart, index + 1));
        if (!this.overflow) onSequence(this.kind!, this.parts.join(""));
        this.reset();
        index += 1;
        textStart = index;
        sequenceStart = -1;
        continue;
      }

      index += 1;
    }

    if (this.state === "ground") {
      if (textStart < data.length) onText(data.slice(textStart));
    } else {
      if (sequenceStart < 0) sequenceStart = 0;
      if (sequenceStart < data.length) this.appendPart(data.slice(sequenceStart));
    }
  }

  pendingSuffix(): string {
    // An oversized unfinished control is discarded, but a joining client still
    // needs to consume its future suffix as a control string, not visible text.
    if (this.overflow) {
      if (this.kind === "osc") return `${ESC}]0;`;
      if (this.kind === "dcs") return `${ESC}P0z`;
      return this.kind === "csi" ? CSI : ESC;
    }
    return this.parts.join("");
  }

  clear(): void {
    this.state = "ground";
    this.kind = undefined;
    this.stringIsOsc = false;
    this.parts = [];
    this.pendingLength = 0;
    this.overflow = false;
  }

  private reset(): void {
    this.state = "ground";
    this.kind = undefined;
    this.stringIsOsc = false;
    this.parts = [];
    this.pendingLength = 0;
    this.overflow = false;
  }

  private appendPart(part: string): void {
    if (this.overflow) return;
    this.pendingLength += part.length;
    if (this.pendingLength > MAX_SIDECAR_BYTES) {
      this.overflow = true;
      this.parts = [];
      return;
    }
    this.parts.push(part);
  }
}

interface ReplayImage {
  payload: string;
  reservedRows: number;
  bytes: number;
}

interface DeferredImage {
  marker: string;
}

/**
 * Holds inline-image sidecars next to printable headless-buffer markers. OMP
 * reserves image rows before emitting OSC 1337 or Sixel, so the marker is placed
 * on the reservation's last row and replay draws upward into already-written rows.
 */
export class ReplayImages {
  private readonly scanner = new VtSequenceScanner();
  private readonly images = new Map<string, ReplayImage>();
  private readonly pendingMarkers = new Set<string>();
  private readonly allocatedMarkers = new Set<string>();
  private readonly userPrivateUse = new Set<string>();
  private markerCodePoint = 0x10fffd;
  private markerSpaceExhausted = false;
  private recycledMarkers: string[] = [];
  private recycledMarkerIndex = 0;
  private sidecarBytes = 0;
  private needsPrune = false;
  private savedCursorActive = false;
  /** Saved cursor row minus the current row. */
  private savedRowOffset = 0;
  private deferredRestore: DeferredImage | undefined;

  constructor(private readonly terminal?: Terminal) {}

  /** Replaces OSC 1337 inline images and Sixel DCS images with cell markers. */
  prepare(data: string): string {
    if (this.markerSpaceExhausted) {
      this.recycledMarkers = [];
      this.recycledMarkerIndex = 0;
    }

    const output: string[] = [];
    this.scanner.feed(
      data,
      (text) => {
        this.rememberPrivateUseText(text);
        this.flushDeferredAtCurrentPosition(output);
        output.push(text);
      },
      (kind, sequence) => this.processSequence(kind, sequence, output)
    );
    return output.join("");
  }

  /** Expands markers at their serialized cell positions, never at the snapshot tail. */
  restore(data: string): string {
    const counts = new Map<string, number>();
    for (const character of data) {
      if (this.images.has(character)) counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    const retained = new Set<string>();
    const output: string[] = [];
    for (const character of data) {
      const image = this.images.get(character);
      if (image && counts.get(character) === 1) {
        retained.add(character);
        // Blank the marker, save the cell before it, move to the image origin,
        // draw, then restore the serializer cursor after the reserved cell.
        output.push(" ", CURSOR_LEFT, ESC, "7");
        if (image.reservedRows > 0) output.push(`${CSI}${image.reservedRows}A`);
        output.push(image.payload, ESC, "8", `${CSI}1C`);
      } else if (image || this.allocatedMarkers.has(character)) {
        output.push(" ");
      } else {
        output.push(character);
      }
    }

    if (this.terminal) {
      this.pendingMarkers.clear();
      this.pruneLiveMarkers();
      this.needsPrune = false;
    } else {
      for (const marker of this.images.keys()) {
        if (!retained.has(marker) && marker !== this.deferredRestore?.marker) this.forgetImage(marker);
      }
    }
    return output.join("");
  }

  /** Prune on image writes; snapshots also prune erased cells. Footer redraws
   * must not scan the entire scrollback on every erase-line control. */
  prune(): void {
    if (!this.needsPrune) return;
    this.pendingMarkers.clear();
    this.pruneLiveMarkers();
    this.needsPrune = false;
  }

  /** Clears sidecars and parser state when the mirrored terminal is reset. */
  reset(): void {
    this.images.clear();
    this.pendingMarkers.clear();
    this.sidecarBytes = 0;
    this.needsPrune = false;
    this.scanner.clear();
    this.savedCursorActive = false;
    this.savedRowOffset = 0;
    this.deferredRestore = undefined;
  }

  /** Releases all retained marker state when the mirror is disposed. */
  dispose(): void {
    this.reset();
    this.allocatedMarkers.clear();
    this.recycledMarkers = [];
    this.recycledMarkerIndex = 0;
  }

  /** Image replay bytes for insertion before the engine restores final modes/cursor. */
  pendingImageData(): string {
    const image = this.deferredRestore && this.images.get(this.deferredRestore.marker);
    return image ? this.rebuildSavedCursor() + image.payload : "";
  }
  /** The exact unfinished parser bytes; append these after terminal state restoration. */
  pendingSequence(): string {
    return this.scanner.pendingSuffix();
  }


  private processSequence(kind: SequenceKind, sequence: string, output: string[]): void {
    if (this.deferredRestore) {
      if (kind === "escape" && sequence === `${ESC}8`) {
        if (this.images.has(this.deferredRestore.marker)) {
          output.push(sequence, ESC, "7", this.deferredRestore.marker, ESC, "8");
        } else {
          output.push(sequence);
        }
        this.deferredRestore = undefined;
        this.savedCursorActive = false;
        this.savedRowOffset = 0;
        return;
      }
      this.flushDeferredAtCurrentPosition(output);
    }

    if ((kind === "osc" && isInlineImage(sequence)) || (kind === "dcs" && isSixelImage(sequence))) {
      const reservedRows = this.savedCursorActive && this.savedRowOffset > 0 ? this.savedRowOffset : 0;
      const marker = this.rememberImage(sequence, reservedRows);
      if (!marker) {
        output.push(" ", CURSOR_LEFT);
        return;
      }

      if (reservedRows > 0) {
        // Keep the mirror cursor at the image origin and reconstruct its saved
        // row after writing a blank underlay in place of the omitted image.
        output.push(ESC, "7", " ", ESC, "8", `${CSI}${reservedRows}B`, ESC, "7", `${CSI}${reservedRows}A`);
        this.deferredRestore = { marker };
      } else {
        output.push(marker, CURSOR_LEFT);
      }
      return;
    }

    output.push(sequence);
    if (kind === "escape" && sequence === `${ESC}7`) {
      this.savedCursorActive = true;
      this.savedRowOffset = 0;
      return;
    }
    if (kind === "escape" && sequence === `${ESC}8`) {
      this.savedCursorActive = false;
      this.savedRowOffset = 0;
      return;
    }

    if (kind === "csi") {
      const final = sequence[sequence.length - 1];
      if (final === "p" && sequence.includes("!")) {
        this.reset();
        return;
      }
      if (this.savedCursorActive) this.savedRowOffset += cursorRowMovement(sequence);
    } else if (kind === "escape" && sequence === `${ESC}c`) {
      this.reset();
    }
  }

  private flushDeferredAtCurrentPosition(output: string[]): void {
    if (!this.deferredRestore) return;
    const image = this.images.get(this.deferredRestore.marker);
    if (image) {
      image.reservedRows = 0;
      // A non-DECRC token followed the image. Anchor it at the current OSC row.
      output.push(this.deferredRestore.marker, CURSOR_LEFT);
    }
    this.deferredRestore = undefined;
  }

  private rebuildSavedCursor(): string {
    if (!this.savedCursorActive || this.savedRowOffset === 0) return `${ESC}7`;
    if (this.savedRowOffset > 0) {
      return `${ESC}7${CSI}${this.savedRowOffset}B${ESC}7${CSI}${this.savedRowOffset}A`;
    }
    const rows = -this.savedRowOffset;
    return `${ESC}7${CSI}${rows}A${ESC}7${CSI}${rows}B`;
  }

  private rememberImage(payload: string, reservedRows: number): string | undefined {
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_SIDECAR_BYTES) return undefined;
    if (this.sidecarBytes + bytes > MAX_SIDECAR_BYTES && this.pendingMarkers.size === 0) {
      this.pruneLiveMarkers();
    }

    while (this.sidecarBytes + bytes > MAX_SIDECAR_BYTES) {
      const oldest = this.images.keys().next().value as string | undefined;
      if (oldest === undefined) return undefined;
      this.forgetImage(oldest);
    }

    const marker = this.allocateMarker();
    this.images.set(marker, { payload, reservedRows, bytes });
    this.pendingMarkers.add(marker);
    this.sidecarBytes += bytes;
    this.needsPrune = true;
    return marker;
  }

  private forgetImage(marker: string): void {
    const image = this.images.get(marker);
    if (!image) return;
    this.sidecarBytes -= image.bytes;
    this.images.delete(marker);
    this.pendingMarkers.delete(marker);
    if (this.deferredRestore?.marker === marker) this.deferredRestore = undefined;
  }

  private pruneLiveMarkers(): void {
    if (!this.terminal || this.images.size === 0) return;
    const live = new Set<string>();
    this.collectLiveMarkers(this.terminal.buffer.normal, live);
    this.collectLiveMarkers(this.terminal.buffer.alternate, live);

    for (const marker of this.images.keys()) {
      if (!live.has(marker) && marker !== this.deferredRestore?.marker) this.forgetImage(marker);
    }
  }

  private collectLiveMarkers(buffer: Terminal["buffer"]["active"], live: Set<string>): void {
    const cell = buffer.getNullCell();
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      for (let x = 0; x < line.length; x += 1) {
        const chars = line.getCell(x, cell)?.getChars();
        if (chars && this.images.has(chars)) live.add(chars);
      }
    }
  }

  private rememberPrivateUseText(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const first = text.charCodeAt(index);
      if (first >= 0xe000 && first <= 0xf8ff) {
        this.userPrivateUse.add(text[index]);
        continue;
      }
      if (first < 0xd800 || first > 0xdbff || index + 1 >= text.length) continue;

      const second = text.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) continue;
      const codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      if ((codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
          (codePoint >= 0x100000 && codePoint <= 0x10fffd)) {
        this.userPrivateUse.add(String.fromCodePoint(codePoint));
      }
      index += 1;
    }
  }

  private allocateMarker(): string {
    while (!this.markerSpaceExhausted) {
      const codePoint = this.markerCodePoint;
      this.markerCodePoint = nextMarkerCodePoint(codePoint);
      if (codePoint === 0xe000) this.markerSpaceExhausted = true;
      const marker = String.fromCodePoint(codePoint);
      if (this.userPrivateUse.has(marker)) continue;
      this.allocatedMarkers.add(marker);
      return marker;
    }

    if (this.recycledMarkerIndex >= this.recycledMarkers.length) this.rebuildAvailableMarkers();
    const marker = this.recycledMarkers[this.recycledMarkerIndex++];
    if (!marker) throw new Error("inline image marker space exhausted");
    this.allocatedMarkers.add(marker);
    return marker;
  }

  private rebuildAvailableMarkers(): void {
    const occupied = new Set<string>();
    if (this.terminal) {
      this.collectPrivateUseCells(this.terminal.buffer.normal, occupied);
      this.collectPrivateUseCells(this.terminal.buffer.alternate, occupied);
    }
    for (const marker of this.images.keys()) occupied.add(marker);
    for (const marker of this.userPrivateUse) occupied.add(marker);

    this.recycledMarkers = [];
    this.recycledMarkerIndex = 0;
    for (const [start, end] of MARKER_RANGES) {
      for (let codePoint = start; codePoint <= end; codePoint += 1) {
        const marker = String.fromCodePoint(codePoint);
        if (!occupied.has(marker)) this.recycledMarkers.push(marker);
      }
    }
  }

  private collectPrivateUseCells(buffer: Terminal["buffer"]["active"], occupied: Set<string>): void {
    const cell = buffer.getNullCell();
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      for (let x = 0; x < line.length; x += 1) {
        const chars = line.getCell(x, cell)?.getChars();
        const codePoint = chars?.codePointAt(0);
        if (chars && codePoint !== undefined) {
          for (const [start, end] of MARKER_RANGES) {
            if (codePoint >= start && codePoint <= end) {
              occupied.add(chars);
              break;
            }
          }
        }
      }
    }
  }
}

function isInlineImage(sequence: string): boolean {
  const start = sequence.startsWith(`${ESC}]1337;`) ? 7 : sequence.startsWith("\x9d1337;") ? 6 : 0;
  if (start === 0) return false;
  const separator = sequence.indexOf(":", start);
  if (separator < 0) return false;
  const header = sequence.slice(start, separator);
  return header.startsWith("File=") && header.slice(5).split(";").includes("inline=1");
}

function isSixelImage(sequence: string): boolean {
  const prefixLength = sequence.startsWith(`${ESC}P`) ? 2 : sequence.startsWith("\x90") ? 1 : 0;
  if (prefixLength === 0) return false;
  for (let index = prefixLength; index < sequence.length; index += 1) {
    const code = sequence.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return sequence[index] === "q";
  }
  return false;
}

function cursorRowMovement(sequence: string): number {
  const final = sequence[sequence.length - 1];
  if (final !== "A" && final !== "B") return 0;
  const prefixLength = sequence.startsWith(ESC) ? 2 : 1;
  const parameters = sequence.slice(prefixLength, -1);
  if (!/^[0-9;]*$/.test(parameters)) return 0;
  const first = parameters.split(";", 1)[0];
  const amount = first === "" || first === "0" ? 1 : Number(first);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return final === "A" ? amount : -amount;
}

function nextMarkerCodePoint(codePoint: number): number {
  if (codePoint === 0x100000) return 0xffffd;
  if (codePoint === 0xf0000) return 0xf8ff;
  if (codePoint === 0xe000) return codePoint;
  return codePoint - 1;
}

