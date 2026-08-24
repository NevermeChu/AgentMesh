import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCapabilities, readCapabilities } from "../../src/core/capabilities.js";

describe("core/capabilities", () => {
  it("generates an idempotent non-sensitive project capability file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-capabilities-"));
    fs.mkdirSync(path.join(root, ".agentmesh"));
    fs.writeFileSync(path.join(root, ".agentmesh", "config.json"), '{"version":1,"roles":{}}');
    const first = generateCapabilities(root);
    const second = generateCapabilities(root);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(readCapabilities(root).capabilities.codex?.transports.mcp?.model?.supported).toBe(false);
    const contents = fs.readFileSync(first.path, "utf8");
    expect(contents).not.toMatch(/token|secret|authorization|session/i);
  });

  it("does not overwrite an existing file without force", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-capabilities-"));
    fs.mkdirSync(path.join(root, ".agentmesh"));
    fs.writeFileSync(path.join(root, ".agentmesh", "config.json"), '{"version":1,"roles":{}}');
    const first = generateCapabilities(root);
    const before = fs.readFileSync(first.path, "utf8");
    const second = generateCapabilities(root);
    expect(second.created).toBe(false);
    expect(fs.readFileSync(first.path, "utf8")).toBe(before);
  });
});
