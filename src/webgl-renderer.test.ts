import { describe, expect, test } from "bun:test";
import { isKnownSoftwareWebglRenderer } from "./webgl-renderer";

describe("WebGL software-renderer policy", () => {
  test("selects DOM for known software rasterizers reported by the debug renderer", () => {
    expect(isKnownSoftwareWebglRenderer(
      "Google Inc.", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
    )).toBe(true);
    expect(isKnownSoftwareWebglRenderer("Mesa", "llvmpipe (LLVM 18.1.8, 256 bits)")).toBe(true);
    expect(isKnownSoftwareWebglRenderer("Mesa", "softpipe (LLVM 18.1.8, 128 bits)")).toBe(true);
    expect(isKnownSoftwareWebglRenderer("Mesa", "lavapipe (LLVM 18.1.8, 256 bits)")).toBe(true);
    expect(isKnownSoftwareWebglRenderer("Google SwiftShader", "ANGLE")).toBe(true);
  });

  test("preserves native, hardware and unrecognized renderer names on WebGL", () => {
    expect(isKnownSoftwareWebglRenderer("Apple", "Apple GPU")).toBe(false);
    expect(isKnownSoftwareWebglRenderer("Google Inc.", "ANGLE (NVIDIA GeForce RTX 4070, Vulkan)")).toBe(false);
    expect(isKnownSoftwareWebglRenderer("Unknown vendor", "Unknown renderer")).toBe(false);
    expect(isKnownSoftwareWebglRenderer(undefined, undefined)).toBe(false);
    expect(isKnownSoftwareWebglRenderer(42, null)).toBe(false);
  });
});
