import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type { CryptoCandle, CryptoQuote } from '../../src/types.js'
import {
	type FetchMock,
	expectNoUnmatched,
	mockFetch,
	mockFetchNetworkError,
} from '../helpers/mock-fetch.js'
import { freshImport, freshImportAll } from '../helpers/modules.js'

/**
 * src/providers/binance.ts latches a module-scope `geoRestricted` flag the first
 * time the API answers 451, and never clears it. Every test therefore pulls the
 * provider through `freshImport`/`freshImportAll` so the latch (and the
 * `core/rate-limiter.ts` token bucket, which resets with the module registry)
 * starts pristine.
 *
 * Nothing here touches the network. Tests that depend on the token bucket pin
 * the clock so the bucket cannot refill mid-test.
 */

type BinanceModule = typeof import('../../src/providers/binance.js')
type RateLimiterModule = typeof import('../../src/core/rate-limiter.js')

const QUOTE_MATCH = '/api/v3/ticker/24hr'
const PRICE_MATCH = '/api/v3/ticker/price'
const KLINES_MATCH = '/api/v3/klines'

/** Shaped like GET https://api.binance.com/api/v3/ticker/24hr (trimmed). */
const TICKER_24HR = {
	symbol: 'BTCUSDT',
	priceChange: '-1234.56000000',
	priceChangePercent: '-1.834',
	weightedAvgPrice: '66500.12345678',
	prevClosePrice: '67300.01000000',
	lastPrice: '66065.45000000',
	lastQty: '0.00521000',
	bidPrice: '66065.44000000',
	bidQty: '3.51204000',
	askPrice: '66065.45000000',
	askQty: '1.20938000',
	openPrice: '67300.01000000',
	highPrice: '67890.00000000',
	lowPrice: '65100.10000000',
	volume: '21345.67891000',
	quoteVolume: '1412345678.90123400',
	openTime: 1718366400000,
	closeTime: 1718452800000,
	firstId: 3612345678,
	lastId: 3613456789,
	count: 1111112,
}

/** Shaped like GET https://api.binance.com/api/v3/ticker/price. */
const TICKER_PRICE = { symbol: 'ETHUSDT', price: '3512.87000000' }

/** Shaped like GET https://api.binance.com/api/v3/klines (12-element rows). */
const KLINES: unknown[][] = [
	[
		1718323200000,
		'66000.00000000',
		'67500.00000000',
		'65500.00000000',
		'67300.01000000',
		'21345.67891000',
		1718409599999,
		'1418765432.10000000',
		1111112,
		'10500.12345000',
		'694000000.00000000',
		'0',
	],
	[
		1718409600000,
		'67300.01000000',
		'68200.50000000',
		'66950.00000000',
		'66065.45000000',
		'18234.55500000',
		1718495999999,
		'1225500000.00000000',
		987654,
		'9000.00000000',
		'600000000.00000000',
		'0',
	],
	[
		1718496000000,
		'66065.45000000',
		'66900.00000000',
		'64800.25000000',
		'65010.75000000',
		'25000.00000000',
		1718582399999,
		'1640000000.00000000',
		1234567,
		'12000.00000000',
		'780000000.00000000',
		'0',
	],
]

/** Binance's error envelope for a bad symbol. */
const INVALID_SYMBOL_BODY = '{"code":-1121,"msg":"Invalid symbol."}'

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

/** A provider from a brand new module generation (latch cleared). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<BinanceModule>('../../src/providers/binance.js')
	return mod.binance
}

/** Provider + the rate limiter it actually shares a generation with. */
async function importWithLimiter(): Promise<{ provider: Provider; limiter: RateLimiterModule }> {
	const mods = await freshImportAll({
		binance: '../../src/providers/binance.js',
		limiter: '../../src/core/rate-limiter.js',
	})
	return {
		provider: (mods.binance as unknown as BinanceModule).binance,
		limiter: mods.limiter as unknown as RateLimiterModule,
	}
}

