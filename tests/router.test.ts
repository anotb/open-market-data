import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllProviders } from '../src/providers/registry.js'
import { route, getProviders, getProvidersForCategory } from '../src/core/router.js'
import type { QuoteResult, SearchResult } from '../src/types.js'

beforeAll(() => {
	registerAllProviders()
})

describe('router', () => {
	it('has registered providers', () => {
		const providers = getProviders()
		expect(providers.length).toBe(5)
		const names = providers.map((p) => p.name)
		expect(names).toContain('sec-edgar')
		expect(names).toContain('yahoo')
		expect(names).toContain('binance')
		expect(names).toContain('coingecko')
		expect(names).toContain('fred')
	})

	it('finds providers for quote category', () => {
		const providers = getProvidersForCategory('quote')
		expect(providers.length).toBeGreaterThan(0)
		expect(providers[0].name).toBe('yahoo')
	})

	it('finds providers for filing category', () => {
		const providers = getProvidersForCategory('filing')
		expect(providers.length).toBe(1)
		expect(providers[0].name).toBe('sec-edgar')
	})

	it('routes quote to Yahoo Finance (real data)', async () => {
		const result = await route<QuoteResult>('quote', 'get', { symbol: 'GOOGL' })
		expect(result.source).toBe('yahoo')
		expect(result.data.symbol).toBe('GOOGL')
		expect(result.data.price).toBeGreaterThan(0)
	})

	it('routes search across multiple providers', async () => {
		const result = await route<SearchResult[]>('search', 'search', { query: 'Tesla' })
		expect(result.data.length).toBeGreaterThan(0)
		const tsla = result.data.find((r) => r.symbol === 'TSLA')
		expect(tsla).toBeDefined()
	})

	it('errors on unsupported category with no providers', async () => {
		// Macro requires FRED key — should fail if not configured
		const providers = getProvidersForCategory('macro')
		if (providers.length === 0) {
			await expect(route('macro', 'get', { seriesId: 'GDP' })).rejects.toThrow('No providers available')
		}
	})

	it('respects --source flag', async () => {
		const result = await route<QuoteResult>('quote', 'get', { symbol: 'AMZN' }, { source: 'yahoo' })
		expect(result.source).toBe('yahoo')
	})

	it('errors with invalid source', async () => {
		await expect(
			route('quote', 'get', { symbol: 'AAPL' }, { source: 'nonexistent' }),
		).rejects.toThrow('not available')
	})
})
