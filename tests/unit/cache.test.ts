import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as cache from '../../src/core/cache.js'
import type { DataCategory } from '../../src/providers/types.js'
import { ALL_CATEGORIES } from '../helpers/providers.js'

/**
 * src/core/cache.ts owns a module-scoped Map, so every test clears it first.
 * Both TTL expiry and eviction read Date.now(), so the clock is pinned for the
 * whole file — nothing here may depend on wall time or the ambient timezone.
 */

const START = Date.parse('2024-06-15T12:00:00Z')
const HOUR = 3_600_000
const MAX_ENTRIES = 500

/** Independent restatement of the per-category TTL contract. */
const TTL_TABLE: [DataCategory, number][] = [
	['search', 300_000],
	['quote', 30_000],
	['financials', HOUR],
	['filing', HOUR],
	['insiders', HOUR],
	['macro', HOUR],
	['crypto', 15_000],
	['history', HOUR],
	['options', 60_000],
	['earnings', HOUR],
	['dividends', HOUR],
]

const AAPL_QUOTE = {
	symbol: 'AAPL',
	price: 214.29,
	change: -1.13,
	changePercent: -0.5241,
	currency: 'USD',
	marketState: 'REGULAR',
}

const AAPL_FILINGS = [
	{ form: '10-K', filedAt: '2023-11-03', accession: '0000320193-23-000106' },
	{ form: '10-Q', filedAt: '2023-08-04', accession: '0000320193-23-000077' },
]

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date(START))
	cache.clear()
})

afterEach(() => {
	cache.clear()
	vi.useRealTimers()
})

describe('get / set', () => {
	it('round-trips a payload for the same provider, category and args', () => {
		cache.set('yahoo-finance', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_QUOTE)

		expect(cache.get('yahoo-finance', 'quote', { action: 'get', symbol: 'AAPL' })).toEqual(
			AAPL_QUOTE,
		)
	})

	it('returns undefined for a key that was never written', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, AAPL_QUOTE)

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'MSFT' })).toBeUndefined()
	})

	it('treats an extra arg as a different key', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, AAPL_QUOTE)

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL', action: 'get' })).toBeUndefined()
		expect(cache.size()).toBe(1)
	})

	it('keeps independent entries for different args', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, { price: 214.29 })
		cache.set('yahoo-finance', 'quote', { symbol: 'MSFT' }, { price: 430.16 })

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toEqual({ price: 214.29 })
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'MSFT' })).toEqual({ price: 430.16 })
		expect(cache.size()).toBe(2)
	})

	it('round-trips array payloads with their order intact', () => {
		cache.set('sec-edgar', 'filing', { symbol: 'AAPL', limit: 2 }, AAPL_FILINGS)

		const cached = cache.get<typeof AAPL_FILINGS>('sec-edgar', 'filing', {
			symbol: 'AAPL',
			limit: 2,
		})
		expect(cached).toHaveLength(2)
		expect(cached?.[0]?.accession).toBe('0000320193-23-000106')
		expect(cached?.[1]?.form).toBe('10-Q')
	})

	it('stores falsy payloads and returns them verbatim', () => {
		// NOTE: suspected bug (src/core/router.ts:54,59) — the router does
		// `if (cached_data) return ...`, so a legitimately cached 0 / '' / false /
		// null is treated as a cache miss even though get() returns it fine.
		cache.set('fred', 'macro', { series: 'zero' }, 0)
		cache.set('fred', 'macro', { series: 'empty' }, '')
		cache.set('fred', 'macro', { series: 'false' }, false)
		cache.set('fred', 'macro', { series: 'null' }, null)

		expect(cache.get('fred', 'macro', { series: 'zero' })).toBe(0)
		expect(cache.get('fred', 'macro', { series: 'empty' })).toBe('')
		expect(cache.get('fred', 'macro', { series: 'false' })).toBe(false)
		expect(cache.get('fred', 'macro', { series: 'null' })).toBeNull()
		expect(cache.size()).toBe(4)
	})

	it('cannot distinguish a stored undefined from a miss, yet still spends a slot', () => {
		// NOTE: suspected bug — set(..., undefined) occupies an entry that reads
		// back exactly like a miss, so it is refetched every time until it expires.
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, undefined)

		expect(cache.size()).toBe(1)
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
	})

	it('hands back the stored reference rather than a defensive copy', () => {
		// NOTE: suspected bug — neither set() nor get() copies, so any caller that
		// mutates the payload silently rewrites what later readers get.
		const payload = { symbol: 'AAPL', price: 214.29 }
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, payload)

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBe(payload)

		payload.price = 0.01
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toEqual({
			symbol: 'AAPL',
			price: 0.01,
		})
	})

	it('overwrites the value for an identical key without growing the store', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, { price: 214.29 })
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, { price: 215.5 })

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toEqual({ price: 215.5 })
		expect(cache.size()).toBe(1)
	})

	it('accepts an empty args object and keys it apart from populated args', () => {
		cache.set('coingecko', 'crypto', {}, { total: 12_345 })
		cache.set('coingecko', 'crypto', { symbol: 'BTC' }, { price: 64_000 })

		expect(cache.get('coingecko', 'crypto', {})).toEqual({ total: 12_345 })
		expect(cache.get('coingecko', 'crypto', { symbol: 'BTC' })).toEqual({ price: 64_000 })
		expect(cache.size()).toBe(2)
	})
})