/** A mock that answers everything, so "no request was issued" is a real claim. */
function mockAnything(): FetchMock {
	return mockFetch([{ match: () => true, respond: { json: TICKER_24HR } }])
}

async function quoteOf(provider: Provider, symbol: string): Promise<CryptoQuote> {
	const result = await provider.execute<CryptoQuote>('crypto', 'quote', { symbol })
	return result.data
}

async function historyOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<CryptoCandle[]> {
	const result = await provider.execute<CryptoCandle[]>('crypto', 'history', args)
	return result.data
}

describe('provider metadata', () => {
	it('advertises a keyless crypto-only provider with Binance rate limits', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('binance')
		expect(provider.requiresKey).toBe(false)
		expect(provider.keyEnvVar).toBeUndefined()
		expect(provider.capabilities).toEqual(['crypto'])
		expect(provider.priority).toEqual({ crypto: 1 })
		expect(provider.rateLimits).toEqual({ maxRequests: 1200, windowMs: 60_000 })
	})

	it('is enabled before anything has been requested', async () => {
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})
})

describe('quote', () => {
	it('requests SYMBOL+USDT on api.binance.com and maps the ticker to a CryptoQuote', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		const result = await provider.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })

		expect(fx.call()?.url).toBe('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT')
		expect(result).toEqual({
			data: {
				symbol: 'BTC',
				price: 66065.45,
				change24h: -1234.56,
				changePercent24h: -1.834,
				volume24h: 1412345678.901234,
				high24h: 67890,
				low24h: 65100.1,
				source: 'binance',
			},
			source: 'binance',
			cached: false,
		})
		expectNoUnmatched(fx)
	})

	it('upper-cases a lower-case symbol in both the pair and the result', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'btc')

		expect(fx.query()).toEqual({ symbol: 'BTCUSDT' })
		expect(quote.symbol).toBe('BTC')
	})

	it('upper-cases a mixed-case symbol', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'sOl')

		expect(fx.query()).toEqual({ symbol: 'SOLUSDT' })
		expect(quote.symbol).toBe('SOL')
	})

	it('coerces every string field of the payload into a number', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(typeof quote.price).toBe('number')
		expect(typeof quote.change24h).toBe('number')
		expect(typeof quote.changePercent24h).toBe('number')
		expect(typeof quote.volume24h).toBe('number')
		expect(typeof quote.high24h).toBe('number')
		expect(typeof quote.low24h).toBe('number')
		expect(typeof quote.symbol).toBe('string')
	})

	it('preserves the sign of a negative 24h change and percent', async () => {
		mockFetch([
			{
				match: QUOTE_MATCH,
				respond: { json: { ...TICKER_24HR, priceChange: '-0.00120000', priceChangePercent: '-12.5' } },
			},
		])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(quote.change24h).toBe(-0.0012)
		expect(quote.changePercent24h).toBe(-12.5)
	})

	it('keeps a positive change positive', async () => {
		mockFetch([
			{
				match: QUOTE_MATCH,
				respond: { json: { ...TICKER_24HR, priceChange: '812.34000000', priceChangePercent: '1.24' } },
			},
		])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(quote.change24h).toBe(812.34)
		expect(quote.changePercent24h).toBe(1.24)
	})

	it('keeps sub-cent precision on a fractional price', async () => {
		mockFetch([
			{
				match: QUOTE_MATCH,
				respond: {
					json: {
						...TICKER_24HR,
						symbol: 'SHIBUSDT',
						lastPrice: '0.00002534',
						lowPrice: '0.00002401',
						highPrice: '0.00002699',
					},
				},
			},
		])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'shib')

		expect(quote.price).toBe(0.00002534)
		expect(quote.low24h).toBe(0.00002401)
		expect(quote.high24h).toBe(0.00002699)
	})

	it('echoes the requested symbol rather than the pair reported upstream', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { json: { ...TICKER_24HR, symbol: 'SOMETHINGELSE' } } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'btc')

		expect(quote.symbol).toBe('BTC')
	})

	it('issues a bare GET with no auth headers or body', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		await quoteOf(provider, 'BTC')

		const call = fx.call()
		expect(call?.method).toBe('GET')
		expect(call?.headers).toEqual({})
		expect(call?.body).toBeUndefined()
	})

	// NOTE: suspected bug — the payload is coerced with `Number()` and never
	// validated, so a field the API omits silently becomes NaN.
	it('yields NaN for numeric fields the payload omits', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { json: { symbol: 'BTCUSDT' } } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(quote.price).toBeNaN()
		expect(quote.change24h).toBeNaN()
		expect(quote.volume24h).toBeNaN()
		expect(quote.symbol).toBe('BTC')
	})

	// NOTE: suspected bug — `Number('')` is 0, so an empty upstream string is
	// reported as a real price of zero rather than as missing data.
	it('turns an empty-string price into 0', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { json: { ...TICKER_24HR, lastPrice: '' } } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(quote.price).toBe(0)
	})

	it('yields NaN when a numeric field is not parseable', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { json: { ...TICKER_24HR, quoteVolume: 'n/a' } } }])
		const provider = await importProvider()

		const quote = await quoteOf(provider, 'BTC')

		expect(quote.volume24h).toBeNaN()
		expect(quote.price).toBe(66065.45)
	})
})

