import { defineConfig } from 'vitest/config';

// @ideate/plugin — standalone vitest config.
//
// Scoped to plugin tests only, and self-contained: it works when invoked
// directly from this package and when the package is copied into a scratch
// location with no surrounding workspace context (the fresh-copy check,
// scripts/fresh-copy-check.mjs).
//
// maxForks is HARD-capped at 4: the default fan-out has OOM-crashed a 32GB
// box. Do not raise without revisiting that failure mode.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
