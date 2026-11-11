import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "modules/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts", "apps/bridge/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // PGlite instances are heavy; keep files isolated but avoid oversubscribing.
    pool: "forks",
  },
});
