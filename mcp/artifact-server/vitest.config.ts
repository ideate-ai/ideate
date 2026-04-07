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
    forceExit: true,
    include: ["src/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