describe('cache key composition', () => {
	it('ignores the insertion order of top-level args', () => {
		cache.set(
			'sec-edgar',
			'filing',
			{ symbol: 'AAPL', form: '10-K', limit: 5, action: 'list' },
			AAPL_FILINGS,
		)

		expect(
			cache.get('sec-edgar', 'filing', { limit: 5, action: 'list', form: '10-K', symbol: 'AAPL' }),
		).toEqual(AAPL_FILINGS)
		expect(cache.size()).toBe(1)
	})

	it('distinguishes a numeric arg from its string form', () => {
		cache.set('yahoo-finance', 'history', { limit: 1 }, 'number-one')
		cache.set('yahoo-finance', 'history', { limit: '1' }, 'string-one')

		expect(cache.get('yahoo-finance', 'history', { limit: 1 })).toBe('number-one')
		expect(cache.get('yahoo-finance', 'history', { limit: '1' })).toBe('string-one')
		expect(cache.size()).toBe(2)
	})

	it('distinguishes boolean and null args from their string forms', () => {
		cache.set('finnhub', 'quote', { adjusted: true }, 'bool')
		cache.set('finnhub', 'quote', { adjusted: 'true' }, 'string')
		cache.set('finnhub', 'quote', { adjusted: null }, 'null')
		cache.set('finnhub', 'quote', { adjusted: 'null' }, 'string-null')

		expect(cache.get('finnhub', 'quote', { adjusted: true })).toBe('bool')
		expect(cache.get('finnhub', 'quote', { adjusted: 'true' })).toBe('string')
		expect(cache.get('finnhub', 'quote', { adjusted: null })).toBe('null')
		expect(cache.get('finnhub', 'quote', { adjusted: 'null' })).toBe('string-null')
		expect(cache.size()).toBe(4)
	})

	it('matches nested objects and arrays that are structurally identical', () => {
		cache.set(
			'alpha-vantage',
			'financials',
			{ symbol: 'AAPL', filters: { form: '10-K', years: [2022, 2023] } },
			'nested',
		)

		expect(
			cache.get('alpha-vantage', 'financials', {
				filters: { form: '10-K', years: [2022, 2023] },
				symbol: 'AAPL',
			}),
		).toBe('nested')
		expect(cache.size()).toBe(1)
	})

	it('treats nested arrays with reordered elements as different keys', () => {
		cache.set('coingecko', 'crypto', { ids: ['bitcoin', 'ethereum'] }, 'btc-first')
		cache.set('coingecko', 'crypto', { ids: ['ethereum', 'bitcoin'] }, 'eth-first')

		expect(cache.get('coingecko', 'crypto', { ids: ['bitcoin', 'ethereum'] })).toBe('btc-first')
		expect(cache.get('coingecko', 'crypto', { ids: ['ethereum', 'bitcoin'] })).toBe('eth-first')
		expect(cache.size()).toBe(2)
	})

	it('misses when a nested object carries the same fields in a different order', () => {
		// NOTE: suspected bug — only top-level keys are sorted, so logically
		// identical nested args produce two entries and an avoidable refetch.
		cache.set('alpha-vantage', 'financials', { filters: { form: '10-K', limit: 5 } }, 'nested')

		expect(
			cache.get('alpha-vantage', 'financials', { filters: { limit: 5, form: '10-K' } }),
		).toBeUndefined()
	})

	it('treats an explicitly undefined arg as different from an omitted one', () => {
		// NOTE: suspected bug — callers that spread optional flags (the router does
		// `{ action, ...args }`) get a second entry for the same logical request.
		cache.set('yahoo-finance', 'history', { symbol: 'AAPL', interval: undefined }, 'explicit')

		expect(cache.get('yahoo-finance', 'history', { symbol: 'AAPL' })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'history', { symbol: 'AAPL', interval: undefined })).toBe(
			'explicit',
		)
	})

	it('distinguishes an undefined arg from the string "undefined"', () => {
		cache.set('yahoo-finance', 'history', { interval: undefined }, 'real-undefined')
		cache.set('yahoo-finance', 'history', { interval: 'undefined' }, 'string-undefined')

		expect(cache.get('yahoo-finance', 'history', { interval: undefined })).toBe('real-undefined')
		expect(cache.get('yahoo-finance', 'history', { interval: 'undefined' })).toBe(
			'string-undefined',
		)
		expect(cache.size()).toBe(2)
	})

	it('conflates NaN and Infinity args with null', () => {
		// NOTE: suspected bug — JSON.stringify turns NaN/Infinity into `null`, so a
		// failed Number() parse collides with an unrelated null-valued arg.
		cache.set('fred', 'macro', { limit: null }, 'null-arg')
		cache.set('fred', 'macro', { limit: Number.NaN }, 'nan-arg')

		expect(cache.size()).toBe(1)
		expect(cache.get('fred', 'macro', { limit: null })).toBe('nan-arg')
		expect(cache.get('fred', 'macro', { limit: Number.POSITIVE_INFINITY })).toBe('nan-arg')
	})

	it('serialises Date args to their ISO string', () => {
		cache.set('fred', 'macro', { from: new Date('2024-01-31T00:00:00.000Z') }, 'january')

		expect(cache.get('fred', 'macro', { from: '2024-01-31T00:00:00.000Z' })).toBe('january')
		expect(cache.get('fred', 'macro', { from: '2024-01-31' })).toBeUndefined()
	})

	it('collides when an arg name contains the key delimiters', () => {
		// NOTE: suspected bug — makeKey joins with `&` and `=` without escaping, so
		// an arg named `a=1&b` is indistinguishable from the args { a: 1, b: 2 }.
		cache.set('yahoo-finance', 'quote', { a: 1, b: 2 }, 'two-args')

		expect(cache.get('yahoo-finance', 'quote', { 'a=1&b': 2 })).toBe('two-args')

		cache.set('yahoo-finance', 'quote', { 'a=1&b': 2 }, 'one-arg')
		expect(cache.get('yahoo-finance', 'quote', { a: 1, b: 2 })).toBe('one-arg')
		expect(cache.size()).toBe(1)
	})

	it('never lets two providers share an entry for the same category and args', () => {
		const providers = ['yahoo-finance', 'finnhub', 'alpha-vantage']
		for (const provider of providers) {
			cache.set(provider, 'quote', { symbol: 'AAPL' }, `from-${provider}`)
		}

		expect(cache.size()).toBe(providers.length)
		for (const provider of providers) {
			expect(cache.get(provider, 'quote', { symbol: 'AAPL' })).toBe(`from-${provider}`)
		}
	})

	it('never lets two categories share an entry for the same provider and args', () => {
		for (const category of ALL_CATEGORIES) {
			cache.set('yahoo-finance', category, { symbol: 'AAPL' }, `from-${category}`)
		}

		expect(cache.size()).toBe(ALL_CATEGORIES.length)
		for (const category of ALL_CATEGORIES) {
			expect(cache.get('yahoo-finance', category, { symbol: 'AAPL' })).toBe(`from-${category}`)
		}
	})
})

