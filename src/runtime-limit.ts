/**
 * Session limit setting (Settings → "Session limit"). The daemon owns the limit
 * and persists it; this module is the client's only reader/writer of
 * GET/PUT /api/settings and the restart control a saved value may need.
 *
 * One module per Settings control, like sidebar.ts (view) and
 * working-indicator.ts (motion): the markup validation, daemon calls, and error
 * reporting for this setting live together instead of widening client.ts.
 *
 * Restart: POST /api/restart answers before the daemon goes down, so a 2xx only
 * means the restart is on its way. This module then watches GET /api/settings
 * until a daemon that no longer needs the restart answers. Reconnecting the
 * panes is the client's existing job — its /api/runtimes poll sees the new
 * daemon generation and restores the pool — so nothing here touches the
 * workspace.
 */
import { isRecord } from "./guards";
import { parseIdleTimeoutInput } from "./runtime-settings-input";

/** Shown until the first successful read; the daemon's own default. */
const DEFAULT_MAX_RUNTIMES = 16;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
/** How long to wait for a restarted daemon to answer before telling the user. */
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_POLL_MS = 500;

type RuntimeSettings = {
  /** Limit saved on the daemon; this is the value the input edits. */
  maxRuntimes: number;
  /** Limit the answering daemon is enforcing right now. */
  effectiveMaxRuntimes: number;
  /** True while the saved limit cannot apply until the daemon restarts. */
  restartRequired: boolean;
  /** Continuous safe-idle threshold; zero disables automatic unloading. */
  idleTimeoutMinutes: number;
};

type Controls = {
  input: HTMLInputElement;
  save: HTMLButtonElement;
  status: HTMLElement;
  restartBox: HTMLElement;
  restartButton: HTMLButtonElement;
  idleInput: HTMLInputElement;
  idleSave: HTMLButtonElement;
  idleStatus: HTMLElement;
};

/**
 * Static markup, so one query at page load is enough (client.js is a deferred
 * module script). Null only if index.html is older than the bundle, which must
 * not take the rest of the client down with it.
 */
function queryControls(): Controls | null {
  const input = document.getElementById("runtime-limit-input");
  const save = document.getElementById("runtime-limit-save");
  const status = document.getElementById("runtime-limit-status");
  const restartBox = document.getElementById("runtime-limit-restart");
  const restartButton = document.getElementById("runtime-limit-restart-button");
  const idleInput = document.getElementById("idle-timeout-input");
  const idleSave = document.getElementById("idle-timeout-save");
  const idleStatus = document.getElementById("idle-timeout-status");
  if (
    !(input instanceof HTMLInputElement) ||
    !(save instanceof HTMLButtonElement) ||
    !status ||
    !restartBox ||
    !(restartButton instanceof HTMLButtonElement) ||
    !(idleInput instanceof HTMLInputElement) ||
    !(idleSave instanceof HTMLButtonElement) ||
    !idleStatus
  ) {
    console.warn("runtime settings: controls missing from index.html");
    return null;
  }
  return { input, save, status, restartBox, restartButton, idleInput, idleSave, idleStatus };
}

const controls = queryControls();

/** Last payload the daemon returned; null until the first read lands. */
let settings: RuntimeSettings | null = null;
/** A PUT/POST is in flight: both controls stay disabled until it settles. */
let busy = false;
/** A restart was requested and the daemon has not answered again yet. */
let restartPending = false;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates the settings payload against the shared contract. */
function parseSettings(value: unknown): RuntimeSettings | null {
  if (!isRecord(value)) return null;
  const { maxRuntimes, effectiveMaxRuntimes, restartRequired, idleTimeoutMinutes } = value;
  if (!isPositiveInteger(maxRuntimes) || !isPositiveInteger(effectiveMaxRuntimes)) return null;
  if (typeof restartRequired !== "boolean" || !isNonNegativeInteger(idleTimeoutMinutes)) return null;
  return { maxRuntimes, effectiveMaxRuntimes, restartRequired, idleTimeoutMinutes };
}

