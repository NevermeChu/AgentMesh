import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { VERSION } from "../../src/version.js";

describe("VERSION", () => {
  it("matches the package version", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
