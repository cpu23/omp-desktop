/**
 * Regression tests for daemon-owned runtime settings: precedence, persistence,
 * malformed documents and serialized writes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonSettingsStore,
  isPositiveInteger,
  parsePositiveInteger,
  resolveMaxRuntimes,
  resolveIdleTimeoutMinutes,
  SETTINGS_LIMIT_BYTES,
} from "./settings";

const defaultLimit = resolveMaxRuntimes(null, undefined);

const dir = mkdtempSync(join(tmpdir(), "omp-settings-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime limit resolution", () => {

  test("the environment is a fallback, not an override of a saved value", () => {
    expect(resolveMaxRuntimes(null, "8")).toEqual({ maxRuntimes: 8, source: "env" });
    expect(resolveMaxRuntimes(24, "8")).toEqual({ maxRuntimes: 24, source: "saved" });
  });

  test("only positive integers are limits in either source", () => {
    for (const value of [0, -1, 1.5, "8", Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      expect(resolveMaxRuntimes(value, "12")).toEqual({ maxRuntimes: 12, source: "env" });
    }
    for (const value of ["", " ", "0", "-3", "2.5", "8x", "1e3"]) {
      expect(resolveMaxRuntimes(20, value)).toEqual({ maxRuntimes: 20, source: "saved" });
      expect(resolveMaxRuntimes(null, value)).toEqual(defaultLimit);
    }
  });

  test("parsePositiveInteger accepts surrounding whitespace and rejects anything else", () => {
    expect(parsePositiveInteger(" 12 ")).toBe(12);
    expect(parsePositiveInteger(undefined)).toBeNull();
    expect(parsePositiveInteger("")).toBeNull();
    expect(parsePositiveInteger("0")).toBeNull();
    expect(parsePositiveInteger("1.0")).toBeNull();
  });

  test("isPositiveInteger is the API body guard", () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(32)).toBe(true);
    for (const value of [0, -1, 2.5, "2", null, undefined, {}]) expect(isPositiveInteger(value)).toBe(false);
  });
});
describe("idle timeout resolution", () => {
  test("saved values, including disabled, outrank the deployment fallback", () => {
    expect(resolveIdleTimeoutMinutes(15, "90")).toBe(15);
    expect(resolveIdleTimeoutMinutes(0, "90")).toBe(0);
    expect(resolveIdleTimeoutMinutes(null, "0")).toBe(0);
    expect(resolveIdleTimeoutMinutes(null, " 90 ")).toBe(90);
  });

  test("invalid durations cannot turn into a different or overflowing timeout", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "0"]) {
      expect(resolveIdleTimeoutMinutes(value, "45")).toBe(45);
    }
    for (const value of ["-1", "1.5", "1e3", "minutes", "", String(Number.MAX_SAFE_INTEGER)]) {
      expect(resolveIdleTimeoutMinutes(null, value)).toBe(60);
    }
  });
});



describe("daemon settings store", () => {
  test("round-trips a saved limit and reports an absent file as clean", async () => {
    const file = join(dir, "absent", "settings.json");
    const store = new DaemonSettingsStore(file);
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: false });
    await store.save({ maxRuntimes: 24, idleTimeoutMinutes: 30 });
    expect(await store.read()).toEqual({ maxRuntimes: 24, idleTimeoutMinutes: 30, malformed: false });
    await store.save({ maxRuntimes: 7, idleTimeoutMinutes: 0 });
    expect((await store.read()).maxRuntimes).toBe(7);
  });

  test("rejects an invalid save instead of writing a document that would be ignored", async () => {
    const store = new DaemonSettingsStore(join(dir, "invalid", "settings.json"));
    await expect(store.save({ maxRuntimes: 0, idleTimeoutMinutes: 60 })).rejects.toThrow();
    await expect(store.save({ maxRuntimes: 2, idleTimeoutMinutes: -1 })).rejects.toThrow();
    await expect(store.save({ maxRuntimes: 2, idleTimeoutMinutes: 1.5 })).rejects.toThrow();
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: false });
  });

  test("a corrupt or invalid document falls back cleanly", async () => {
    const file = join(dir, "corrupt", "settings.json");
    const store = new DaemonSettingsStore(file);
    await store.save({ maxRuntimes: 1, idleTimeoutMinutes: 60 });
    writeFileSync(file, "{not json");
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: true });
    writeFileSync(file, JSON.stringify({ version: 1, maxRuntimes: -2 }));
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: true });
    writeFileSync(file, JSON.stringify({ version: 1, maxRuntimes: 4, idleTimeoutMinutes: -1 }));
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: true });
    writeFileSync(file, "x".repeat(SETTINGS_LIMIT_BYTES + 1));
    expect(await store.read()).toEqual({ maxRuntimes: null, idleTimeoutMinutes: null, malformed: true });
  });

  test("pre-timeout settings retain their saved pool limit", async () => {
    const file = join(dir, "legacy-settings.json");
    writeFileSync(file, JSON.stringify({ version: 1, maxRuntimes: 12 }));
    expect(await new DaemonSettingsStore(file).read()).toEqual({
      maxRuntimes: 12, idleTimeoutMinutes: null, malformed: false,
    });
  });

  test("saving one setting leaves the other inherited from deployment configuration", async () => {
    const store = new DaemonSettingsStore(join(dir, "independent", "settings.json"));
    await store.save({ maxRuntimes: null, idleTimeoutMinutes: 5 });
    const timeoutOnly = await new DaemonSettingsStore(store.file).read();
    expect(resolveMaxRuntimes(timeoutOnly.maxRuntimes, "7").maxRuntimes).toBe(7);
    expect(resolveIdleTimeoutMinutes(timeoutOnly.idleTimeoutMinutes, "20")).toBe(5);
    await store.save({ maxRuntimes: 4, idleTimeoutMinutes: null });
    const limitOnly = await new DaemonSettingsStore(store.file).read();
    expect(resolveMaxRuntimes(limitOnly.maxRuntimes, "7").maxRuntimes).toBe(4);
    expect(resolveIdleTimeoutMinutes(limitOnly.idleTimeoutMinutes, "20")).toBe(20);
  });

  test("concurrent saves land in call order; the last one wins", async () => {
    const store = new DaemonSettingsStore(join(dir, "concurrent", "settings.json"));
    const writes = [5, 9, 3].map((maxRuntimes) =>
      store.save({ maxRuntimes, idleTimeoutMinutes: maxRuntimes * 10 }),
    );
    await Promise.all(writes);
    expect(await store.read()).toEqual({ maxRuntimes: 3, idleTimeoutMinutes: 30, malformed: false });
  });
});
