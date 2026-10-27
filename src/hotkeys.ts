import { isRecord } from "./guards";

export const HOTKEYS_KEY = "omp-desktop.hotkeys.v1";
export const SEQUENCE_TIMEOUT_MS = 1_000;
const MAX_SEQUENCE_STROKES = 4;
const MAX_ALTERNATIVES = 8;

export const HOTKEY_ACTIONS = [
  { id: "fontIncrease", label: "Increase font size", defaultValue: "Ctrl+=; Ctrl+Plus; Meta+=; Meta+Plus" },
  { id: "fontDecrease", label: "Decrease font size", defaultValue: "Ctrl+-; Ctrl+Shift+Minus; Meta+-; Meta+Shift+Minus" },
  { id: "fontReset", label: "Reset font size", defaultValue: "Ctrl+0; Meta+0" },
  { id: "splitLayout", label: "Split layout", defaultValue: "Ctrl+Shift+E; Meta+Shift+E" },
  { id: "closePane", label: "Close focused pane", defaultValue: "Ctrl+Shift+X; Meta+Shift+X" },
  { id: "togglePaneFocus", label: "Toggle pane focus", defaultValue: "Ctrl+Shift+F; Meta+Shift+F" },
  { id: "selectSpace1", label: "Select space 1", defaultValue: "Alt+1" },
  { id: "selectSpace2", label: "Select space 2", defaultValue: "Alt+2" },
  { id: "selectSpace3", label: "Select space 3", defaultValue: "Alt+3" },
  { id: "selectSpace4", label: "Select space 4", defaultValue: "Alt+4" },
  { id: "selectSpace5", label: "Select space 5", defaultValue: "Alt+5" },
  { id: "selectSpace6", label: "Select space 6", defaultValue: "Alt+6" },
  { id: "selectSpace7", label: "Select space 7", defaultValue: "Alt+7" },
  { id: "selectSpace8", label: "Select space 8", defaultValue: "Alt+8" },
  { id: "selectSpace9", label: "Select space 9", defaultValue: "Alt+9" },
] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]["id"];
export type ShortcutBindings = Record<HotkeyAction, string>;
export type ShortcutSequence = string[];

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  HOTKEY_ACTIONS.map(({ id, defaultValue }) => [id, defaultValue]),
) as ShortcutBindings;

