import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";

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
    target: "node22",
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
    target: "node22",
    shims: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    // The ui panel is a static single-file asset: tsup only compiles TS, so the
    // built server (dist/ui/server.js) needs panel.html copied next to itself.
    onSuccess: async () => {
      mkdirSync("dist/ui", { recursive: true });
      copyFileSync("src/ui/panel.html", "dist/ui/panel.html");
    },
  },
]);
