import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 2,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