/** The daemon's own explanation for a failure (plain text), never a bare code. */
async function failureText(res: Response): Promise<string> {
  const body = (await res.text().catch(() => "")).trim();
  return body || `request failed (HTTP ${res.status})`;
}

/** One line for the settings panel: the limit, what runs now, and any restart. */
function summary(current: RuntimeSettings): string {
  return `Max sessions ${current.maxRuntimes}, in effect now ${current.effectiveMaxRuntimes}.` +
    (current.restartRequired ? " Restart required to apply the saved maximum." : "");
}

function idleSummary(current: RuntimeSettings): string {
  return current.idleTimeoutMinutes === 0
    ? "Automatic idle unloading is disabled."
    : `Idle runtimes unload after ${current.idleTimeoutMinutes} minutes of safe inactivity.`;
}

function say(text: string, kind: "ok" | "warn" | "pending"): void {
  if (!controls) return;
  controls.status.textContent = text;
  controls.status.dataset.kind = kind;
  controls.status.setAttribute("role", kind === "warn" ? "alert" : "status");
}

function render(): void {
  if (!controls) return;
  const locked = busy || restartPending;
  controls.save.disabled = locked;
  controls.input.disabled = locked;
  controls.restartButton.disabled = locked;
  controls.idleSave.disabled = busy;
  controls.idleInput.disabled = busy;
  controls.restartBox.hidden = !(settings?.restartRequired ?? false);
}

/**
 * Adopt the daemon's saved limit into the input. Only the two places that store
 * a fresh payload call this, so a rejected save leaves the user's number in the
 * field to correct instead of silently reverting it.
 */
function showSavedLimit(next: RuntimeSettings): void {
  if (!controls || document.activeElement === controls.input) return;
  controls.input.value = String(next.maxRuntimes);
}

function showSavedIdleTimeout(next: RuntimeSettings): void {
  if (!controls || document.activeElement === controls.idleInput) return;
  controls.idleInput.value = String(next.idleTimeoutMinutes);
}

/** Reads the current settings; null on a transport error, bad status, or bad shape. */
async function readSettings(): Promise<RuntimeSettings | null> {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return null;
    return parseSettings(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Refresh the control from the daemon. The client calls this on startup and on
 * every new daemon generation (i.e. after a restart); the panel also refreshes
 * itself when it opens, so the input and the restart prompt always describe the
 * daemon that is actually answering.
 */
export async function syncRuntimeLimit(): Promise<void> {
  // While a restart is in flight the restart loop owns the message: an
  // unreachable daemon is the expected state, not news.
  if (!controls || busy || restartPending) return;
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) {
      say(await failureText(res), "warn");
      render();
      return;
    }
    const next = parseSettings(await res.json().catch(() => null));
    if (!next) {
      say("The daemon returned an unrecognised session limit payload.", "warn");
      render();
      return;
    }
    settings = next;
    showSavedLimit(next);
    showSavedIdleTimeout(next);
    say(summary(next), next.restartRequired ? "warn" : "ok");
    controls.idleStatus.textContent = idleSummary(next);
    controls.idleStatus.dataset.kind = "ok";
  } catch {
    say("Session limit unavailable: the daemon is unreachable.", "warn");
  }
  render();
}

