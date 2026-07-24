import { defineConfig } from 'vitest/config'

/**
 * Live smoke tests. These hit real third-party APIs and are therefore slow and
 * occasionally flaky (rate limits, geo-restrictions, upstream outages). They
 * are excluded from `pnpm test` on purpose — run them with `pnpm test:live`
 * when you want to confirm the upstream contracts still hold.
 */
export default defineConfig({
	test: {
		include: ['tests/live/**/*.test.ts'],
		testTimeout: 30_000,
		// Third-party APIs rate-limit aggressively; keep it to one file at a time.
		fileParallelism: false,
		retry: 1,
		restoreMocks: true,
	},
})