describe('history', () => {
	it('defaults to 30 daily candles when execute gets no days or interval', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: KLINES } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'btc' })

		expect(fx.call()?.url).toBe(
			'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30',
		)
		expect(fx.query()).toEqual({ symbol: 'BTCUSDT', interval: '1d', limit: '30' })
		expectNoUnmatched(fx)
	})

	it('maps [openTime, o, h, l, c, v] to CryptoCandles with ISO times and numeric OHLCV', async () => {
		mockFetch([{ match: KLINES_MATCH, respond: { json: KLINES } }])
		const provider = await importProvider()

		const candles = await historyOf(provider, { symbol: 'BTC' })

		expect(candles).toEqual([
			{
				time: '2024-06-14T00:00:00.000Z',
				open: 66000,
				high: 67500,
				low: 65500,
				close: 67300.01,
				volume: 21345.67891,
			},
			{
				time: '2024-06-15T00:00:00.000Z',
				open: 67300.01,
				high: 68200.5,
				low: 66950,
				close: 66065.45,
				volume: 18234.555,
			},
			{
				time: '2024-06-16T00:00:00.000Z',
				open: 66065.45,
				high: 66900,
				low: 64800.25,
				close: 65010.75,
				volume: 25000,
			},
		])
	})

	it('returns numbers, not the API strings, for OHLCV', async () => {
		mockFetch([{ match: KLINES_MATCH, respond: { json: KLINES } }])
		const provider = await importProvider()

		const [candle] = await historyOf(provider, { symbol: 'BTC' })

		expect(typeof candle.time).toBe('string')
		expect(typeof candle.open).toBe('number')
		expect(typeof candle.high).toBe('number')
		expect(typeof candle.low).toBe('number')
		expect(typeof candle.close).toBe('number')
		expect(typeof candle.volume).toBe('number')
	})

	it('wraps the candle list in a non-cached binance ProviderResult', async () => {
		mockFetch([{ match: KLINES_MATCH, respond: { json: KLINES } }])
		const provider = await importProvider()

		const result = await provider.execute<CryptoCandle[]>('crypto', 'history', { symbol: 'BTC' })

		expect(result.source).toBe('binance')
		expect(result.cached).toBe(false)
		expect(result.data).toHaveLength(3)
	})

	it('ignores every kline field after volume', async () => {
		mockFetch([
			{
				match: KLINES_MATCH,
				respond: {
					json: [[1718323200000, '1.5', '2.5', '0.5', '2.0', '10.25', 'ignored', { a: 1 }, null]],
				},
			},
		])
		const provider = await importProvider()

		const candles = await historyOf(provider, { symbol: 'BTC' })

		expect(candles).toEqual([
			{ time: '2024-06-14T00:00:00.000Z', open: 1.5, high: 2.5, low: 0.5, close: 2, volume: 10.25 },
		])
	})

	it('accepts a bare six-element kline', async () => {
		mockFetch([
			{ match: KLINES_MATCH, respond: { json: [[0, '1', '2', '0.5', '1.5', '100']] } },
		])
		const provider = await importProvider()

		const candles = await historyOf(provider, { symbol: 'BTC' })

		expect(candles).toEqual([
			{ time: '1970-01-01T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
		])
	})

	it('passes a custom interval and day count through as query params', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'eth', days: 7, interval: '4h' })

		expect(fx.call()?.url).toBe(
			'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=7',
		)
	})

	it('keeps the 1d default when only days is supplied', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', days: 90 })

		expect(fx.query()).toEqual({ symbol: 'BTCUSDT', interval: '1d', limit: '90' })
	})

	it('keeps the 30 default when only interval is supplied', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', interval: '1m' })

		expect(fx.query()).toEqual({ symbol: 'BTCUSDT', interval: '1m', limit: '30' })
	})

	it('treats explicit undefined args as absent and falls back to the defaults', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', days: undefined, interval: undefined })

		expect(fx.query()).toEqual({ symbol: 'BTCUSDT', interval: '1d', limit: '30' })
	})

	it('returns an empty array for an empty klines payload', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		const candles = await historyOf(provider, { symbol: 'BTC' })

		expect(candles).toEqual([])
		expect(fx.callCount()).toBe(1)
	})

	// NOTE: suspected bug — `??` only falls back on null/undefined, so `days: 0`
	// reaches Binance as `limit=0`, which the exchange rejects.
	it('sends limit=0 when days is 0 instead of falling back to 30', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', days: 0 })

		expect(fx.query().limit).toBe('0')
	})

	// NOTE: suspected bug — `omd crypto history btc --days abc` parses to NaN,
	// which `?? 30` does not catch, so `limit=NaN` is sent upstream.
	it('sends limit=NaN when days is NaN instead of falling back to 30', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', days: Number.NaN })

		expect(fx.query().limit).toBe('NaN')
	})

	// NOTE: suspected bug — an unparseable openTime makes `toISOString()` throw a
	// bare RangeError with no provider context.
	it('throws RangeError when openTime cannot be parsed as a date', async () => {
		mockFetch([
			{ match: KLINES_MATCH, respond: { json: [['not-a-time', '1', '2', '0.5', '1.5', '10']] } },
		])
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(RangeError)
		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow('Invalid time value')
	})

	// NOTE: suspected bug — the klines payload shape is never validated, so a
	// 200 response that is not an array surfaces as a raw TypeError.
	it('throws TypeError when a 200 response is not an array of klines', async () => {
		mockFetch([{ match: KLINES_MATCH, respond: { json: { code: -1121, msg: 'Invalid symbol.' } } }])
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(TypeError)
	})
})

