import { beforeAll, describe, expect, it } from 'vitest'
import { getProviders, getProvidersForCategory, route } from '../src/core/router.js'
import { registerAllProviders } from '../src/providers/registry.js'

beforeAll(() => {
	registerAllProviders()
})

describe('router registration and selection', () => {
	it('registers every built-in provider exactly once', () => {
		registerAllProviders()
		const names = getProviders().map((provider) => provider.name)

		expect(names).toHaveLength(8)
		expect(new Set(names).size).toBe(names.length)
		expect(names).toEqual(
			expect.arrayContaining([
				'sec-edgar',
				'yahoo',
				'binance',
				'coingecko',
				'fred',
				'finnhub',
				'alphavantage',
				'worldbank',
			]),
		)
	})

	it('uses deterministic provider priority without making a request', () => {
		expect(getProvidersForCategory('quote')[0]?.name).toBe('yahoo')
		expect(getProvidersForCategory('financials')[0]?.name).toBe('sec-edgar')
		expect(getProvidersForCategory('filing').map((provider) => provider.name)).toEqual([
			'sec-edgar',
		])
		expect(getProvidersForCategory('macro').map((provider) => provider.name)).toContain('worldbank')
	})

	it('rejects a nonexistent forced source before contacting a provider', async () => {
		await expect(
			route('quote', 'get', { symbol: 'AAPL' }, { source: 'nonexistent' }),
		).rejects.toThrow('not available')
	})
})
