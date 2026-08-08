import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createOpenMarketDataClient } from '../src/client.js'
import * as cache from '../src/core/cache.js'
import { loadConfig } from '../src/core/config.js'
import { route } from '../src/core/router.js'
import { binance } from '../src/providers/binance.js'
import { registerAllProviders } from '../src/providers/registry.js'
import { yahoo } from '../src/providers/yahoo-finance.js'
import type { QuoteResult, SearchResult } from '../src/types.js'

const itWithAlphaVantage = loadConfig().alphaVantageApiKey ? it : it.skip

beforeAll(() => {
	registerAllProviders()
})

describe('router live smoke tests', () => {
	it('routes a real quote through the preferred available provider', async () => {
		const result = await route<QuoteResult>('quote', 'get', { symbol: 'GOOGL' })
		expect(result.data.symbol).toBe('GOOGL')
		expect(result.data.price).toBeGreaterThan(0)
		expect(result.source).toBeTruthy()
	})

	it('finds a real company symbol', async () => {
		const result = await route<SearchResult[]>('search', 'search', { query: 'Tesla' })
		expect(result.data.some((item) => item.symbol === 'TSLA')).toBe(true)
	})

	it('honors a forced live source', async () => {
		const result = await route<QuoteResult>('quote', 'get', { symbol: 'AMZN' }, { source: 'yahoo' })
		expect(result.source).toBe('yahoo')
		expect(result.data.price).toBeGreaterThan(0)
	})

	it('normalizes forced source names through the public SDK', async () => {
		const result = await createOpenMarketDataClient().quotes(['AAPL'], {
			source: ' YAHOO ',
			noCache: true,
		})
		expect(result.meta).toMatchObject({ source: 'yahoo', cached: false })
		expect(result.data[0].price).toBeGreaterThan(0)
	})

	it('preserves cache provenance and honors a live no-cache bypass', async () => {
		cache.clear()
		const args = { symbol: 'META' }
		const fresh = await route<QuoteResult>('quote', 'get', args, { source: 'yahoo' })
		const cached = await route<QuoteResult>('quote', 'get', args, { source: 'yahoo' })
		const bypassed = await route<QuoteResult>('quote', 'get', args, {
			source: 'yahoo',
			noCache: true,
		})
		expect(fresh).toMatchObject({ source: 'yahoo', cached: false })
		expect(cached).toMatchObject({ source: 'yahoo', cached: true })
		expect(bypassed).toMatchObject({ source: 'yahoo', cached: false })
	})

	it('falls back from a restricted Binance request to a real CoinGecko response', async () => {
		const failure = vi
			.spyOn(binance, 'execute')
			.mockRejectedValueOnce(new Error('Binance is geo-restricted in your region (HTTP 451)'))
		try {
			const result = await route<QuoteResult>(
				'crypto',
				'quote',
				{ symbol: 'BTC' },
				{ noCache: true },
			)
			expect(result).toMatchObject({ source: 'coingecko', cached: false })
			expect(result.data.price).toBeGreaterThan(0)
		} finally {
			failure.mockRestore()
		}
	})

	it('reports a forced provider failure without silently changing sources', async () => {
		const failure = vi
			.spyOn(yahoo, 'execute')
			.mockRejectedValueOnce(new Error('[yahoo] deterministic live failure'))
		try {
			await expect(
				route<QuoteResult>('quote', 'get', { symbol: 'AAPL' }, { source: 'yahoo', noCache: true }),
			).rejects.toThrow(/All providers failed.*tried: yahoo.*deterministic live failure/i)
		} finally {
			failure.mockRestore()
		}
	})

	itWithAlphaVantage(
		'falls back from Yahoo to a live Alpha Vantage IBM quote when credentials permit',
		async () => {
			const failure = vi
				.spyOn(yahoo, 'execute')
				.mockRejectedValueOnce(new Error('[yahoo] deterministic live failure'))
			try {
				const result = await route<QuoteResult>(
					'quote',
					'get',
					{ symbol: 'IBM' },
					{ noCache: true },
				)
				expect(result.source).toBe('alphavantage')
				expect(result.data.price).toBeGreaterThan(0)
			} finally {
				failure.mockRestore()
			}
		},
	)

	it('returns a live composite company snapshot with partial-result metadata intact', async () => {
		const result = await createOpenMarketDataClient().snapshot({
			symbol: 'AAPL',
			historyDays: 10,
			financialPeriods: 2,
			filingLimit: 2,
			noCache: true,
		})
		expect(result.data.symbol).toBe('AAPL')
		expect(result.data.quote?.price).toBeGreaterThan(0)
		expect(result.data.recentHistory?.length ?? 0).toBeGreaterThan(0)
		expect(result.data.filings?.length ?? 0).toBeLessThanOrEqual(2)
		expect(Array.isArray(result.meta.errors ?? [])).toBe(true)
	})
})
