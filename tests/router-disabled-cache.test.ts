import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderResult } from '../src/providers/types.js'

const { state } = vi.hoisted(() => ({
	state: { disabledSources: [] as string[] },
}))

vi.mock('../src/core/config.js', () => ({
	loadConfig: () => ({ disabledSources: state.disabledSources }),
}))

describe('router cache eligibility', () => {
	beforeEach(() => {
		state.disabledSources = []
		vi.resetModules()
	})

	it('does not return cached data from a provider disabled after the first request', async () => {
		const execute = vi.fn(
			async <T>() =>
				({ data: { price: 100 } as T, source: 'test-source', cached: false }) as ProviderResult<T>,
		)
		const provider: Provider = {
			name: 'test-source',
			requiresKey: false,
			capabilities: ['quote'],
			priority: { quote: 1 },
			rateLimits: { maxRequests: 100, windowMs: 60_000 },
			isEnabled: () => true,
			execute,
		}
		const router = await import('../src/core/router.js')
		router.registerProvider(provider)

		await expect(router.route('quote', 'get', { symbol: 'AAPL' })).resolves.toMatchObject({
			cached: false,
		})
		state.disabledSources = ['test-source']

		await expect(router.route('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			/No providers available/,
		)
		expect(execute).toHaveBeenCalledTimes(1)
	})
})
