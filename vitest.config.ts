import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Windows dev machines with real-time AV scanning make small-file-heavy
    // tests (repository fingerprint loops, git fixtures) exceed the 5s
    // default; 20s removes that flake class without masking real hangs.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/cli/index.ts", "src/**/types.ts"],
      thresholds: {
        statements: 60,
        branches: 65,
        functions: 75,
        lines: 60,
      },
    },
  },
});