async function save(): Promise<void> {
  if (!controls || busy || restartPending) return;
  const value = Number(controls.input.value.trim());
  if (!isPositiveInteger(value)) {
    say("Enter the maximum number of sessions as a whole number of 1 or more.", "warn");
    controls.input.focus();
    return;
  }
  if (settings && value === settings.maxRuntimes) {
    say(summary(settings), settings.restartRequired ? "warn" : "ok");
    return;
  }
  busy = true;
  render();
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxRuntimes: value }),
    });
    if (!res.ok) {
      // The daemon refuses an unsafe limit (below the sessions it must restore)
      // with its own explanation; show it as written.
      say(await failureText(res), "warn");
      return;
    }
    const next = parseSettings(await res.json().catch(() => null));
    if (!next) {
      say("The daemon returned an unrecognised session limit payload.", "warn");
      return;
    }
    settings = next;
    showSavedLimit(next);
    showSavedIdleTimeout(next);
    say(next.restartRequired ? `Saved. ${summary(next)}` : summary(next), next.restartRequired ? "warn" : "ok");
  } catch {
    say("Could not reach the daemon to save the session limit.", "warn");
  } finally {
    busy = false;
    render();
  }
}

async function saveIdleTimeout(): Promise<void> {
  if (!controls || busy) return;
  const value = parseIdleTimeoutInput(controls.idleInput.value);
  if (value === null) {
    controls.idleStatus.textContent = "Enter a whole number of minutes, or 0 to disable automatic unloading.";
    controls.idleStatus.dataset.kind = "warn";
    controls.idleInput.focus();
    return;
  }
  if (settings && value === settings.idleTimeoutMinutes) {
    controls.idleStatus.textContent = idleSummary(settings);
    controls.idleStatus.dataset.kind = "ok";
    return;
  }
  busy = true;
  render();
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idleTimeoutMinutes: value }),
    });
    if (!res.ok) {
      controls.idleStatus.textContent = await failureText(res);
      controls.idleStatus.dataset.kind = "warn";
      return;
    }
    const next = parseSettings(await res.json().catch(() => null));
    if (!next) {
      controls.idleStatus.textContent = "The daemon returned an unrecognised runtime settings payload.";
      controls.idleStatus.dataset.kind = "warn";
      return;
    }
    settings = next;
    showSavedLimit(next);
    showSavedIdleTimeout(next);
    controls.idleStatus.textContent = `Saved and applied immediately. ${idleSummary(next)}`;
    controls.idleStatus.dataset.kind = "ok";
  } catch {
    controls.idleStatus.textContent = "Could not reach the daemon to save the idle timeout.";
    controls.idleStatus.dataset.kind = "warn";
  } finally {
    busy = false;
    render();
  }
}

async function restart(): Promise<void> {
  if (!controls || busy || restartPending) return;
  busy = true;
  render();
  try {
    const res = await fetch("/api/restart", { method: "POST" });
    if (!res.ok) {
      say(await failureText(res), "warn");
      return;
    }
  } catch {
    say("Could not reach the daemon to restart it.", "warn");
    return;
  } finally {
    busy = false;
    render();
  }
  // The daemon answers before it goes down, so the reply only means the restart
  // is on its way; watch the settings endpoint for the daemon that comes back.
  restartPending = true;
  render();
  say("Restarting the daemon… running processes stop; saved transcripts remain readable and load only after you submit.", "pending");
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    window.setTimeout(resolve, RESTART_POLL_MS);
    await promise;
    const next = await readSettings();
    // A daemon that still needs the restart is the old process answering before
    // it exits; the restarted one reports the saved limit in effect.
    if (!next || next.restartRequired) continue;
    settings = next;
    showSavedLimit(next);
    showSavedIdleTimeout(next);
    restartPending = false;
    say(`Restarted. ${summary(next)}`, "ok");
    render();
    return;
  }
  restartPending = false;
  say("The restart has not applied the new limit yet. Check the daemon, then press Restart now again.", "warn");
  render();
}

if (controls) {
  controls.input.value = String(DEFAULT_MAX_RUNTIMES);
  controls.idleInput.value = String(DEFAULT_IDLE_TIMEOUT_MINUTES);
  controls.save.addEventListener("click", () => void save());
  controls.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  });
  controls.idleSave.addEventListener("click", () => void saveIdleTimeout());
  controls.idleInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void saveIdleTimeout();
  });
  controls.restartButton.addEventListener("click", () => void restart());
  render();
  void syncRuntimeLimit();
}
