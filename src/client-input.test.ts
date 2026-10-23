import { describe, expect, test } from "bun:test";
import { MAX_INPUT_CHUNK_CODE_UNITS, splitInputChunks } from "./client-input";

describe("terminal input chunking", () => {
  test("keeps each protocol frame within the code-unit limit and preserves order", () => {
    const input = "x".repeat(MAX_INPUT_CHUNK_CODE_UNITS * 2 + 3);
    const chunks = Array.from(splitInputChunks(input));

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      MAX_INPUT_CHUNK_CODE_UNITS,
      MAX_INPUT_CHUNK_CODE_UNITS,
      3,
    ]);
    expect(chunks.join("")).toBe(input);
  });

  test("does not split a surrogate pair at the chunk boundary", () => {
    const prefix = "x".repeat(MAX_INPUT_CHUNK_CODE_UNITS - 1);
    const input = `${prefix}💡tail`;
    const chunks = Array.from(splitInputChunks(input));

    expect(chunks[0]).toBe(prefix);
    expect(chunks[1]).toBe("💡tail");
    expect(chunks.every((chunk) => chunk.length <= MAX_INPUT_CHUNK_CODE_UNITS)).toBe(true);
    expect(chunks.join("")).toBe(input);
  });
});