const MODIFIERS = ["Ctrl", "Meta", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const KEY_ALIASES: Record<string, string> = {
  plus: "+",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  quote: "'",
  backtick: "`",
  space: "Space",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
};
const SHIFTED_TO_BASE: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
  '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const SIMPLE_KEYS = Object.fromEntries([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  "=", "-", "[", "]", "\\", ";", "'", "/", ".", "`", ",",
].map((key) => [key, true])) as Record<string, true>;
const NAMED_KEYS = Object.fromEntries([
  "Space", "Escape", "Enter", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
].map((key) => [key, true])) as Record<string, true>;
const ACTION_LABELS = Object.fromEntries(HOTKEY_ACTIONS.map(({ id, label }) => [id, label])) as Record<HotkeyAction, string>;

function normalizeKey(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (trimmed.length === 1 && /^[a-z]$/i.test(trimmed)) return trimmed.toLowerCase();
  if (SIMPLE_KEYS[trimmed]) return trimmed;
  if (NAMED_KEYS[trimmed]) return trimmed;
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

function keyToken(key: string): string {
  if (key === "+") return "Plus";
  if (key === ",") return "Comma";
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

function canonicalStroke(modifiers: readonly Modifier[], key: string): string {
  let result = "";
  for (const modifier of MODIFIERS) {
    if (modifiers.includes(modifier)) result += `${modifier}+`;
  }
  return result + keyToken(key);
}

function parseStroke(source: string): { stroke?: string; error?: string } {
  const value = source.trim();
  let modifierText: string;
  let keyText: string;
  if (value.endsWith("++")) {
    modifierText = value.slice(0, -2);
    keyText = "Plus";
  } else {
    const parts = value.split("+");
    if (parts.some((part) => !part.trim())) return { error: `“${value}” is missing a key or modifier.` };
    keyText = parts.pop()!;
    modifierText = parts.join("+");
  }

  const modifiers: Modifier[] = [];
  if (modifierText) {
    for (const token of modifierText.split("+")) {
      const modifier = MODIFIER_ALIASES[token.trim().toLowerCase()];
      if (!modifier) return { error: `“${token.trim()}” is not a supported modifier.` };
      if (modifiers.includes(modifier)) return { error: `${modifier} is listed more than once.` };
      modifiers.push(modifier);
    }
  }
  const key = normalizeKey(keyText);
  if (!key) return { error: `“${keyText.trim()}” is not a supported key.` };
  if (key === "+" && !modifiers.includes("Shift")) modifiers.push("Shift");
  return { stroke: canonicalStroke(modifiers, key === "+" ? "=" : key) };
}

/** Parses alternatives separated by semicolons and sequence strokes separated by commas. */
export function parseShortcutSetting(value: string): { sequences: ShortcutSequence[]; error?: string } {
  if (!value.trim()) return { sequences: [] };
  const alternatives = value.split(";");
  if (alternatives.length > MAX_ALTERNATIVES) {
    return { sequences: [], error: `Use no more than ${MAX_ALTERNATIVES} alternatives.` };
  }
  const sequences: ShortcutSequence[] = [];
  for (const alternative of alternatives) {
    if (!alternative.trim()) return { sequences: [], error: "Remove the empty shortcut alternative." };
    const strokes = alternative.split(",");
    if (strokes.length > MAX_SEQUENCE_STROKES) {
      return { sequences: [], error: `A shortcut can contain at most ${MAX_SEQUENCE_STROKES} key presses.` };
    }
    const sequence: string[] = [];
    for (const source of strokes) {
      const parsed = parseStroke(source);
      if (!parsed.stroke) return { sequences: [], error: parsed.error ?? "Invalid shortcut." };
      sequence.push(parsed.stroke);
    }
    if (!sequence[0].includes("Ctrl+") && !sequence[0].includes("Meta+") &&
      !sequence[0].includes("Alt+") && !sequence[0].includes("Shift+")) {
      return { sequences: [], error: "The first key press must include Ctrl, Meta, Alt, or Shift." };
    }
    sequences.push(sequence);
  }
  return { sequences };
}

export function validateShortcutBindings(bindings: Partial<Record<HotkeyAction, string>>): {
  parsed: Partial<Record<HotkeyAction, ShortcutSequence[]>>;
  errors: string[];
} {
  const parsed: Partial<Record<HotkeyAction, ShortcutSequence[]>> = {};
  const errors: string[] = [];
  const owners = new Map<string, HotkeyAction>();
  for (const { id, label } of HOTKEY_ACTIONS) {
    const value = bindings[id] ?? "";
    const result = parseShortcutSetting(value);
    if (result.error) {
      errors.push(`${label}: ${result.error}`);
      continue;
    }
    parsed[id] = result.sequences;
    for (const sequence of result.sequences) {
      const signature = JSON.stringify(sequence);
      const existing = owners.get(signature);
      if (existing) {
        const other = ACTION_LABELS[existing] ?? existing;
        errors.push(`${label}: ${formatSequence(sequence)} conflicts with ${other}.`);
      } else {
        owners.set(signature, id);
      }
    }
  }
  return { parsed, errors };
}

export function formatSequence(sequence: ShortcutSequence): string {
  return sequence.join(", ");
}

function patternsFrom(parsed: Partial<Record<HotkeyAction, ShortcutSequence[]>>): { action: HotkeyAction; strokes: ShortcutSequence }[] {
  const patterns: { action: HotkeyAction; strokes: ShortcutSequence }[] = [];
  for (const { id } of HOTKEY_ACTIONS) {
    for (const strokes of parsed[id] ?? []) patterns.push({ action: id, strokes });
  }
  return patterns;
}

export type ShortcutMatch = { consumed: boolean; actions: HotkeyAction[]; pending: boolean };

/** Matches complete shortcuts and bounded multi-stroke sequences without DOM dependencies. */
export class ShortcutMatcher {
  #patterns: { action: HotkeyAction; strokes: ShortcutSequence }[] = [];
  #pending: string[] | null = null;
  #pendingAction: HotkeyAction | null = null;
  #deadline = 0;

  constructor(bindings: Partial<Record<HotkeyAction, string>>, readonly timeoutMs = SEQUENCE_TIMEOUT_MS) {
    this.setBindings(bindings);
  }

  get pendingDeadline(): number | null {
    return this.#pending ? this.#deadline : null;
  }

  setBindings(bindings: Partial<Record<HotkeyAction, string>>): void {
    this.#patterns = patternsFrom(validateShortcutBindings(bindings).parsed);
    this.#clearPending();
  }

  match(stroke: string, now = performance.now(), repeat = false): ShortcutMatch {
    if (repeat) {
      const pendingMatch = this.#pending !== null && this.#matchesNext(stroke);
      return { consumed: pendingMatch || this.#hasInitial(stroke), actions: [], pending: this.#pending !== null };
    }

    const actions: HotkeyAction[] = [];
    if (this.#pending && now >= this.#deadline) actions.push(...this.expire(now));
    if (this.#pending) {
      if (this.#matchesNext(stroke)) return this.#advance([...this.#pending, stroke], now, actions);
      if (this.#pendingAction) actions.push(this.#pendingAction);
      this.#clearPending();
    }
    return this.#advance([stroke], now, actions);
  }

  expire(now = performance.now()): HotkeyAction[] {
    if (!this.#pending || now < this.#deadline) return [];
    const action = this.#pendingAction;
    this.#clearPending();
    return action ? [action] : [];
  }

  #advance(strokes: string[], now: number, actions: HotkeyAction[]): ShortcutMatch {
    let exact: HotkeyAction | null = null;
    let longer = false;
    let matched = false;
    for (const pattern of this.#patterns) {
      if (!this.#startsWith(pattern.strokes, strokes)) continue;
      matched = true;
      if (pattern.strokes.length === strokes.length) exact = pattern.action;
      else longer = true;
    }
    if (!matched) return { consumed: false, actions, pending: false };
    if (longer) {
      this.#pending = strokes;
      this.#pendingAction = exact;
      this.#deadline = now + this.timeoutMs;
      return { consumed: true, actions, pending: true };
    }
    this.#clearPending();
    if (exact) actions.push(exact);
    return { consumed: true, actions, pending: false };
  }

  #hasInitial(stroke: string): boolean {
    return this.#patterns.some((pattern) => pattern.strokes[0] === stroke);
  }

  #matchesNext(stroke: string): boolean {
    if (!this.#pending) return false;
    for (const pattern of this.#patterns) {
      const candidate = pattern.strokes;
      if (candidate.length <= this.#pending.length || candidate[this.#pending.length] !== stroke) continue;
      if (this.#startsWith(candidate, this.#pending)) return true;
    }
    return false;
  }

  #startsWith(candidate: string[], prefix: string[]): boolean {
    if (prefix.length > candidate.length) return false;
    for (let index = 0; index < prefix.length; index++) {
      if (candidate[index] !== prefix[index]) return false;
    }
    return true;
  }

  #clearPending(): void {
    this.#pending = null;
    this.#pendingAction = null;
    this.#deadline = 0;
  }
}

type KeyboardStrokeEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function shortcutStrokeForEvent(event: KeyboardStrokeEvent): string | null {
  const key = event.key === " " ? "Space" : SHIFTED_TO_BASE[event.key] ?? event.key;
  if (!key || key === "Dead" || key === "Unidentified" || key === "Process") return null;
  const normalized = normalizeKey(key);
  if (!normalized) return null;
  const modifiers: Modifier[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.metaKey) modifiers.push("Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return canonicalStroke(modifiers, normalized);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // xterm's hidden textarea is the terminal transport, not a shortcut editor.
  if (target.closest(".xterm-helper-textarea")) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function loadBindings(): { bindings: ShortcutBindings; invalidStored: boolean } {
  const bindings = { ...DEFAULT_SHORTCUTS };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HOTKEYS_KEY) ?? "null");
    if (!isRecord(value)) return { bindings, invalidStored: false };
    for (const { id } of HOTKEY_ACTIONS) {
      const candidate = value[id];
      if (typeof candidate === "string") bindings[id] = candidate;
    }
    return validateShortcutBindings(bindings).errors.length
      ? { bindings: { ...DEFAULT_SHORTCUTS }, invalidStored: true }
      : { bindings, invalidStored: false };
  } catch {
    return { bindings, invalidStored: true };
  }
}

/** Binds the app actions, shortcut editor, and window capture listener. */
export function initializeHotkeys(runAction: (action: HotkeyAction) => void): void {
  const loaded = loadBindings();
  let bindings = loaded.bindings;
  const matcher = new ShortcutMatcher(bindings);
  const list = document.getElementById("shortcut-list");
  const saveButton = document.getElementById("shortcut-save") as HTMLButtonElement | null;
  const resetButton = document.getElementById("shortcut-reset") as HTMLButtonElement | null;
  const message = document.getElementById("shortcut-message");
  const inputs = new Map<HotkeyAction, HTMLInputElement>();
  let timer = 0;

  const say = (text: string, kind: "ok" | "warn" = "ok"): void => {
    if (!message) return;
    message.textContent = text;
    message.dataset.kind = kind;
    message.setAttribute("role", kind === "warn" ? "alert" : "status");
  };
  const expirePending = (): void => {
    for (const action of matcher.expire(performance.now())) runAction(action);
    const deadline = matcher.pendingDeadline;
    if (deadline !== null) timer = window.setTimeout(expirePending, Math.max(0, deadline - performance.now()));
  };
  const persist = (next: ShortcutBindings): void => {
    bindings = next;
    matcher.setBindings(bindings);
    try {
      localStorage.setItem(HOTKEYS_KEY, JSON.stringify(bindings));
      say("Keyboard shortcuts saved.");
    } catch {
      say("Keyboard shortcuts are active for this window, but browser storage is unavailable.", "warn");
    }
  };

  if (list) {
    const groups = new Map<string, HTMLElement>();
    for (const label of ["Panes", "Spaces", "Terminal text"]) {
      const group = document.createElement("details");
      group.className = "shortcut-group";
      group.open = label === "Panes";
      const heading = document.createElement("summary");
      heading.textContent = label;
      const rows = document.createElement("div");
      rows.className = "shortcut-group-rows";
      group.append(heading, rows);
      list.append(group);
      groups.set(label, rows);
    }
    for (const { id, label } of HOTKEY_ACTIONS) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const inputId = `shortcut-${id}`;
      const labelElement = document.createElement("label");
      labelElement.htmlFor = inputId;
      labelElement.textContent = label;
      const editor = document.createElement("div");
      editor.className = "shortcut-editor";
      const input = document.createElement("input");
      input.id = inputId;
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Disabled";
      input.value = bindings[id];
      input.setAttribute("aria-label", `${label} shortcut`);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear";
      clear.setAttribute("aria-label", `Clear ${label} shortcut`);
      clear.addEventListener("click", () => {
        input.value = "";
        input.focus();
      });
      editor.append(input, clear);
      row.append(labelElement, editor);
      const group = id.startsWith("font") ? "Terminal text" : id.startsWith("selectSpace") ? "Spaces" : "Panes";
      groups.get(group)!.append(row);
      inputs.set(id, input);
    }
  }

  saveButton?.addEventListener("click", () => {
    const edited = { ...bindings };
    for (const [id, input] of inputs) edited[id] = input.value;
    const validation = validateShortcutBindings(edited);
    if (validation.errors.length) {
      say(validation.errors.join(" "), "warn");
      return;
    }
    persist(edited);
  });
  resetButton?.addEventListener("click", () => {
    for (const [id, input] of inputs) input.value = DEFAULT_SHORTCUTS[id];
    persist({ ...DEFAULT_SHORTCUTS });
  });
  if (loaded.invalidStored) say("Saved shortcuts were invalid; defaults are active. Review and save to replace them.", "warn");

  const capture = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target) || event.isComposing || event.keyCode === 229 ||
      event.key === "AltGraph" || event.getModifierState("AltGraph")) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && matcher.pendingDeadline === null) return;
    const stroke = shortcutStrokeForEvent(event);
    if (!stroke) return;
    const result = matcher.match(stroke, performance.now(), event.repeat);
    if (result.consumed) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    for (const action of result.actions) runAction(action);
    window.clearTimeout(timer);
    if (matcher.pendingDeadline !== null) {
      timer = window.setTimeout(expirePending, Math.max(0, matcher.pendingDeadline - performance.now()));
    }
  };
  window.addEventListener("blur", () => {
    window.clearTimeout(timer);
    matcher.setBindings(bindings);
  });
  window.addEventListener("focusin", (event) => {
    if (!isEditableTarget(event.target)) return;
    window.clearTimeout(timer);
    matcher.setBindings(bindings);
  });
  window.addEventListener("keydown", capture, true);
}