describe('price', () => {
	it('returns only the symbol and price from the ticker/price endpoint', async () => {
		const fx = mockFetch([{ match: PRICE_MATCH, respond: { json: TICKER_PRICE } }])
		const provider = await importProvider()

		const result = await provider.execute<{ symbol: string; price: number }>(
			'crypto',
			'price',
			{ symbol: 'eth' },
		)

		expect(fx.call()?.url).toBe('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
		expect(result).toEqual({
			data: { symbol: 'ETH', price: 3512.87 },
			source: 'binance',
			cached: false,
		})
		expect(Object.keys(result.data)).toEqual(['symbol', 'price'])
		expectNoUnmatched(fx)
	})

	it('coerces the string price to a number', async () => {
		mockFetch([{ match: PRICE_MATCH, respond: { json: { symbol: 'DOGEUSDT', price: '0.14235000' } } }])
		const provider = await importProvider()

		const result = await provider.execute<{ symbol: string; price: number }>('crypto', 'price', {
			symbol: 'DOGE',
		})

		expect(typeof result.data.price).toBe('number')
		expect(result.data.price).toBe(0.14235)
	})

	it('yields NaN when the price field is missing', async () => {
		mockFetch([{ match: PRICE_MATCH, respond: { json: { symbol: 'BTCUSDT' } } }])
		const provider = await importProvider()

		const result = await provider.execute<{ symbol: string; price: number }>('crypto', 'price', {
			symbol: 'btc',
		})

		expect(result.data.price).toBeNaN()
		expect(result.data.symbol).toBe('BTC')
	})
})

describe('geo restriction', () => {
	it('throws the geo-restricted message on HTTP 451', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 451 } }])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
	})

	it('prefers the geo message over the generic API-error message for 451 bodies', async () => {
		mockFetch([
			{
				match: QUOTE_MATCH,
				respond: { status: 451, text: 'Service unavailable from a restricted location.' },
			},
		])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
		await expect(quoteOf(provider, 'BTC')).rejects.not.toThrow(/geo-restricted/)
	})

	it('flips isEnabled() to false once a 451 is seen', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 451 } }])
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(provider.isEnabled()).toBe(false)
	})

	it('short-circuits later quotes without issuing another fetch', async () => {
		const fx = mockFetch([
			{ match: () => true, respond: { status: 451 }, times: 1 },
			{ match: () => true, respond: { json: TICKER_24HR } },
		])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(fx.callCount()).toBe(1)

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
		expect(fx.callCount()).toBe(1)
	})

	it('short-circuits every other action too, once latched by a quote', async () => {
		const fx = mockFetch([
			{ match: () => true, respond: { status: 451 }, times: 1 },
			{ match: () => true, respond: { json: TICKER_24HR } },
		])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
		await expect(provider.execute('crypto', 'price', { symbol: 'BTC' })).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
		expect(fx.callCount()).toBe(1)
	})

	it('latches from a history request as well as a quote', async () => {
		const fx = mockFetch([
			{ match: () => true, respond: { status: 451 }, times: 1 },
			{ match: () => true, respond: { json: TICKER_24HR } },
		])
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(/geo-restricted/)
		expect(provider.isEnabled()).toBe(false)

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(fx.callCount()).toBe(1)
	})

	it('stops consuming rate-limit tokens once latched', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		mockFetch([{ match: () => true, respond: { status: 451 } }])
		const { provider, limiter } = await importWithLimiter()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1199)

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1199)
	})

	it('clears the latch for a freshly imported module', async () => {
		mockFetch([{ match: () => true, respond: { status: 451 } }])
		const latched = await importProvider()
		await expect(quoteOf(latched, 'BTC')).rejects.toThrow(/geo-restricted/)
		expect(latched.isEnabled()).toBe(false)

		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const reimported = await importProvider()

		expect(reimported.isEnabled()).toBe(true)
		await expect(quoteOf(reimported, 'BTC')).resolves.toMatchObject({ symbol: 'BTC' })
		expect(fx.callCount()).toBe(1)
	})

	it('leaves the old module generation latched after a re-import', async () => {
		mockFetch([{ match: () => true, respond: { status: 451 } }])
		const latched = await importProvider()
		await expect(quoteOf(latched, 'BTC')).rejects.toThrow(/geo-restricted/)

		await importProvider()

		expect(latched.isEnabled()).toBe(false)
	})
})

