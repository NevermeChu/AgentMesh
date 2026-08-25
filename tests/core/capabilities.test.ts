import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateModelOptionSupport,
  generateCapabilities,
  readCapabilities,
} from "../../src/core/capabilities.js";

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

  describe("evaluateModelOptionSupport", () => {
    it("flags model requests on a transport that does not support them (static fallback)", () => {
      // Directory without .agentmesh/config.json: falls back to the static matrix.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-cap-nofile-"));
      const diagnostics = evaluateModelOptionSupport({
        agent: "codex",
        transportUsed: "mcp",
        model: "gpt-5-codex",
        startDirectory: root,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("Capability diagnostic");
      expect(diagnostics[0]).toContain("model 'gpt-5-codex'");
      expect(diagnostics[0]).toContain("codex via mcp");
      expect(diagnostics[0]).toContain("NOT applied");
    });

    it("stays silent when the executed transport supports the requested options", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-cap-ok-"));
      expect(
        evaluateModelOptionSupport({
          agent: "codex",
          transportUsed: "cli",
          model: "o3",
          reasoningEffort: "high",
          startDirectory: root,
        }),
      ).toEqual([]);
    });

    it("reports missing capability declarations for undeclared transports", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-cap-undeclared-"));
      const diagnostics = evaluateModelOptionSupport({
        agent: "antigravity",
        transportUsed: "mcp",
        reasoningEffort: "high",
        startDirectory: root,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("reasoningEffort='high'");
      expect(diagnostics[0]).toContain("declares no reasoningEffort support");
    });

    it("uses an explicit capabilities.json values list when present", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-cap-explicit-"));
      fs.mkdirSync(path.join(root, ".agentmesh"));
      fs.writeFileSync(path.join(root, ".agentmesh", "config.json"), '{"version":1,"roles":{}}');
      fs.writeFileSync(
        path.join(root, ".agentmesh", "capabilities.json"),
        JSON.stringify({
          schemaVersion: 1,
          generatedBy: { packageVersion: "0.1.0", at: new Date().toISOString() },
          configVersion: 1,
          capabilities: {
            codex: {
              transports: {
                cli: { model: { supported: true, flag: "--model", values: ["o3", "o4-mini"] } },
              },
            },
          },
          provenance: { source: "manual", commands: [] },
        }),
      );
      const mismatch = evaluateModelOptionSupport({
        agent: "codex",
        transportUsed: "cli",
        model: "gpt-5-codex",
        startDirectory: root,
      });
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]).toContain("[o3, o4-mini]");
      expect(
        evaluateModelOptionSupport({
          agent: "codex",
          transportUsed: "cli",
          model: "o4-mini",
          startDirectory: root,
        }),
      ).toEqual([]);
    });

    it("returns nothing when no vendor options were requested", () => {
      expect(evaluateModelOptionSupport({ agent: "codex", transportUsed: "mcp" })).toEqual([]);
    });
  });
});
