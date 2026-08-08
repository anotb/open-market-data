import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/config.js', () => ({
	loadConfig: () => ({}),
}))

import { coingecko } from '../src/providers/coingecko.js'
import type { CryptoQuote } from '../src/types.js'

beforeEach(() => {
	vi.restoreAllMocks()
})

describe('CoinGecko public provider', () => {
	it('is available without an API key', () => {
		expect(coingecko.requiresKey).toBe(false)
		expect(coingecko.isEnabled()).toBe(true)
	})

	it('omits authentication headers for keyless public requests', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					bitcoin: {
						usd: 100_000,
						usd_24h_change: 2,
						usd_24h_vol: 10,
						usd_market_cap: 20,
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)

		const result = await coingecko.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })
		expect(result.data).toMatchObject({
			symbol: 'BTC',
			price: 100_000,
			change24h: 2_000,
			changePercent24h: 2,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined()
	})

	it('adds an actionable hint when the public quota is rate limited', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('slow down', { status: 429 }))
		await expect(coingecko.execute<CryptoQuote[]>('crypto', 'top', { limit: 3 })).rejects.toThrow(
			/free CoinGecko Demo key/i,
		)
	})
})