describe('HTTP errors', () => {
	it('reports a non-451 failure as "Binance API error <status>: <body>"', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 400, text: INVALID_SYMBOL_BODY } }])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'NOTACOIN')).rejects.toThrow(
			`Binance API error 400: ${INVALID_SYMBOL_BODY}`,
		)
	})

	it('includes an empty body as an empty suffix', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 500 } }])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('Binance API error 500: ')
	})

	it('reports an upstream 429 as an API error, not as the local rate limit', async () => {
		mockFetch([
			{ match: QUOTE_MATCH, respond: { status: 429, text: '{"code":-1003,"msg":"Too many requests."}' } },
		])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(
			'Binance API error 429: {"code":-1003,"msg":"Too many requests."}',
		)
		await expect(quoteOf(provider, 'BTC')).rejects.not.toThrow('Binance API error 429')
	})

	it('reports a 418 (IP ban) as an API error and stays enabled', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 418, text: 'banned' } }])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('Binance API error 418: banned')
		expect(provider.isEnabled()).toBe(true)
	})

	it('does not latch on a non-451 error, so the next call still fetches', async () => {
		const fx = mockFetch([
			{ match: QUOTE_MATCH, respond: { status: 503, text: 'maintenance' }, times: 1 },
			{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } },
		])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('Binance API error 503: maintenance')
		expect(provider.isEnabled()).toBe(true)

		await expect(quoteOf(provider, 'BTC')).resolves.toMatchObject({ price: 66065.45 })
		expect(fx.callCount()).toBe(2)
	})

	it('surfaces the error for every action, not just quote', async () => {
		mockFetch([{ match: () => true, respond: { status: 404, text: 'not found' } }])
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(
			'Binance API error 404: not found',
		)
		await expect(provider.execute('crypto', 'price', { symbol: 'BTC' })).rejects.toThrow(
			'Binance API error 404: not found',
		)
	})

	it('propagates a network-level rejection unchanged', async () => {
		mockFetchNetworkError('ECONNREFUSED')
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('ECONNREFUSED')
		expect(provider.isEnabled()).toBe(true)
	})

	// NOTE: suspected bug — a 200 with a non-JSON body surfaces the raw parser
	// SyntaxError, with no mention of Binance.
	it('surfaces a raw SyntaxError when a 200 body is not JSON', async () => {
		mockFetch([{ match: QUOTE_MATCH, respond: { status: 200, text: '<html>maintenance</html>' } }])
		const provider = await importProvider()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(SyntaxError)
	})
})

