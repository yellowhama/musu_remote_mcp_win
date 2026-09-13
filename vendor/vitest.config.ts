import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["codex/**", "node_modules/**", "dist/**"],
    // Several integration files bind ephemeral HTTP servers. Serial files avoid
    // port handoff and connection-reset races in constrained Docker/CI runners.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
