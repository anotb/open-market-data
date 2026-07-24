import { beforeAll, describe, expect, it } from 'vitest'
import { route } from '../../src/core/router.js'
import { registerAllProviders } from '../../src/providers/registry.js'
import type { QuoteResult, SearchResult } from '../../src/types.js'

/**
 * End-to-end smoke tests against real upstream APIs. Deterministic routing
 * behaviour is covered by tests/unit/router.test.ts — this file only confirms
 * the happy path still works against live data.
 */
beforeAll(() => {
	registerAllProviders()
})

describe('router (real API)', () => {
	it('routes quote to Yahoo Finance', async () => {
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

	it('respects the --source flag', async () => {
		const result = await route<QuoteResult>('quote', 'get', { symbol: 'AMZN' }, { source: 'yahoo' })
		expect(result.source).toBe('yahoo')
	})
})
