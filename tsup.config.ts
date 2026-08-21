import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "mcp/server": "src/mcp/server.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    shims: true,
  },
  {
    entry: {
      "cli/index": "src/cli/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node18",
    shims: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
