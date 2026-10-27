import type { Terminal } from "@xterm/headless";
import type { RuntimeResourceLease } from "./resource-budget";

type SequenceKind = "escape" | "csi" | "osc" | "dcs" | "string";
type ScannerState = "ground" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";

const ESC = "\x1b";
const BEL = "\x07";
const CSI = `${ESC}[`;
const CURSOR_LEFT = `${CSI}1D`;
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const OSC_INLINE_FILE_PREFIXES = [`${ESC}]1337;File=`, "\x9d1337;File="];
const MAX_IMAGE_PREFIX_LENGTH = 12;
const MAX_IMAGE_HEADER_LENGTH = 1024;
const CONTROL_START = /[\x1b\x9b\x9d\x90\x98\x9e\x9f]/;
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
  private reservedBytes = 0;
  private imagePrefix = "";
  private imagePrefixEligible = false;
  private imageHeaderPending = false;
  private imageHeader = "";
  private imageCandidate = false;
  private overflow = false;

  constructor(
    private readonly maxPendingBytes: number,
    private readonly reserve: ((bytes: number) => boolean) | undefined,
    private readonly release: ((bytes: number) => void) | undefined,
  ) {}

  feed(data: string, onText: (text: string) => void, onSequence: (kind: SequenceKind, sequence: string) => void): void {
    if (this.state === "ground" && !CONTROL_START.test(data)) {
      if (data.length > 0) onText(data);
      return;
    }
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
          this.kind = kind;
          this.parts = [];
          this.imagePrefix = "";
          this.imagePrefixEligible = kind === "osc" || kind === "dcs";
          this.imageHeaderPending = false;
          this.imageHeader = "";
          this.imageCandidate = false;
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
            this.imagePrefix = this.parts.join("");
            this.imagePrefixEligible = true;
            this.state = "string";
          } else if (ch === "P") {
            this.kind = "dcs";
            this.stringIsOsc = false;
            this.imagePrefix = this.parts.join("");
            this.imagePrefixEligible = true;
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
        if (!this.overflow) {
          const sequence = this.parts.join("");
          this.releasePending();
          onSequence(this.kind!, sequence);
        }
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
        if (!this.overflow) {
          const sequence = this.parts.join("");
          this.releasePending();
          onSequence(this.kind!, sequence);
        }
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
    this.releasePending();
    this.state = "ground";
    this.kind = undefined;
    this.stringIsOsc = false;
    this.parts = [];
    this.pendingLength = 0;
    this.imagePrefix = "";
    this.imagePrefixEligible = false;
    this.imageHeaderPending = false;
    this.imageHeader = "";
    this.imageCandidate = false;
    this.overflow = false;
  }

  private reset(): void {
    this.releasePending();
    this.state = "ground";
    this.kind = undefined;
    this.stringIsOsc = false;
    this.parts = [];
    this.pendingLength = 0;
    this.imagePrefix = "";
    this.imagePrefixEligible = false;
    this.imageHeaderPending = false;
    this.imageHeader = "";
    this.imageCandidate = false;
    this.overflow = false;
  }

  private appendPart(part: string): void {
    if (this.overflow || part.length === 0) return;
    const headerWasPending = this.imageHeaderPending;
    this.#inspectImagePrefix(part);
    if (this.overflow) return;
    if (headerWasPending && this.imageHeaderPending) this.#inspectImageHeader(part);
    if (this.overflow) return;

    const bytes = Buffer.byteLength(part);
    const nextLength = this.pendingLength + bytes;
    const pendingLimit = this.imageCandidate ? this.maxPendingBytes : MAX_SIDECAR_BYTES;
    const reserveBytes = this.imageCandidate && this.reserve
      ? this.reservedBytes === 0 ? nextLength : bytes
      : 0;
    if (nextLength > pendingLimit || (reserveBytes > 0 && !this.reserve!(reserveBytes))) {
      this.#overflowPending();
      return;
    }
    this.pendingLength = nextLength;
    this.reservedBytes += reserveBytes;
    this.parts.push(part);
  }

  #inspectImagePrefix(part: string): void {
    if (!this.imagePrefixEligible) return;
    if (this.kind === "dcs") {
      const prefix = this.imagePrefix + part.slice(0, MAX_IMAGE_HEADER_LENGTH + 1 - this.imagePrefix.length);
      const start = prefix.startsWith(`${ESC}P`) ? 2 : 1;
      for (let index = start; index < prefix.length; index += 1) {
        const code = prefix.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          this.imageCandidate = prefix[index] === "q";
          this.imagePrefix = "";
          this.imagePrefixEligible = false;
          return;
        }
      }
      if (prefix.length > MAX_IMAGE_HEADER_LENGTH) {
        this.#overflowPending();
        return;
      }
      this.imagePrefix = prefix;
      return;
    }
    const prefixOptions = OSC_INLINE_FILE_PREFIXES;
    const prefixLength = MAX_IMAGE_PREFIX_LENGTH;
    const prefix = this.imagePrefix + part.slice(0, Math.max(0, prefixLength - this.imagePrefix.length));
    for (const imagePrefix of prefixOptions) {
      if (prefix.startsWith(imagePrefix)) {
        const prefixPartLength = imagePrefix.length - this.imagePrefix.length;
        this.imagePrefix = "";
        this.imagePrefixEligible = false;
        this.imageHeaderPending = true;
        this.#inspectImageHeader(part.slice(prefixPartLength));
        return;
      }
    }
    for (const imagePrefix of prefixOptions) {
      if (imagePrefix.startsWith(prefix)) {
        this.imagePrefix = prefix;
        return;
      }
    }
    this.imagePrefix = "";
    this.imagePrefixEligible = false;
  }

  #inspectImageHeader(part: string): void {
    const separator = part.indexOf(":");
    const headerLength = this.imageHeader.length + (separator < 0 ? part.length : separator);
    if (headerLength > MAX_IMAGE_HEADER_LENGTH) {
      this.imageHeaderPending = false;
      this.imageHeader = "";
      this.#overflowPending();
      return;
    }
    if (separator < 0) {
      this.imageHeader += part;
      return;
    }
    this.imageHeader += part.slice(0, separator);
    this.imageCandidate = this.imageHeader.split(";").includes("inline=1");
    this.imageHeaderPending = false;
    this.imageHeader = "";
  }

  #overflowPending(): void {
    this.overflow = true;
    this.parts = [];
    this.pendingLength = 0;
    this.releasePending();
  }

  private releasePending(): void {
    if (this.reservedBytes > 0) this.release?.(this.reservedBytes);
    this.reservedBytes = 0;
  }
}

