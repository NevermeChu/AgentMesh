import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.integ.ts"],
    testTimeout: 15_000,
  },
});
