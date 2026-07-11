import { defineConfig } from 'vitest/config';

// @ideate/plugin — standalone vitest config.
//
// Scoped to plugin tests only, and self-contained: this file must work both
// (a) invoked directly from `plugin/` inside the monorepo, and (b) invoked
// from `plugin/` copied into a repo of its own with no workspace context
// (P-34 fresh-copy test, scripts/fresh-copy-check.mjs). It intentionally does
// NOT extend or reference the monorepo root vitest.config.ts.
//
// maxForks is HARD-capped at 4: the default fan-out OOM-crashed a 32GB box
// during v2. Do not raise without revisiting that failure mode (see the root
// vitest.config.ts, which carries the identical cap for the same reason).
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
