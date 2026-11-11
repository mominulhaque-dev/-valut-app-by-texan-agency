import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // The first run downloads a MongoDB binary for the integration tests.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
