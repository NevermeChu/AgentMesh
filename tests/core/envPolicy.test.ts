import { describe, it, expect } from "vitest";
import {
  ENV_INHERIT_BASELINE_KEYS,
  ENV_PERMANENT_BLACKLIST_KEYS,
  ENV_PERMANENT_BLACKLIST_PREFIXES,
  ENV_OVERRIDE_ALLOWED_KEYS,
  isPermanentBlacklistedEnvKey,
  isEnvOverrideAllowed,
  filterEnvOverrides,
  filterInheritedEnvironment,
  buildPolicyChildEnvironment,
  formatEnvOverrideWarning,
} from "../../src/core/envPolicy.js";

describe("core/envPolicy", () => {
  it("keeps the cross-platform baseline set documented by OPTIMIZATION_PLAN T3.3", () => {
    const upper = new Set(ENV_INHERIT_BASELINE_KEYS.map((k) => k.toUpperCase()));
    for (const required of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "LANG",
      "TZ",
      "SYSTEMROOT",
      "COMSPEC",
    ]) {
      expect(upper.has(required)).toBe(true);
    }
  });

  it("blacklists every permanently forbidden key from the plan", () => {
    const upper = new Set(ENV_PERMANENT_BLACKLIST_KEYS.map((k) => k.toUpperCase()));
    for (const required of [
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "DOCKER_HOST",
      "KUBECONFIG",
    ]) {
      expect(upper.has(required)).toBe(true);
    }
    expect(ENV_PERMANENT_BLACKLIST_PREFIXES.map((p) => p.toUpperCase())).toContain("AWS_");
  });

  it("detects blacklisted keys case-insensitively and by prefix", () => {
    expect(isPermanentBlacklistedEnvKey("LD_PRELOAD")).toBe(true);
    // S9 boundary variant: case variants must not slip through.
    expect(isPermanentBlacklistedEnvKey("node_options")).toBe(true);
    expect(isPermanentBlacklistedEnvKey("Node_OPTIONS")).toBe(true);
    expect(isPermanentBlacklistedEnvKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isPermanentBlacklistedEnvKey("aws_region")).toBe(true);
    expect(isPermanentBlacklistedEnvKey("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isPermanentBlacklistedEnvKey("NPM_CONFIG_REGISTRY")).toBe(true);

    expect(isPermanentBlacklistedEnvKey("TZ")).toBe(false);
    expect(isPermanentBlacklistedEnvKey("TASKX_AWSOME_VAR")).toBe(false);
    expect(isPermanentBlacklistedEnvKey("")).toBe(false);
  });

  it("accepts only whitelisted override keys", () => {
    expect(isEnvOverrideAllowed("NODE_ENV")).toBe(true);
    expect(isEnvOverrideAllowed("tz")).toBe(true);
    expect(isEnvOverrideAllowed("ANTHROPIC_API_KEY")).toBe(true);

    expect(isEnvOverrideAllowed("GITHUB_TOKEN")).toBe(false);
    // Execution-critical baseline keys are inherited only, never overridable.
    expect(isEnvOverrideAllowed("PATH")).toBe(false);
    expect(isEnvOverrideAllowed("path")).toBe(false);
    expect(isEnvOverrideAllowed("SystemRoot")).toBe(false);
    expect(isEnvOverrideAllowed("HOME")).toBe(false);
    // Blacklist always wins over any future whitelist entry.
    expect(isEnvOverrideAllowed("DOCKER_HOST")).toBe(false);
    expect(isEnvOverrideAllowed("aws_access_key_id")).toBe(false);
    expect(isEnvOverrideAllowed("")).toBe(false);
  });

  it("splits overrides into accepted and rejected key lists", () => {
    const result = filterEnvOverrides({
      TZ: "Asia/Shanghai",
      NODE_ENV: "production",
      GITHUB_TOKEN: "ghp_secret",
      DOCKER_HOST: "tcp://evil.example:2375",
      AWS_SECRET_ACCESS_KEY: "leak",
    });
    expect(result.accepted).toEqual({ TZ: "Asia/Shanghai", NODE_ENV: "production" });
    expect(result.rejectedKeys).toEqual(["GITHUB_TOKEN", "DOCKER_HOST", "AWS_SECRET_ACCESS_KEY"]);
  });

  it("reports rejected keys with their original spelling exactly once", () => {
    const result = filterEnvOverrides({ Node_Options: "--inspect" });
    expect(result.accepted).toEqual({});
    expect(result.rejectedKeys).toEqual(["Node_Options"]);
    expect(filterEnvOverrides(undefined).rejectedKeys).toEqual([]);
    expect(filterEnvOverrides(undefined).accepted).toEqual({});
  });

  it("drops non-string values instead of coercing them", () => {
    const hostile = { TZ: "UTC", WEIRD: undefined } as unknown as Record<string, string>;
    const result = filterEnvOverrides(hostile);
    expect(Object.keys(result.accepted)).toEqual(["TZ"]);
    expect(result.rejectedKeys).toEqual(["WEIRD"]);
  });

  it("strips blacklisted variables from the inherited parent snapshot", () => {
    const parent = {
      PATH: "C:/tools",
      SYSTEMROOT: "C:/WINDOWS",
      LD_PRELOAD: "/tmp/evil.so",
      NODE_OPTIONS: "--require /tmp/evil.js",
      AWS_PROFILE: "prod",
      EMPTY: undefined,
    };
    const inherited = filterInheritedEnvironment(parent);
    expect(inherited.PATH).toBe("C:/tools");
    expect(inherited.SYSTEMROOT).toBe("C:/WINDOWS");
    expect(inherited.LD_PRELOAD).toBeUndefined();
    expect(inherited.NODE_OPTIONS).toBeUndefined();
    expect(inherited.AWS_PROFILE).toBeUndefined();
    expect(inherited.EMPTY).toBeUndefined();
  });

  it("builds the child environment from parent baseline plus accepted overrides", () => {
    if (process.platform === "win32") {
      const { env, rejectedKeys } = buildPolicyChildEnvironment(
        "D:/repo",
        { TZ: "UTC", LD_PRELOAD: "x" },
        { PATH: "C:/bin", COMSPEC: "C:/WINDOWS/cmd.exe", LD_PRELOAD: "x" },
      );
      expect(env.PATH).toBe("C:/bin");
      expect(env.COMSPEC).toBe("C:/WINDOWS/cmd.exe");
      expect(env.TZ).toBe("UTC");
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.PWD).toBeUndefined();
      expect(rejectedKeys).toEqual(["LD_PRELOAD"]);
    } else {
      const cwd = "/tmp/repo";
      const { env, rejectedKeys } = buildPolicyChildEnvironment(
        cwd,
        { LANG: "C.UTF-8", PYTHONPATH: "/tmp/evil" },
        { PATH: "/usr/bin", HOME: "/root", OLDPWD: "/elsewhere", PYTHONPATH: "/tmp/evil" },
      );
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/root");
      expect(env.LANG).toBe("C.UTF-8");
      expect(env.PYTHONPATH).toBeUndefined();
      expect(env.PWD).toBe(cwd);
      expect(env.OLDPWD).toBe("/elsewhere");
      expect(rejectedKeys).toEqual(["PYTHONPATH"]);
    }
  });

  it("guarantees every present baseline key survives into the child environment", () => {
    const parent: Record<string, string> = {};
    for (const key of ENV_INHERIT_BASELINE_KEYS) {
      if (key === "PWD" || key === "OLDPWD") continue;
      parent[key] = `value-of-${key}`;
    }
    const { env, rejectedKeys } = buildPolicyChildEnvironment("D:/repo", {}, parent);
    expect(rejectedKeys).toEqual([]);
    for (const key of Object.keys(parent)) {
      expect(env[key]).toBe(`value-of-${key}`);
    }
  });

  it("formats the response warning without leaking values", () => {
    expect(formatEnvOverrideWarning([])).toBeUndefined();
    const warning = formatEnvOverrideWarning(["DOCKER_HOST", "AWS_REGION"]);
    expect(warning).toContain("envOverrideRejected:[DOCKER_HOST,AWS_REGION]");
    expect(warning?.toLowerCase()).not.toContain("tcp://");
  });

  it("covers every whitelist entry against the blacklist sets", () => {
    for (const key of ENV_OVERRIDE_ALLOWED_KEYS) {
      expect(isPermanentBlacklistedEnvKey(key)).toBe(false);
    }
    for (const key of ENV_PERMANENT_BLACKLIST_KEYS) {
      expect(isEnvOverrideAllowed(key)).toBe(false);
    }
  });
});