describe('rate limiting', () => {
	it('consumes exactly one token per successful request', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const { provider, limiter } = await importWithLimiter()

		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1200)
		await quoteOf(provider, 'BTC')
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1199)
		await quoteOf(provider, 'BTC')
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1198)
	})

	it('allows the last token through and rejects the next request without fetching', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const fx = mockFetch([{ match: () => true, respond: { json: TICKER_24HR } }])
		const { provider, limiter } = await importWithLimiter()

		let taken = 0
		for (let i = 0; i < 1199; i += 1) {
			if (limiter.consumeToken('binance', provider.rateLimits)) taken += 1
		}
		expect(taken).toBe(1199)
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1)

		await expect(quoteOf(provider, 'BTC')).resolves.toMatchObject({ symbol: 'BTC' })
		expect(fx.callCount()).toBe(1)

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('Binance rate limit exceeded')
		expect(fx.callCount()).toBe(1)
	})

	it('rejects every action once the bucket is empty', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const fx = mockFetch([{ match: () => true, respond: { json: [] } }])
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 1200; i += 1) limiter.consumeToken('binance', provider.rateLimits)
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(0)

		await expect(historyOf(provider, { symbol: 'BTC' })).rejects.toThrow(
			'Binance rate limit exceeded',
		)
		await expect(provider.execute('crypto', 'price', { symbol: 'BTC' })).rejects.toThrow(
			'Binance rate limit exceeded',
		)
		expect(fx.callCount()).toBe(0)
		expect(provider.isEnabled()).toBe(true)
	})

	it('lets requests through again once the window has refilled a token', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const fx = mockFetch([{ match: () => true, respond: { json: TICKER_24HR } }])
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 1200; i += 1) limiter.consumeToken('binance', provider.rateLimits)
		await expect(quoteOf(provider, 'BTC')).rejects.toThrow('Binance rate limit exceeded')

		// 1200 tokens per 60s means one token is restored every 50ms.
		vi.setSystemTime(new Date('2024-06-15T12:00:00.050Z'))

		await expect(quoteOf(provider, 'BTC')).resolves.toMatchObject({ symbol: 'BTC' })
		expect(fx.callCount()).toBe(1)
	})

	it('checks the geo latch before the rate limit', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		mockFetch([{ match: () => true, respond: { status: 451 } }])
		const { provider, limiter } = await importWithLimiter()

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(/geo-restricted/)
		for (let i = 0; i < 1200; i += 1) limiter.consumeToken('binance', provider.rateLimits)

		await expect(quoteOf(provider, 'BTC')).rejects.toThrow(
			'Binance is geo-restricted in your region (HTTP 451)',
		)
	})
})

