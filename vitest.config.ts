import { defineConfig } from 'vitest/config'

/**
 * Default suite: fully deterministic. Every provider test mocks `fetch`, so
 * this config never touches the network and is safe to run in CI or offline.
 *
 * Network-dependent smoke tests live in `tests/live/` and run via
 * `pnpm test:live` (see vitest.live.config.ts).
 */
export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/live/**', 'node_modules/**', 'dist/**'],
		// Deterministic tests should be fast; a hang is a bug, not a slow network.
		testTimeout: 10_000,
		// Auto-cleanup between tests so one file's spies/stubs can't leak.
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// cli.ts is pure commander wiring, exercised by tests/cli.
			exclude: ['src/cli.ts', 'src/types.ts', 'src/providers/types.ts'],
			reporter: ['text', 'html', 'lcov', 'json-summary'],
			reportsDirectory: './coverage',
			// Set just below what the suite actually achieves, so an uncovered new
			// branch trips CI rather than quietly eroding coverage. src/core is held
			// at a strict 100% — it is the routing, caching, and config logic every
			// command depends on.
			thresholds: {
				lines: 99,
				functions: 100,
				branches: 98,
				statements: 99,
				'src/core/**': {
					lines: 100,
					functions: 100,
					branches: 100,
					statements: 100,
				},
			},
		},
	},
})
