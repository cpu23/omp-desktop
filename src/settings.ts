/**
 * Daemon-owned runtime settings, persisted independently of browser storage.
 * The pool limit applies after restart; idle timeout changes apply immediately.
 * Saved values take precedence over deployment environment fallbacks.
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards";

/** The limit used when neither a saved setting nor the environment supplies one. */
export const DEFAULT_MAX_RUNTIMES = 16;
/** Continuous, authoritatively idle time before a saved runtime may unload. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
const MAX_IDLE_TIMEOUT_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

/** Settings documents larger than this are treated as malformed. */
export const SETTINGS_LIMIT_BYTES = 64 * 1024;

/** The wire shape shared by `GET /api/settings` and `PUT /api/settings`. */
export type SettingsPayload = {
  /** The saved/desired limit; this is what the Settings field edits. */
  maxRuntimes: number;
  /** The limit this daemon actually enforces until it restarts. */
  effectiveMaxRuntimes: number;
  /** Continuous idle minutes before unloading; zero disables automatic unloading. */
  idleTimeoutMinutes: number;
  /** True when changing `maxRuntimes` to `effectiveMaxRuntimes` needs a restart. */
  restartRequired: boolean;
};

export type ResolvedMaxRuntimes = {
  maxRuntimes: number;
  source: "saved" | "env" | "default";
};

/** A limit is a positive integer: zero, negatives, fractions and strings are not limits. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Parse an environment limit. Only a plain decimal integer is accepted; values
 * like `8.5`, `8runtimes`, `0` or `-1` are ignored rather than rounded, so a
 * typo cannot silently pick a different limit.
 */
export function parsePositiveInteger(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return isPositiveInteger(parsed) ? parsed : null;
}

/**
 * The startup limit, in precedence order: a valid saved value, then a valid
 * `OMP_DESKTOP_MAX_RUNTIMES`, then {@link DEFAULT_MAX_RUNTIMES}. The source is
 * returned so the daemon can log why this process enforces the limit it does.
 */
export function resolveMaxRuntimes(
  saved: unknown,
  envFallback: string | undefined,
): ResolvedMaxRuntimes {
  if (isPositiveInteger(saved)) return { maxRuntimes: saved, source: "saved" };
  const env = parsePositiveInteger(envFallback);
  if (env !== null) return { maxRuntimes: env, source: "env" };
  return { maxRuntimes: DEFAULT_MAX_RUNTIMES, source: "default" };
}
export function isIdleTimeoutMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= MAX_IDLE_TIMEOUT_MINUTES;
}

export function resolveIdleTimeoutMinutes(saved: unknown, envFallback: string | undefined): number {
  if (isIdleTimeoutMinutes(saved)) return saved;
  if (typeof envFallback === "string" && /^[0-9]+$/.test(envFallback.trim())) {
    const parsed = Number(envFallback.trim());
    if (isIdleTimeoutMinutes(parsed)) return parsed;
  }
  return DEFAULT_IDLE_TIMEOUT_MINUTES;
}


/** Build the API payload; `restartRequired` is exactly "saved differs from running". */
export function settingsPayload(
  maxRuntimes: number,
  effectiveMaxRuntimes: number,
  idleTimeoutMinutes: number,
): SettingsPayload {
  return {
    maxRuntimes,
    effectiveMaxRuntimes,
    idleTimeoutMinutes,
    restartRequired: maxRuntimes !== effectiveMaxRuntimes,
  };
}

export type StoredSettings = {
  /** A valid saved limit, or null when absent or unusable. */
  maxRuntimes: number | null;
  /** Null in pre-timeout settings files, or when the document is unusable. */
  idleTimeoutMinutes: number | null;
  /** True when a file with unusable content exists (the caller may warn). */
  malformed: boolean;
};

/**
 * Atomically replaces a small JSON file: write a sibling temp file, fsync it,
 * rename over the target, then fsync the parent directory. A crash leaves the
 * old or the new document complete, never a truncated one — the same guarantee
 * the workspace state and runtime ledger use.
 */
async function writeTextAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const dir = await open(dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/**
 * The daemon's saved settings file. The daemon owns the document; the client
 * only asks for changes through the HTTP API, so the file shape can evolve
 * without exposing it to browser storage.
 */
export class DaemonSettingsStore {
  readonly file: string;
  /** Serializes writes so a rapid sequence of PUTs lands in call order. */
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /**
   * Reads saved settings, accepting version-one files written before the idle
   * timeout existed. A malformed document is ignored as a whole.
   */
  async read(): Promise<StoredSettings> {
    let text: string;
    try {
      const info = await stat(this.file);
      if (info.size > SETTINGS_LIMIT_BYTES) {
        return { maxRuntimes: null, idleTimeoutMinutes: null, malformed: true };
      }
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { maxRuntimes: null, idleTimeoutMinutes: null, malformed: false };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { maxRuntimes: null, idleTimeoutMinutes: null, malformed: true };
    }
    if (!isRecord(value) || value.version !== 1 ||
        (value.maxRuntimes === undefined && value.idleTimeoutMinutes === undefined) ||
        (value.maxRuntimes !== undefined && !isPositiveInteger(value.maxRuntimes)) ||
        (value.idleTimeoutMinutes !== undefined && !isIdleTimeoutMinutes(value.idleTimeoutMinutes))) {
      return { maxRuntimes: null, idleTimeoutMinutes: null, malformed: true };
    }
    return {
      maxRuntimes: value.maxRuntimes ?? null,
      idleTimeoutMinutes: value.idleTimeoutMinutes ?? null,
      malformed: false,
    };
  }

  /**
   * Persists a validated settings snapshot. Writes are serialized so the last
   * accepted snapshot is the one on disk.
   */
  save(settings: Pick<StoredSettings, "maxRuntimes" | "idleTimeoutMinutes">): Promise<void> {
    const { maxRuntimes, idleTimeoutMinutes } = settings;
    if (maxRuntimes !== null && !isPositiveInteger(maxRuntimes)) {
      return Promise.reject(new Error(`max runtimes must be a positive integer (got ${String(maxRuntimes)})`));
    }
    if (idleTimeoutMinutes !== null && !isIdleTimeoutMinutes(idleTimeoutMinutes)) {
      return Promise.reject(new Error("idle timeout must be non-negative whole minutes"));
    }
    if (maxRuntimes === null && idleTimeoutMinutes === null) {
      return Promise.reject(new Error("at least one setting must be configured"));
    }
    const text = JSON.stringify({
      version: 1,
      ...(maxRuntimes !== null ? { maxRuntimes } : {}),
      ...(idleTimeoutMinutes !== null ? { idleTimeoutMinutes } : {}),
      savedAt: new Date().toISOString(),
    });
    const write = (): Promise<void> => writeTextAtomically(this.file, text);
    this.#writing = this.#writing.catch(() => {}).then(write);
    return this.#writing;
  }
}
