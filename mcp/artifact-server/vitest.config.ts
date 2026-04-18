import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    testTimeout: 10_000,
    // Surface slow cleanup rather than silently waiting forever.
    // Tests with genuinely slow teardown (e.g. chokidar close, DB flush)
    // should complete well within 5 s; exceeding this threshold indicates
    // a lingering handle that forceExit would otherwise paper over.
    hookTimeout: 5_000,
    teardownTimeout: 5_000,
    include: ["src/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
