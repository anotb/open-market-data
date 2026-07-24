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
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 70,
				statements: 70,
			},
		},
	},
})
