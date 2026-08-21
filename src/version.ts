import packageJson from "../package.json" with { type: "json" };

/** Current AgentMesh package version. */
export const VERSION = packageJson.version;
