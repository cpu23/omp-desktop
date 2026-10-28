/**
 * Regression tests for the daemon-owned runtime limit.
 *
 * Precedence is the behavior the Settings screen relies on: a saved limit must
 * outrank the deployment fallback even across restarts, while an absent or
 * malformed file must still leave the daemon with a usable limit. The payload
 * test pins the restart-required transition without involving HTTP.
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
  SETTINGS_LIMIT_BYTES,
  settingsPayload,
} from "./settings";

const defaultLimit = resolveMaxRuntimes(null, undefined);

const dir = mkdtempSync(join(tmpdir(), "omp-settings-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime limit resolution", () => {
  test("uses a positive default when nothing is configured", () => {
    expect(defaultLimit.source).toBe("default");
    expect(isPositiveInteger(defaultLimit.maxRuntimes)).toBe(true);
    expect(resolveMaxRuntimes(null, undefined)).toEqual(defaultLimit);
  });

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

describe("restart-required transitions", () => {
  test("a saved change is reported until the effective limit changes", () => {
    const effective = defaultLimit.maxRuntimes;
    const changed = effective + 8;
    const otherChanged = effective === 1 ? 2 : effective - 1;
    expect(settingsPayload(effective, effective)).toEqual({
      maxRuntimes: effective,
      effectiveMaxRuntimes: effective,
      restartRequired: false,
    });
    expect(settingsPayload(changed, effective)).toEqual({
      maxRuntimes: changed,
      effectiveMaxRuntimes: effective,
      restartRequired: true,
    });
    expect(settingsPayload(otherChanged, effective)).toEqual({
      maxRuntimes: otherChanged,
      effectiveMaxRuntimes: effective,
      restartRequired: true,
    });
    // After a restart the saved value becomes effective, so the flag clears
    // even when the number itself did not change again.
    expect(settingsPayload(changed, changed).restartRequired).toBe(false);
  });
});

describe("daemon settings store", () => {
  test("round-trips a saved limit and reports an absent file as clean", async () => {
    const file = join(dir, "absent", "settings.json");
    const store = new DaemonSettingsStore(file);
    expect(await store.read()).toEqual({ maxRuntimes: null, malformed: false });
    await store.save(24);
    expect(await store.read()).toEqual({ maxRuntimes: 24, malformed: false });
    await store.save(7);
    expect((await store.read()).maxRuntimes).toBe(7);
  });

  test("rejects an invalid save instead of writing a document that would be ignored", async () => {
    const store = new DaemonSettingsStore(join(dir, "invalid", "settings.json"));
    await expect(store.save(0)).rejects.toThrow(/positive integer/);
    await expect(store.save(1.5)).rejects.toThrow(/positive integer/);
    expect(await store.read()).toEqual({ maxRuntimes: null, malformed: false });
  });

  test("a corrupt or invalid document falls back cleanly", async () => {
    const file = join(dir, "corrupt", "settings.json");
    const store = new DaemonSettingsStore(file);
    await store.save(1);
    writeFileSync(file, "{not json");
    expect(await store.read()).toEqual({ maxRuntimes: null, malformed: true });
    writeFileSync(file, JSON.stringify({ version: 1, maxRuntimes: -2 }));
    expect(await store.read()).toEqual({ maxRuntimes: null, malformed: true });
    writeFileSync(file, "x".repeat(SETTINGS_LIMIT_BYTES + 1));
    expect(await store.read()).toEqual({ maxRuntimes: null, malformed: true });
  });

  test("concurrent saves land in call order; the last one wins", async () => {
    const store = new DaemonSettingsStore(join(dir, "concurrent", "settings.json"));
    const writes = [store.save(5), store.save(9), store.save(3)];
    await Promise.all(writes);
    expect((await store.read()).maxRuntimes).toBe(3);
  });
});
