import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAUDE_SETTING_SOURCES_FLAG,
  CLAUDE_WORKER_DENY_RULES,
  buildClaudePolicySettingsContent,
  buildClaudeWorkerInjectionArgs,
  describeClaudeDenyPolicy,
  getClaudePolicyDirectoryPath,
  getClaudePolicySettingsPath,
  sanitizePolicySessionSlug,
} from "../../src/core/policyTemplates.js";

describe("core/policyTemplates", () => {
  it("emits the plan T3.2 deny template for secrets, git, agentmesh and fetch tools", () => {
    const upper = CLAUDE_WORKER_DENY_RULES.map((rule) => rule.toLowerCase());
    // .env* coverage (S9 case variant: the rule text is preserved verbatim so
    // vendor glob matching handles platform casing; assert exact spelling).
    expect(CLAUDE_WORKER_DENY_RULES).toContain("Read(.env*)");
    expect(CLAUDE_WORKER_DENY_RULES).toContain("Edit(**/.env*)");
    expect(upper.some((rule) => rule.startsWith("read(") && rule.includes(".env"))).toBe(true);
    expect(upper.some((rule) => rule.includes("~/.ssh/**"))).toBe(true);
    expect(upper.some((rule) => rule.includes(".git/**"))).toBe(true);
    expect(upper.some((rule) => rule.includes("**/.agentmesh/**"))).toBe(true);
    for (const tool of ["curl", "wget", "sudo"]) {
      expect(CLAUDE_WORKER_DENY_RULES).toContain(`Bash(${tool}:*)`);
    }
    // Path rules must deny both reads and edits.
    expect(upper.filter((rule) => rule.startsWith("read(")).length).toBeGreaterThanOrEqual(4);
    expect(upper.filter((rule) => rule.startsWith("edit(")).length).toBeGreaterThanOrEqual(4);
  });

  it("generates parseable settings.json with a permissions.deny list", () => {
    const content = buildClaudePolicySettingsContent();
    const parsed = JSON.parse(content) as {
      permissions: { deny: string[] };
    };
    expect(parsed.permissions.deny).toEqual([...CLAUDE_WORKER_DENY_RULES]);
    // Custom rules pass through untouched (case preserved).
    const custom = buildClaudePolicySettingsContent(["Read(.ENV*)"]);
    expect(custom).toContain('"Read(.ENV*)"');
  });

  it("reduces session ids to a single safe slug segment", () => {
    expect(sanitizePolicySessionSlug(undefined)).toBe("adhoc");
    expect(sanitizePolicySessionSlug("")).toBe("adhoc");
    expect(sanitizePolicySessionSlug("   ")).toBe("adhoc");
    expect(sanitizePolicySessionSlug("sess-1234_abcd")).toBe("sess-1234_abcd");
    expect(sanitizePolicySessionSlug("SessionABC")).toBe("SessionABC");
  });

  it("neutralizes traversal chains, separators and drive colons (S9)", () => {
    for (const hostile of [
      "../..",
      "..\\..",
      "../../etc",
      "a/b/c",
      "a\\b\\c",
      "C:\\Users\\evil",
      "..%2F..%2Fevil",
      ".../...//...",
    ]) {
      const slug = sanitizePolicySessionSlug(hostile);
      expect(slug).not.toContain("/");
      expect(slug).not.toContain("\\");
      expect(slug).not.toContain(":");
      expect(slug).not.toBe(".");
      expect(slug).not.toBe("..");
      expect(slug.length).toBeGreaterThan(0);
    }
    expect(sanitizePolicySessionSlug("../..")).toBe("adhoc");
    expect(sanitizePolicySessionSlug("a/b")).toBe("a_b");
  });

  it("keeps symlink-style and dotfile identifiers inside one segment", () => {
    // A hostile id pointing at an existing directory elsewhere cannot produce a
    // multi-segment or dot-prefixed path component.
    const slug = sanitizePolicySessionSlug("../../../../tmp/linked");
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(slug.startsWith(".")).toBe(false);
  });

  it("avoids Windows reserved device names", () => {
    for (const reserved of ["CON", "nul", "COM1", "lpt4", "PRN.json"]) {
      expect(sanitizePolicySessionSlug(reserved)).toBe("adhoc");
    }
  });

  it("caps slugs at 64 characters", () => {
    const long = "s".repeat(200);
    expect(sanitizePolicySessionSlug(long)).toHaveLength(64);
  });

  it("builds policy paths under the home policy root only", () => {
    const home = path.join(os.tmpdir(), "agentmesh-policy-home");
    const dir = getClaudePolicyDirectoryPath(home, "native-thread-42");
    const settingsPath = getClaudePolicySettingsPath(home, "native-thread-42");
    expect(dir).toBe(path.join(home, ".agentmesh", "policy", "native-thread-42"));
    expect(settingsPath).toBe(path.join(dir, "settings.json"));

    const root = path.join(home, ".agentmesh", "policy") + path.sep;
    for (const hostile of ["../..", "C:/evil", "..%2F.."]) {
      expect(getClaudePolicySettingsPath(home, hostile).startsWith(root)).toBe(true);
    }
    expect(getClaudePolicySettingsPath(home).endsWith(path.join("adhoc", "settings.json"))).toBe(
      true,
    );
  });

  it("writes the generated settings inside the policy root without escaping", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-policy-root-"));
    try {
      const settingsPath = getClaudePolicySettingsPath(root, "../../../outside");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildClaudePolicySettingsContent(), "utf8");

      expect(fs.existsSync(settingsPath)).toBe(true);
      // The written file must stay below the root even for a traversal id.
      const relative = path.relative(root, settingsPath);
      expect(relative.startsWith("..")).toBe(false);
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        permissions: { deny: string[] };
      };
      expect(written.permissions.deny.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds --settings plus --setting-sources injection arguments", () => {
    const args = buildClaudeWorkerInjectionArgs("D:/home/.agentmesh/policy/s1/settings.json");
    expect(args).toEqual([
      "--settings",
      "D:/home/.agentmesh/policy/s1/settings.json",
      "--setting-sources",
      CLAUDE_SETTING_SOURCES_FLAG,
    ]);
    expect(CLAUDE_SETTING_SOURCES_FLAG).toBe("user,project,local");
  });

  it("describes the active deny list for response disclosure", () => {
    const text = describeClaudeDenyPolicy();
    expect(text).toContain(String(CLAUDE_WORKER_DENY_RULES.length));
    expect(text).toContain("Bash(curl:*)");
    expect(text).toContain("deny rules");
  });
});