describe('action dispatch', () => {
	it('rejects an unsupported action by name without fetching', async () => {
		const fx = mockAnything()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'chart', { symbol: 'BTC' })).rejects.toThrow(
			'Binance does not support action: chart',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty action name', async () => {
		mockAnything()
		const provider = await importProvider()

		await expect(provider.execute('crypto', '', { symbol: 'BTC' })).rejects.toThrow(
			'Binance does not support action: ',
		)
	})

	it('matches action names case-sensitively', async () => {
		const fx = mockAnything()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'Quote', { symbol: 'BTC' })).rejects.toThrow(
			'Binance does not support action: Quote',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('does not consume a rate-limit token for an unsupported action', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		mockAnything()
		const { provider, limiter } = await importWithLimiter()

		await expect(provider.execute('crypto', 'orderbook', { symbol: 'BTC' })).rejects.toThrow(
			/does not support action/,
		)
		expect(limiter.getRemaining('binance', provider.rateLimits)).toBe(1200)
	})

	it('ignores the category argument and dispatches purely on the action', async () => {
		const fx = mockFetch([{ match: PRICE_MATCH, respond: { json: TICKER_PRICE } }])
		const provider = await importProvider()

		const result = await provider.execute<{ symbol: string; price: number }>('macro', 'price', {
			symbol: 'eth',
		})

		expect(result.data).toEqual({ symbol: 'ETH', price: 3512.87 })
		expect(fx.callCount()).toBe(1)
	})

	it('ignores extra args it does not understand', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		await provider.execute('crypto', 'quote', { symbol: 'BTC', vs: 'eur', limit: 5 })

		expect(fx.query()).toEqual({ symbol: 'BTCUSDT' })
	})

	// NOTE: suspected bug — a missing symbol dereferences undefined instead of
	// producing a readable "symbol is required" error.
	it('throws a bare TypeError when symbol is missing', async () => {
		const fx = mockAnything()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'quote', {})).rejects.toThrow(TypeError)
		expect(fx.callCount()).toBe(0)
	})

	it('throws a bare TypeError when symbol is missing for history and price', async () => {
		mockAnything()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'history', {})).rejects.toThrow(TypeError)
		await expect(provider.execute('crypto', 'price', {})).rejects.toThrow(TypeError)
	})
})

describe('URL construction', () => {
	it('appends USDT even to a symbol that is already a quote asset', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		await quoteOf(provider, 'usdt')

		expect(fx.query()).toEqual({ symbol: 'USDTUSDT' })
	})

	it('sends an empty symbol as the bare pair USDT', async () => {
		const fx = mockFetch([{ match: QUOTE_MATCH, respond: { json: TICKER_24HR } }])
		const provider = await importProvider()

		await quoteOf(provider, '')

		expect(fx.query()).toEqual({ symbol: 'USDT' })
	})

	// NOTE: suspected bug — the symbol is interpolated into the query string
	// without encodeURIComponent, so an `&` in the symbol injects extra params.
	it('interpolates the symbol without escaping, allowing query injection', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'btc&limit=1000' })

		expect(fx.query()).toEqual({
			symbol: 'BTC',
			LIMIT: '1000USDT',
			interval: '1d',
			limit: '30',
		})
	})

	// NOTE: same missing escaping on the caller-supplied interval.
	it('interpolates the interval without escaping', async () => {
		const fx = mockFetch([{ match: KLINES_MATCH, respond: { json: [] } }])
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'BTC', interval: '1d&limit=999' })

		expect(fx.call()?.url).toBe(
			'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=999&limit=30',
		)
	})
})
