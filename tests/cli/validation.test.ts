import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_MS, parseMode, parseRole, parseTimeout } from "../../src/cli/validation.js";

describe("cli/validation", () => {
  it("accepts supported roles and modes", () => {
    expect(parseRole("reviewer")).toBe("reviewer");
    expect(parseMode("mcp")).toBe("mcp");
  });

  it("rejects invalid roles and modes instead of silently using worker or CLI behavior", () => {
    expect(() => parseRole("reviewre")).toThrow("Role must be");
    expect(() => parseMode("typo")).toThrow("Mode must be");
  });

  it("requires a positive bounded integer timeout", () => {
    expect(parseTimeout("1500")).toBe(1500);
    for (const invalid of ["abc", "0", "-1", "1.5", String(MAX_TIMEOUT_MS + 1)]) {
      expect(() => parseTimeout(invalid)).toThrow("Timeout must be");
    }
  });
});
