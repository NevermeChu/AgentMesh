import type { AgentAdapter, AgentExecutableInfo, AgentName } from "./types.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";
import { AntigravityAdapter } from "./antigravity.js";
import { GrokAdapter } from "./grok.js";
import { OpenCodeAdapter } from "./opencode.js";
import { ZCodeAdapter } from "./zcode.js";

export class AgentRegistry {
  private adapters = new Map<AgentName, AgentAdapter>();
  private aliasMap = new Map<string, AgentName>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaultAdapters: AgentAdapter[] = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new AntigravityAdapter(),
      new GrokAdapter(),
      new OpenCodeAdapter(),
      new ZCodeAdapter(),
    ];

    for (const adapter of defaultAdapters) {
      this.register(adapter);
    }
  }

  public register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
    this.aliasMap.set(adapter.name.toLowerCase(), adapter.name);

    if (adapter.aliases) {
      for (const alias of adapter.aliases) {
        this.aliasMap.set(alias.toLowerCase(), adapter.name);
      }
    }
  }

  /**
   * Resolves an agent name or alias to the canonical AgentName.
   */
  public resolveName(nameOrAlias: string): AgentName | undefined {
    return this.aliasMap.get(nameOrAlias.toLowerCase().trim());
  }

  /**
   * Gets the adapter for a given agent name or alias.
   */
  public getAdapter(nameOrAlias: string): AgentAdapter | undefined {
    const canonicalName = this.resolveName(nameOrAlias);
    if (!canonicalName) return undefined;
    return this.adapters.get(canonicalName);
  }

  /**
   * Returns all registered adapters.
   */
  public getAllAdapters(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Returns a list of canonical names and aliases.
   */
  public listSupportedNames(): string[] {
    return Array.from(this.aliasMap.keys());
  }

  /**
   * Scans and returns availability status for all registered agents.
   * The scan is eager: routing-table views (list_agents) front-load it so one
   * read yields live availability for every channel.
   */
  public async listAgentAvailability(): Promise<
    Array<{
      name: AgentName;
      displayName: string;
      aliases: string[];
      available: boolean;
      info: AgentExecutableInfo;
    }>
  > {
    const results = [];
    for (const adapter of this.adapters.values()) {
      const info = await adapter.getExecutableInfo();
      results.push({
        name: adapter.name,
        displayName: adapter.displayName,
        aliases: [...(adapter.aliases ?? [])],
        available: info.available,
        info,
      });
    }
    return results;
  }
}

export const defaultRegistry = new AgentRegistry();
