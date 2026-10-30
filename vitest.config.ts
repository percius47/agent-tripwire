import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 2,
    // Git fixture tests can spike under fork contention on a busy host.
    testTimeout: 20_000,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
