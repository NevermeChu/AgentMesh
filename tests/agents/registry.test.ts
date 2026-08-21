import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../../src/agents/registry.js";

describe("agents/registry", () => {
  it("should register default adapters and resolve aliases", () => {
    const registry = new AgentRegistry();

    // Canonical names
    expect(registry.getAdapter("codex")?.name).toBe("codex");
    expect(registry.getAdapter("claude")?.name).toBe("claude");
    expect(registry.getAdapter("antigravity")?.name).toBe("antigravity");
    expect(registry.getAdapter("grok")?.name).toBe("grok");
    expect(registry.getAdapter("opencode")?.name).toBe("opencode");
    expect(registry.getAdapter("zcode")?.name).toBe("zcode");

    // Aliases
    expect(registry.getAdapter("gemini")?.name).toBe("antigravity");
    expect(registry.getAdapter("agy")?.name).toBe("antigravity");
    expect(registry.getAdapter("claude-code")?.name).toBe("claude");
    expect(registry.getAdapter("grok-build")?.name).toBe("grok");
    expect(registry.getAdapter("opencode-ai")?.name).toBe("opencode");
  });

  it("should return undefined for unknown agents", () => {
    const registry = new AgentRegistry();
    expect(registry.getAdapter("unknown_robot")).toBeUndefined();
  });

  it("should list availability of all registered agents", async () => {
    const registry = new AgentRegistry();
    const list = await registry.listAgentAvailability();

    expect(list.length).toBeGreaterThanOrEqual(6);
    const names = list.map((a) => a.name);
    expect(names).toContain("codex");
    expect(names).toContain("antigravity");
    expect(names).toContain("grok");
    expect(names).toContain("claude");
  });
});
