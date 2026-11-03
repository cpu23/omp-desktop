import { describe, expect, test } from "bun:test";
import { parseIdleTimeoutInput } from "./runtime-settings-input";

describe("idle timeout input", () => {
  test("requires an explicit decimal value to disable or change unloading", () => {
    expect(parseIdleTimeoutInput("0")).toBe(0);
    expect(parseIdleTimeoutInput(" 60 ")).toBe(60);
    for (const value of ["", " \t ", "-1", "1.5", "1e2", "0x10", "Infinity", "NaN"]) {
      expect(parseIdleTimeoutInput(value)).toBeNull();
    }
  });
  test("rejects durations that overflow the daemon millisecond timeout", () => {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
    expect(parseIdleTimeoutInput(String(maximum))).toBe(maximum);
    expect(parseIdleTimeoutInput(String(maximum + 1))).toBeNull();
  });
});