interface ReplayImage {
  payload: string;
  reservedRows: number;
  clippedRows: number;
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
  private readonly scanner: VtSequenceScanner;
  private readonly images = new Map<string, ReplayImage>();
  private readonly resources?: RuntimeResourceLease;
  private readonly maxSidecarBytes: number;
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

  private readonly geometryHandler;

  constructor(private readonly terminal?: Terminal, resources?: RuntimeResourceLease) {
    this.resources = resources;
    this.maxSidecarBytes = resources?.imageBytesPerRuntime ?? MAX_SIDECAR_BYTES;
    this.scanner = new VtSequenceScanner(
      this.maxSidecarBytes,
      resources ? (bytes) => this.reserveImageBytes(bytes) : undefined,
      resources ? (bytes) => resources.releaseImage(bytes) : undefined,
    );
    // Read the actual parsed cursor, not the requested CUU distance: upward
    // movement can clamp at the viewport or scrolling margin during repaint.
    this.geometryHandler = terminal?.parser.registerOscHandler(1337, (data) => {
      if (!data.startsWith("DesktopImage=")) return false;
      const image = this.images.get(data.slice("DesktopImage=".length));
      if (!image || image.reservedRows === 0) return true;
      // xterm 6 exposes the saved cursor only through its internal buffer.
      const internals = terminal as unknown as {
        _core: { buffer: { savedY: number; ybase: number } };
      };
      const buffer = internals._core.buffer;
      const requestedRows = image.reservedRows;
      const savedRow = Math.max(0, Math.min(terminal.rows - 1, buffer.savedY - buffer.ybase));
      const actualRows = Math.max(0, savedRow - terminal.buffer.active.cursorY);
      // Preserve only the rows that fit after the clamped upward movement.
      if (requestedRows > actualRows) image.clippedRows = actualRows + 1;
      image.reservedRows = actualRows;
      return true;
    });
  }

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
        output.push(withDesktopImageRows(image.payload, image.clippedRows), ESC, "8", `${CSI}1C`);
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
    for (const marker of this.images.keys()) this.forgetImage(marker);
    this.pendingMarkers.clear();
    this.needsPrune = false;
    this.scanner.clear();
    this.savedCursorActive = false;
    this.savedRowOffset = 0;
    this.deferredRestore = undefined;
  }

  /** Releases all retained marker state when the mirror is disposed. */
  dispose(): void {
    this.geometryHandler?.dispose();
    this.reset();
    this.allocatedMarkers.clear();
    this.recycledMarkers = [];
    this.recycledMarkerIndex = 0;
  }

  /** Image replay bytes for insertion before the engine restores final modes/cursor. */
  pendingImageData(): string {
    const image = this.deferredRestore && this.images.get(this.deferredRestore.marker);
    return image ? withDesktopImageRows(image.payload, image.clippedRows) : "";
  }
  /** The exact unfinished parser bytes; append these after terminal state restoration. */
  pendingSequence(): string {
    return this.scanner.pendingSuffix();
  }


  private processSequence(kind: SequenceKind, sequence: string, output: string[]): void {
    if (this.deferredRestore) {
      if (kind === "escape" && sequence === `${ESC}8`) {
        if (this.images.has(this.deferredRestore.marker)) {
          output.push(sequence, this.deferredRestore.marker, CURSOR_LEFT);
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
        // The producer owns DECSC. Never reconstruct it by moving back down:
        // CUU may have clamped, so that would save a different row and scroll
        // following output early on every repaint.
        if (this.terminal) output.push(`${ESC}]1337;DesktopImage=${marker}${BEL}`);
        output.push(" ", CURSOR_LEFT);
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

  private reserveImageBytes(bytes: number): boolean {
    if (!this.resources) return true;
    while (!this.resources.reserveImage(bytes)) {
      const oldest = this.images.keys().next().value as string | undefined;
      if (oldest === undefined) return false;
      this.forgetImage(oldest);
    }
    return true;
  }

  private rememberImage(payload: string, reservedRows: number): string | undefined {
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxSidecarBytes) return undefined;
    if (this.sidecarBytes + bytes > this.maxSidecarBytes && this.pendingMarkers.size === 0) {
      this.pruneLiveMarkers();
    }

    while (this.sidecarBytes + bytes > this.maxSidecarBytes) {
      const oldest = this.images.keys().next().value as string | undefined;
      if (oldest === undefined) return undefined;
      this.forgetImage(oldest);
    }
    if (!this.reserveImageBytes(bytes)) return undefined;

    const marker = this.allocateMarker();
    this.images.set(marker, { payload, reservedRows, clippedRows: 0, bytes });
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
    this.resources?.releaseImage(image.bytes);
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

// Carry the visible row budget with inline payloads; Sixel has no equivalent header.
function withDesktopImageRows(sequence: string, clippedRows: number): string {
  if (clippedRows <= 0 || !isInlineImage(sequence)) return sequence;
  const headerStart = sequence.startsWith(`${ESC}]1337;`) ? 7 : 6;
  const separator = sequence.indexOf(":", headerStart);
  if (separator < 0) return sequence;

  let rowBudget = clippedRows;
  const fields = sequence.slice(headerStart, separator).split(";").filter((field) => {
    if (!field.startsWith("desktopImageRows=")) return true;
    const value = Number(field.slice("desktopImageRows=".length));
    if (Number.isSafeInteger(value) && value > 0) rowBudget = Math.min(rowBudget, value);
    return false;
  });
  fields.push(`desktopImageRows=${rowBudget}`);
  return `${sequence.slice(0, headerStart)}${fields.join(";")}${sequence.slice(separator)}`;
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