describe('per-category TTL', () => {
	it.each(TTL_TABLE)('serves %s entries for %d ms and no longer', (category, ttl) => {
		cache.set('yahoo-finance', category, { symbol: 'AAPL' }, AAPL_QUOTE)

		vi.advanceTimersByTime(ttl - 1)
		expect(cache.get('yahoo-finance', category, { symbol: 'AAPL' })).toEqual(AAPL_QUOTE)

		vi.advanceTimersByTime(1)
		expect(cache.get('yahoo-finance', category, { symbol: 'AAPL' })).toBeUndefined()
	})

	it('counts an entry as expired at exactly its expiry instant', () => {
		cache.set('sec-edgar', 'search', { q: 'apple' }, ['AAPL'])

		vi.advanceTimersByTime(299_999)
		expect(cache.get('sec-edgar', 'search', { q: 'apple' })).toEqual(['AAPL'])

		vi.advanceTimersByTime(1)
		expect(cache.get('sec-edgar', 'search', { q: 'apple' })).toBeUndefined()
	})

	it('expires each category on its own clock', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'quote-data')
		cache.set('yahoo-finance', 'financials', { symbol: 'AAPL' }, 'financials-data')
		cache.set('binance', 'crypto', { symbol: 'BTCUSDT' }, 'crypto-data')

		vi.advanceTimersByTime(15_000)
		expect(cache.get('binance', 'crypto', { symbol: 'BTCUSDT' })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBe('quote-data')

		vi.advanceTimersByTime(15_000)
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'financials', { symbol: 'AAPL' })).toBe('financials-data')
	})

	it('restarts the TTL when an existing key is written again', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'first')

		vi.advanceTimersByTime(29_000)
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'second')

		vi.advanceTimersByTime(29_999)
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBe('second')

		vi.advanceTimersByTime(1)
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
	})

	it('expires sibling entries independently', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'aapl')
		vi.advanceTimersByTime(10_000)
		cache.set('yahoo-finance', 'quote', { symbol: 'MSFT' }, 'msft')

		vi.advanceTimersByTime(20_000)
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'quote', { symbol: 'MSFT' })).toBe('msft')
	})

	it('leaves an expired entry counted until something touches it', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, AAPL_QUOTE)

		vi.advanceTimersByTime(30_000)
		expect(cache.size()).toBe(1)
	})

	it('deletes the expired entry as a side effect of get()', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, AAPL_QUOTE)
		vi.advanceTimersByTime(30_000)

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
		expect(cache.size()).toBe(0)
	})

	it('only reclaims the entry that was actually read', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'aapl')
		cache.set('yahoo-finance', 'quote', { symbol: 'MSFT' }, 'msft')
		vi.advanceTimersByTime(30_000)

		expect(cache.get('yahoo-finance', 'quote', { symbol: 'AAPL' })).toBeUndefined()
		expect(cache.size()).toBe(1)
	})
})

