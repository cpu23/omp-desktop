/** Minimal W3C WebDriver client for the real WebKitWebDriver native smoke. */
export type WebDriverCapabilities = Record<string, unknown>;
export type WebDriverElement = { id: string };

type WebDriverValue<T> = { value: T; sessionId?: string };

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
export type X11InputBackend = {
  xdotool: string;
  timeout: string;
  env: Record<string, string>;
  windowTitle?: string;
};

function toWebDriverValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWebDriverValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.id === "string") return { [ELEMENT_KEY]: record.id };
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, toWebDriverValue(child)]));
}

function nativeInputFailure(kind: "mouse" | "keyboard", error: unknown): Error {
  if (/unsupported operation/i.test(String(error))) {
    return new Error(
      `Native WebDriver ${kind} input is unavailable in this system WebKitGTK build. ` +
      "Use an X11InputBackend with real xdotool events where X11 is available; DOM-event fallbacks are intentionally not used. " +
      `Underlying error: ${String(error)}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}


export class WebDriver {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly capabilities: WebDriverCapabilities;
  readonly #x11Input?: X11InputBackend;
  #closed = false;

  private constructor(endpoint: string, sessionId: string, capabilities: WebDriverCapabilities, x11Input?: X11InputBackend) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.#x11Input = x11Input;
  }

  static async create(endpoint: string, capabilities: WebDriverCapabilities, x11Input?: X11InputBackend): Promise<WebDriver> {
    const base = endpoint.replace(/\/+$/, "");
    const response = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }),
      signal: AbortSignal.timeout(30_000),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`WebDriver create session failed (${response.status}): ${detail(result)}`);
    if (typeof result !== "object" || result === null) throw new Error("WebDriver returned an invalid session response.");
    const record = result as Record<string, unknown>;
    const value = record.value;
    const id = record.sessionId ?? (typeof value === "object" && value !== null ? (value as Record<string, unknown>).sessionId : null);
    if (typeof id !== "string" || id.length === 0) throw new Error(`WebDriver omitted its session id: ${detail(result)}`);
    const negotiated = typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).capabilities === "object"
      ? (value as Record<string, WebDriverCapabilities>).capabilities!
      : {};
    return new WebDriver(base, id, negotiated, x11Input);
  }

  async command<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.#closed && path !== `/session/${this.sessionId}`) throw new Error("WebDriver session is closed.");
    const response = await fetch(`${this.endpoint}${path.startsWith("/") ? path : `/${path}`}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let result: unknown = null;
    try {
      result = raw.length === 0 ? null : JSON.parse(raw);
    } catch {
      result = raw;
    }
    if (!response.ok) throw new Error(`WebDriver ${method} ${path} failed (${response.status}): ${detail(result)}`);
    if (typeof result === "object" && result !== null && "value" in result) {
      const value = (result as WebDriverValue<T>).value;
      if (typeof value === "object" && value !== null && "error" in value) {
        throw new Error(`WebDriver ${method} ${path} returned an error: ${detail(value)}`);
      }
      return value;
    }
    return result as T;
  }

  async navigate(url: string): Promise<void> {
    await this.command("POST", `/session/${this.sessionId}/url`, { url });
  }

  async currentUrl(): Promise<string> {
    return await this.command<string>("GET", `/session/${this.sessionId}/url`);
  }

  async windowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return await this.command<{ x: number; y: number; width: number; height: number }>("GET", `/session/${this.sessionId}/window/rect`);
  }

  async setWindowRect(width: number, height: number): Promise<{ x: number; y: number; width: number; height: number }> {
    return await this.command<{ x: number; y: number; width: number; height: number }>("POST", `/session/${this.sessionId}/window/rect`, { width, height });
  }
  async title(): Promise<string> {
    return await this.command<string>("GET", `/session/${this.sessionId}/title`);
  }

  async find(selector: string): Promise<WebDriverElement> {
    const value = await this.command<unknown>("POST", `/session/${this.sessionId}/element`, {
      using: "css selector",
      value: selector,
    });
    if (typeof value !== "object" || value === null) throw new Error(`WebDriver did not find ${selector}.`);
    const id = (value as Record<string, unknown>)[ELEMENT_KEY];
    if (typeof id !== "string") throw new Error(`WebDriver returned an invalid element for ${selector}.`);
    return { id };
  }

  async findAll(selector: string): Promise<WebDriverElement[]> {
    const values = await this.command<unknown>("POST", `/session/${this.sessionId}/elements`, {
      using: "css selector",
      value: selector,
    });
    if (!Array.isArray(values)) throw new Error(`WebDriver returned invalid elements for ${selector}.`);
    return values.map((value) => {
      if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>)[ELEMENT_KEY] !== "string") {
        throw new Error(`WebDriver returned an invalid element for ${selector}.`);
      }
      return { id: (value as Record<string, string>)[ELEMENT_KEY]! };
    });
  }

  async click(element: WebDriverElement): Promise<void> {
    if (this.#x11Input) return this.x11Click(element, 1);
    await this.pointerClick(element, 0);
  }

  private async pointerClick(element: WebDriverElement, button: number): Promise<void> {
    const origin = { [ELEMENT_KEY]: element.id };
    try {
      await this.command("POST", `/session/${this.sessionId}/actions`, {
        actions: [{
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin, x: 0, y: 0 },
            { type: "pointerDown", button },
            { type: "pointerUp", button },
          ],
        }],
      });
    } catch (error) {
      throw nativeInputFailure("mouse", error);
    }
  }

  async clickCss(selector: string): Promise<void> {
    await this.click(await this.find(selector));
  }

  async sendKeys(element: WebDriverElement, text: string): Promise<void> {
    if (this.#x11Input) {
      const visible = await this.execute<boolean>(`
        const rect = arguments[0].getBoundingClientRect();
        const style = getComputedStyle(arguments[0]);
        return rect.width > 4 && rect.height > 4 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity) > 0;
      `, [element]);
      if (visible) await this.x11Click(element, 1);
      this.x11Type(text);
      return;
    }
    try {
      await this.command("POST", `/session/${this.sessionId}/element/${encodeURIComponent(element.id)}/value`, {
        text,
        value: Array.from(text),
      });
    } catch (error) {
      throw nativeInputFailure("keyboard", error);
    }
  }

  async sendKeysCss(selector: string, text: string): Promise<void> {
    await this.sendKeys(await this.find(selector), text);
  }

  async clear(element: WebDriverElement): Promise<void> {
    if (this.#x11Input) {
      await this.x11Click(element, 1);
      this.x11Key("a", "control");
      this.x11Key("BackSpace");
      return;
    }
    try {
      await this.command("POST", `/session/${this.sessionId}/element/${encodeURIComponent(element.id)}/clear`, {});
    } catch (error) {
      throw nativeInputFailure("keyboard", error);
    }
  }

  async clearCss(selector: string): Promise<void> {
    await this.clear(await this.find(selector));
  }

  async elementText(element: WebDriverElement): Promise<string> {
    return await this.command<string>("GET", `/session/${this.sessionId}/element/${encodeURIComponent(element.id)}/text`);
  }

  async attribute(element: WebDriverElement, name: string): Promise<string | null> {
    return await this.command<string | null>(
      "GET",
      `/session/${this.sessionId}/element/${encodeURIComponent(element.id)}/attribute/${encodeURIComponent(name)}`,
    );
  }

  async displayed(element: WebDriverElement): Promise<boolean> {
    return await this.command<boolean>("GET", `/session/${this.sessionId}/element/${encodeURIComponent(element.id)}/displayed`);
  }

  async keyPress(value: string, modifier?: string): Promise<void> {
    if (this.#x11Input) {
      this.x11Key(value, modifier);
      return;
    }
    const actions: Array<Record<string, string>> = [];
    if (modifier) actions.push({ type: "keyDown", value: modifier });
    actions.push({ type: "keyDown", value }, { type: "keyUp", value });
    if (modifier) actions.push({ type: "keyUp", value: modifier });
    try {
      await this.command("POST", `/session/${this.sessionId}/actions`, {
        actions: [{ type: "key", id: "keyboard", actions }],
      });
    } catch (error) {
      throw nativeInputFailure("keyboard", error);
    }
  }

  async rightClick(element: WebDriverElement): Promise<void> {
    if (this.#x11Input) return this.x11Click(element, 3);
    await this.pointerClick(element, 2);
  }
  private runXdotool(args: string[], allowNoMatch = false): string {
    const input = this.#x11Input;
    if (!input) throw new Error("The X11 input backend is not configured for this WebDriver session.");
    const result = Bun.spawnSync({
      cmd: [input.timeout, "--signal=TERM", "--kill-after=1s", "5s", input.xdotool, ...args],
      env: input.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode === 124 || result.exitCode === 137) {
      throw new Error(`xdotool ${args[0]} exceeded its five-second deadline.`);
    }
    if (result.exitCode !== 0 && !(allowNoMatch && result.exitCode === 1)) {
      throw new Error(`xdotool ${args[0]} exited ${result.exitCode}: ${stderr || stdout}`);
    }
    return stdout;
  }

  private async x11WindowId(): Promise<string> {
    const title = this.#x11Input?.windowTitle ?? "OMP Desktop";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matches = this.runXdotool(["search", "--onlyvisible", "--name", `^${title}$`], true)
        .split(/\s+/).filter(Boolean);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new Error(`Expected one visible ${title} X11 window, found ${matches.length}.`);
      await Bun.sleep(100);
    }
    throw new Error(`No visible ${title} X11 window appeared for real native input.`);
  }

  private x11WindowGeometry(windowId: string): { width: number; height: number } {
    const output = this.runXdotool(["getwindowgeometry", "--shell", windowId]);
    const number = (name: string): number => {
      const match = output.match(new RegExp(`^${name}=(\\d+)$`, "m"));
      if (!match) throw new Error(`xdotool window geometry omitted ${name}: ${output}`);
      return Number(match[1]);
    };
    return { width: number("WIDTH"), height: number("HEIGHT") };
  }

  private async x11Click(element: WebDriverElement, button: 1 | 3): Promise<void> {
    const box = await this.execute<{
      left: number;
      top: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    }>(
      `const rect = arguments[0].getBoundingClientRect(); return {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight
      };`,
      [element],
    );
    if (box.width <= 0 || box.height <= 0 || box.viewportWidth <= 0 || box.viewportHeight <= 0) {
      throw new Error(`Cannot click an element without a visible CSS rectangle: ${JSON.stringify(box)}.`);
    }
    const windowId = await this.x11WindowId();
    const geometry = this.x11WindowGeometry(windowId);
    const x = Math.max(0, Math.min(geometry.width - 1, Math.round((box.left + box.width / 2) * geometry.width / box.viewportWidth)));
    const y = Math.max(0, Math.min(geometry.height - 1, Math.round((box.top + box.height / 2) * geometry.height / box.viewportHeight)));
    this.runXdotool(["windowraise", windowId]);
    this.runXdotool(["windowfocus", "--sync", windowId]);
    this.runXdotool([
      "mousemove", "--window", windowId, String(x), String(y),
      "click", "--clearmodifiers", String(button),
    ]);
  }

  private x11Key(value: string, modifier?: string): void {
    const specialKeys: Record<string, string> = {
      "\uE003": "BackSpace",
      "\uE004": "Tab",
      "\uE007": "Return",
      "\uE008": "shift",
      "\uE009": "ctrl",
      "\uE00A": "alt",
      "\uE00C": "Escape",
      "\uE00D": "space",
      "\uE00E": "Page_Up",
      "\uE00F": "End",
      "\uE010": "Home",
      "\uE011": "Left",
      "\uE012": "Up",
      "\uE013": "Right",
      "\uE014": "Down",
      "\uE015": "Insert",
      "\uE016": "Delete",
      control: "ctrl",
      Control: "ctrl",
      shift: "shift",
      Shift: "shift",
      alt: "alt",
      Alt: "alt",
      meta: "super",
      Meta: "super",
    };
    const keyName = (key: string): string => {
      const mapped = specialKeys[key];
      if (mapped) return mapped;
      if (Array.from(key).length === 1 && key.codePointAt(0)! > 0x7e) {
        return `U${key.codePointAt(0)!.toString(16).toUpperCase()}`;
      }
      return key;
    };
    const key = keyName(value);
    const modifierKey = modifier ? keyName(modifier) : "";
    const combo = modifierKey ? `${modifierKey}+${key}` : key;
    this.runXdotool(["key", "--clearmodifiers", combo]);
  }

  private x11Type(text: string): void {
    let ascii = "";
    const flushAscii = (): void => {
      if (!ascii) return;
      this.runXdotool(["type", "--clearmodifiers", "--delay", "0", ascii]);
      ascii = "";
    };
    for (const character of text) {
      const codepoint = character.codePointAt(0)!;
      if (codepoint === 0x0a || codepoint === 0x0d || codepoint === 0xe007) {
        flushAscii();
        this.x11Key("\uE007");
      } else if (codepoint === 0x09 || codepoint === 0xe004) {
        flushAscii();
        this.x11Key("\uE004");
      } else if (codepoint >= 0x20 && codepoint <= 0x7e) {
        ascii += character;
      } else if (codepoint > 0x7e) {
        flushAscii();
        this.x11Key(character);
      }
    }
    flushAscii();
  }


  async releaseActions(): Promise<void> {
    if (this.#x11Input) return;
    await this.command("DELETE", `/session/${this.sessionId}/actions`);
  }

  async execute<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return await this.command<T>("POST", `/session/${this.sessionId}/execute/sync`, { script, args: args.map(toWebDriverValue) });
  }
  async executeAsync<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return await this.command<T>("POST", `/session/${this.sessionId}/execute/async`, { script, args: args.map(toWebDriverValue) });
  }

  async screenshot(): Promise<string> {
    return await this.command<string>("GET", `/session/${this.sessionId}/screenshot`);
  }

  async evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
  async evaluate<Arg, Result>(pageFunction: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>;
  async evaluate<Arg, Result>(pageFunction: (arg: Arg) => Result | Promise<Result>, arg?: Arg): Promise<Result> {
    const args = arg === undefined ? [] : [arg];
    const body = `const callback = arguments[arguments.length - 1];\n` +
      `const values = Array.prototype.slice.call(arguments, 0, -1);\n` +
      `Promise.resolve((${pageFunction.toString()})(...values)).then(\n` +
      `  (value) => callback({ ok: true, value }),\n` +
      `  (error) => callback({ ok: false, error: error instanceof Error ? error.message : String(error) }),\n` +
      `);`;
    const result = await this.executeAsync<{ ok: boolean; value?: Result; error?: string }>(body, args);
    if (!result || result.ok !== true) throw new Error(`WebDriver page evaluation failed: ${result?.error ?? "unknown error"}`);
    return result.value as Result;
  }

  async waitFor<T>(predicate: () => Promise<T | false | null | undefined> | T | false | null | undefined, label: string, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < end) {
      try {
        const value = await predicate();
        if (value !== false && value !== null && value !== undefined) return value as T;
      } catch (error) {
        if (typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError") {
          throw new Error(`WebDriver request timed out while waiting for ${label}: ${String(error)}`);
        }
        lastError = error;
      }
      await Bun.sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? ` (${String(lastError)})` : ""}.`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.command("DELETE", `/session/${this.sessionId}`);
    } finally {
      this.#closed = true;
    }
  }
}

function detail(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 3000);
  try {
    return JSON.stringify(value)?.slice(0, 3000) ?? String(value);
  } catch {
    return String(value);
  }
}