describe('clear / size', () => {
	it('reports zero entries for an empty store', () => {
		expect(cache.size()).toBe(0)
	})

	it('counts distinct keys rather than set() calls', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 1)
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 2)
		cache.set('yahoo-finance', 'quote', { symbol: 'MSFT' }, 3)
		cache.set('finnhub', 'quote', { symbol: 'AAPL' }, 4)

		expect(cache.size()).toBe(3)
	})

	it('removes every entry, expired or not', () => {
		cache.set('yahoo-finance', 'quote', { symbol: 'AAPL' }, 'fresh')
		cache.set('yahoo-finance', 'financials', { symbol: 'AAPL' }, 'long-lived')
		vi.advanceTimersByTime(30_000)

		cache.clear()

		expect(cache.size()).toBe(0)
		expect(cache.get('yahoo-finance', 'financials', { symbol: 'AAPL' })).toBeUndefined()
	})

	it('is a no-op when the store is already empty', () => {
		cache.clear()
		cache.clear()

		expect(cache.size()).toBe(0)
	})
})

describe('eviction at MAX_ENTRIES', () => {
	function fill(count: number, category: DataCategory, msApart = 0): void {
		for (let i = 0; i < count; i++) {
			if (msApart > 0) vi.advanceTimersByTime(msApart)
			cache.set('yahoo-finance', category, { i }, `v${i}`)
		}
	}

	it('holds exactly MAX_ENTRIES entries without evicting anything', () => {
		fill(MAX_ENTRIES, 'financials')

		expect(cache.size()).toBe(MAX_ENTRIES)
		expect(cache.get('yahoo-finance', 'financials', { i: 0 })).toBe('v0')
		expect(cache.get('yahoo-finance', 'financials', { i: 499 })).toBe('v499')
	})

	it('drops exactly one entry — the oldest by expiry — when the cap is exceeded', () => {
		fill(MAX_ENTRIES + 1, 'financials', 1)

		expect(cache.size()).toBe(MAX_ENTRIES)
		expect(cache.get('yahoo-finance', 'financials', { i: 0 })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'financials', { i: 1 })).toBe('v1')
		expect(cache.get('yahoo-finance', 'financials', { i: 500 })).toBe('v500')
	})

	it('never grows beyond the cap across a long run of writes', () => {
		fill(700, 'financials', 1)

		expect(cache.size()).toBe(MAX_ENTRIES)
		expect(cache.get('yahoo-finance', 'financials', { i: 199 })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'financials', { i: 200 })).toBe('v200')
		expect(cache.get('yahoo-finance', 'financials', { i: 699 })).toBe('v699')
	})

	it('evicts the soonest-to-expire entry even when it was written last', () => {
		fill(MAX_ENTRIES, 'financials')
		cache.set('binance', 'crypto', { symbol: 'BTCUSDT' }, 'newest')

		expect(cache.size()).toBe(MAX_ENTRIES)
		expect(cache.get('binance', 'crypto', { symbol: 'BTCUSDT' })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'financials', { i: 0 })).toBe('v0')
		expect(cache.get('yahoo-finance', 'financials', { i: 499 })).toBe('v499')
	})

	it('purges every expired entry instead of evicting a live one', () => {
		fill(MAX_ENTRIES, 'quote')
		vi.advanceTimersByTime(30_000)
		expect(cache.size()).toBe(MAX_ENTRIES)

		cache.set('yahoo-finance', 'financials', { symbol: 'AAPL' }, 'survivor')

		expect(cache.size()).toBe(1)
		expect(cache.get('yahoo-finance', 'financials', { symbol: 'AAPL' })).toBe('survivor')
	})

	it('stops after the expired purge when that alone brings it under the cap', () => {
		for (let i = 0; i < 60; i++) cache.set('finnhub', 'quote', { i }, `stale${i}`)
		vi.advanceTimersByTime(30_000)

		fill(441, 'financials')

		expect(cache.size()).toBe(441)
		expect(cache.get('finnhub', 'quote', { i: 0 })).toBeUndefined()
		expect(cache.get('yahoo-finance', 'financials', { i: 0 })).toBe('v0')
		expect(cache.get('yahoo-finance', 'financials', { i: 440 })).toBe('v440')
	})

	it('evicts nothing when a write at the cap overwrites an existing key', () => {
		fill(MAX_ENTRIES, 'financials')
		cache.set('yahoo-finance', 'financials', { i: 0 }, 'updated')

		expect(cache.size()).toBe(MAX_ENTRIES)
		expect(cache.get('yahoo-finance', 'financials', { i: 0 })).toBe('updated')
		expect(cache.get('yahoo-finance', 'financials', { i: 1 })).toBe('v1')
		expect(cache.get('yahoo-finance', 'financials', { i: 499 })).toBe('v499')
	})
})

describe('unknown category', () => {
	it('never expires an entry written under an unrecognised category', () => {
		// NOTE: suspected bug — TTL lookup misses, so `Date.now() + undefined` is
		// NaN and `NaN <= now` is always false: the entry is cached forever. The
		// cache module is public API (`export * as cache` in src/index.ts), so a JS
		// caller can reach this.
		const unknown = 'seasonality' as unknown as DataCategory
		cache.set('yahoo-finance', unknown, { symbol: 'AAPL' }, 'immortal')

		vi.advanceTimersByTime(365 * 24 * HOUR)
		expect(cache.get('yahoo-finance', unknown, { symbol: 'AAPL' })).toBe('immortal')
		expect(cache.size()).toBe(1)
	})
})
