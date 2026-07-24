import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type {
	DividendEvent,
	EarningsData,
	FinancialStatement,
	HistoricalQuote,
	OptionContract,
	QuoteResult,
	SearchResult,
} from '../../src/types.js'
import { freshImport, freshImportAll } from '../helpers/modules.js'

/**
 * src/providers/yahoo-finance.ts is the only provider that never speaks HTTP
 * itself — it drives the `yahoo-finance2` client, which it constructs once at
 * module scope. A fetch mock therefore cannot reach it, so the package is
 * replaced wholesale here: the default export is a constructor mock returning
 * one stub instance whose methods are `vi.fn()`s.
 *
 * Every test pulls the provider through `freshImport`, so the module-scope
 * client and the `core/rate-limiter.ts` token bucket (which resets with the
 * module registry) start pristine. Nothing touches the network, and the clock
 * is pinned for the whole file because the provider derives its `period1`
 * lookback windows from `Date.now()`.
 */

/** The stub client. Implementations are supplied per test. */
const yf = vi.hoisted(() => ({
	search: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	quote: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	fundamentalsTimeSeries: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	chart: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	options: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	quoteSummary: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}))

/** `new YahooFinance({...})` runs at import time, so the ctor is mocked too. */
const YahooFinanceCtor = vi.hoisted(() => vi.fn((..._args: unknown[]) => yf))

vi.mock('yahoo-finance2', () => ({ default: YahooFinanceCtor }))

type YahooModule = typeof import('../../src/providers/yahoo-finance.js')
type RateLimiterModule = typeof import('../../src/core/rate-limiter.js')

const NOW = '2024-06-15T12:00:00.000Z'
/** 30 days before NOW — the default `history` lookback. */
const THIRTY_DAYS_AGO = new Date('2024-05-16T12:00:00.000Z')
/** 5 years before NOW — the `financials` and `dividends` lookback. */
const FIVE_YEARS_AGO = new Date('2019-06-15T12:00:00.000Z')

/** Shaped like the `quotes` entries of yahooFinance.search(). */
const SEARCH_QUOTES = [
	{
		symbol: 'AAPL',
		isYahooFinance: true,
		exchange: 'NMS',
		exchDisp: 'NASDAQ',
		shortname: 'Apple Inc.',
		longname: 'Apple Inc. (Common Stock)',
		quoteType: 'EQUITY',
	},
	{
		symbol: 'AAPL.MX',
		isYahooFinance: true,
		exchange: 'MEX',
		exchDisp: 'Mexico',
		shortname: 'Apple Inc.',
		quoteType: 'EQUITY',
	},
	{
		symbol: 'apple-news-story',
		isYahooFinance: false,
		exchange: '',
	},
]

/** Shaped like yahooFinance.quote('AAPL') (trimmed to the fields mapped). */
const QUOTE_AAPL = {
	symbol: 'AAPL',
	regularMarketPrice: 212.49,
	regularMarketChange: -1.31,
	regularMarketChangePercent: -0.6126,
	regularMarketVolume: 54321000,
	regularMarketOpen: 213.37,
	regularMarketPreviousClose: 213.8,
	regularMarketDayHigh: 215.17,
	regularMarketDayLow: 211.3,
	marketCap: 3258000000000,
	fiftyTwoWeekHigh: 220.2,
	fiftyTwoWeekLow: 164.08,
}

const MAPPED_QUOTE_AAPL: QuoteResult = {
	symbol: 'AAPL',
	price: 212.49,
	change: -1.31,
	changePercent: -0.6126,
	volume: 54321000,
	marketCap: 3258000000000,
	high52w: 220.2,
	low52w: 164.08,
	open: 213.37,
	previousClose: 213.8,
	dayHigh: 215.17,
	dayLow: 211.3,
	source: 'yahoo',
}

/** Shaped like a yahooFinance.fundamentalsTimeSeries() row. */
const ANNUAL_2023 = {
	date: new Date('2023-09-30T00:00:00.000Z'),
	periodType: '12M',
	totalRevenue: 383285000000,
	grossProfit: 169148000000,
	operatingIncome: 114301000000,
	netIncome: 96995000000,
	basicEPS: 6.16,
	dilutedEPS: 6.13,
	totalAssets: 352583000000,
	totalLiabilitiesNetMinorityInterest: 290437000000,
	stockholdersEquity: 62146000000,
	operatingCashFlow: 110543000000,
	longTermDebt: 95281000000,
	ordinarySharesNumber: 15550061000,
}

const ANNUAL_2022 = {
	...ANNUAL_2023,
	date: new Date('2022-09-24T00:00:00.000Z'),
	totalRevenue: 394328000000,
	netIncome: 99803000000,
}

const QUARTER_2024_Q2 = {
	...ANNUAL_2023,
	date: new Date('2024-03-30T00:00:00.000Z'),
	periodType: '3M',
	totalRevenue: 90753000000,
	netIncome: 23636000000,
}

const MAPPED_ANNUAL_2023: FinancialStatement = {
	period: 'annual',
	date: '2023-09-30',
	revenue: 383285000000,
	grossProfit: 169148000000,
	operatingIncome: 114301000000,
	netIncome: 96995000000,
	eps: 6.16,
	epsDiluted: 6.13,
	totalAssets: 352583000000,
	totalLiabilities: 290437000000,
	stockholdersEquity: 62146000000,
	operatingCashFlow: 110543000000,
	longTermDebt: 95281000000,
	sharesOutstanding: 15550061000,
	source: 'yahoo',
}

/** Shaped like yahooFinance.chart(). */
const CHART = {
	quotes: [
		{
			date: new Date('2024-06-13T13:30:00.000Z'),
			open: 214.74,
			high: 216.75,
			low: 211.6,
			close: 214.24,
			adjclose: 213.99,
			volume: 97862700,
		},
		{
			date: new Date('2024-06-14T13:30:00.000Z'),
			open: 213.85,
			high: 215.17,
			low: 211.3,
			close: 212.49,
			adjclose: 212.24,
			volume: 70122700,
		},
	],
}

/** Shaped like yahooFinance.options(). */
const OPTIONS_CHAINS = {
	expirationDates: [new Date('2024-06-21T00:00:00.000Z'), new Date('2024-06-28T00:00:00.000Z')],
	options: [
		{
			calls: [
				{
					strike: 210,
					expiration: new Date('2024-06-21T00:00:00.000Z'),
					lastPrice: 5.15,
					bid: 5.1,
					ask: 5.2,
					volume: 12043,
					openInterest: 30122,
					impliedVolatility: 0.2431,
				},
			],
			puts: [
				{
					strike: 210,
					expiration: new Date('2024-06-21T00:00:00.000Z'),
					lastPrice: 2.75,
					bid: 2.7,
					ask: 2.8,
					volume: 8421,
					openInterest: 19004,
					impliedVolatility: 0.2678,
				},
			],
		},
		{
			calls: [
				{
					strike: 215,
					expiration: new Date('2024-06-28T00:00:00.000Z'),
					lastPrice: 4.05,
					bid: 4,
					ask: 4.1,
					volume: 3311,
					openInterest: 9087,
					impliedVolatility: 0.2255,
				},
			],
			puts: [
				{
					strike: 215,
					expiration: new Date('2024-06-28T00:00:00.000Z'),
					lastPrice: 6.4,
					bid: 6.35,
					ask: 6.45,
					volume: 2210,
					openInterest: 7765,
					impliedVolatility: 0.2512,
				},
			],
		},
	],
}

/** Shaped like yahooFinance.quoteSummary(sym, { modules: [...] }). */
const EARNINGS_SUMMARY = {
	earnings: {
		earningsChart: {
			quarterly: [
				{ date: '2Q2023', actual: 1.26, estimate: 1.19 },
				{ date: '3Q2023', actual: 1.46, estimate: 1.39 },
				{ date: '4Q2023', actual: 2.18, estimate: 2.1 },
				{ date: '1Q2024', actual: 1.53, estimate: 1.5 },
			],
		},
	},
	calendarEvents: {
		earnings: {
			earningsDate: [new Date('2024-08-01T20:00:00.000Z')],
			earningsAverage: 1.35,
			revenueAverage: 84300000000,
		},
	},
}

/** Shaped like yahooFinance.chart(sym, { events: 'dividends' }). */
const DIVIDEND_CHART = {
	events: {
		dividends: {
			'1683849000': { date: new Date('2023-05-12T00:00:00.000Z'), amount: 0.24 },
			'1691711400': { date: new Date('2023-08-11T00:00:00.000Z'), amount: 0.24 },
			'1707316200': { date: new Date('2024-02-09T00:00:00.000Z'), amount: 0.24 },
		},
	},
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
	vi.useRealTimers()
})

/** A provider from a brand new module generation (fresh client, fresh bucket). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<YahooModule>('../../src/providers/yahoo-finance.js')
	return mod.yahoo
}

/** Provider + the rate limiter it actually shares a module generation with. */
async function importWithLimiter(): Promise<{ provider: Provider; limiter: RateLimiterModule }> {
	const mods = await freshImportAll({
		yahoo: '../../src/providers/yahoo-finance.js',
		limiter: '../../src/core/rate-limiter.js',
	})
	return {
		provider: (mods.yahoo as unknown as YahooModule).yahoo,
		limiter: mods.limiter as unknown as RateLimiterModule,
	}
}

/** Asserts no client method was reached, so "never called upstream" is a real claim. */
function expectNoClientCalls(): void {
	expect(yf.search).not.toHaveBeenCalled()
	expect(yf.quote).not.toHaveBeenCalled()
	expect(yf.fundamentalsTimeSeries).not.toHaveBeenCalled()
	expect(yf.chart).not.toHaveBeenCalled()
	expect(yf.options).not.toHaveBeenCalled()
	expect(yf.quoteSummary).not.toHaveBeenCalled()
}

async function searchOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', args)
	return result.data
}

async function quoteOf(provider: Provider, args: Record<string, unknown>): Promise<QuoteResult> {
	const result = await provider.execute<QuoteResult>('quote', 'get', args)
	return result.data
}

async function quotesOf(provider: Provider, args: Record<string, unknown>): Promise<QuoteResult[]> {
	const result = await provider.execute<QuoteResult[]>('quote', 'get', args)
	return result.data
}

async function financialsOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<FinancialStatement[]> {
	const result = await provider.execute<FinancialStatement[]>('financials', 'get', args)
	return result.data
}

async function historyOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<HistoricalQuote[]> {
	const result = await provider.execute<HistoricalQuote[]>('history', 'get', args)
	return result.data
}

async function optionsOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<OptionContract[]> {
	const result = await provider.execute<OptionContract[]>('options', 'get', args)
	return result.data
}

async function earningsOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<EarningsData[]> {
	const result = await provider.execute<EarningsData[]>('earnings', 'get', args)
	return result.data
}

async function dividendsOf(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<DividendEvent[]> {
	const result = await provider.execute<DividendEvent[]>('dividends', 'get', args)
	return result.data
}

/** Builds `count` annual rows dated Dec 31 of consecutive years, oldest first. */
function annualRows(count: number, firstYear: number): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_unused, i) => ({
		...ANNUAL_2023,
		date: new Date(`${firstYear + i}-12-31T00:00:00.000Z`),
	}))
}

describe('provider metadata', () => {
	it('advertises a keyless provider covering seven categories', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('yahoo')
		expect(provider.requiresKey).toBe(false)
		expect(provider.keyEnvVar).toBeUndefined()
		expect(provider.capabilities).toEqual([
			'search',
			'quote',
			'financials',
			'history',
			'options',
			'earnings',
			'dividends',
		])
		expect(provider.priority).toEqual({
			search: 3,
			quote: 1,
			financials: 2,
			history: 1,
			options: 1,
			earnings: 1,
			dividends: 1,
		})
		expect(provider.rateLimits).toEqual({ maxRequests: 60, windowMs: 60_000 })
	})

	it('is always enabled, since it needs no credentials', async () => {
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})

	it('builds one client at import time with the library notices suppressed', async () => {
		await importProvider()

		expect(YahooFinanceCtor).toHaveBeenCalledTimes(1)
		expect(YahooFinanceCtor).toHaveBeenCalledWith({
			suppressNotices: ['yahooSurvey', 'ripHistorical'],
		})
	})
})

describe('search/search', () => {
	it('passes the query straight to the client and wraps the hits in a result', async () => {
		yf.search.mockResolvedValue({ quotes: SEARCH_QUOTES })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'apple' })

		expect(yf.search).toHaveBeenCalledWith('apple')
		expect(result.source).toBe('yahoo')
		expect(result.cached).toBe(false)
		expect(result.data).toEqual([
			{
				symbol: 'AAPL',
				name: 'Apple Inc. (Common Stock)',
				exchange: 'NASDAQ',
				type: 'EQUITY',
				source: 'yahoo',
			},
			{
				symbol: 'AAPL.MX',
				name: 'Apple Inc.',
				exchange: 'Mexico',
				type: 'EQUITY',
				source: 'yahoo',
			},
		])
	})

	it('drops entries that are not tradeable Yahoo Finance instruments', async () => {
		yf.search.mockResolvedValue({ quotes: SEARCH_QUOTES })
		const provider = await importProvider()

		const results = await searchOf(provider, { query: 'apple' })

		expect(results).toHaveLength(2)
		expect(results.map((r) => r.symbol)).not.toContain('apple-news-story')
	})

	it('returns nothing when every hit is a non-instrument', async () => {
		yf.search.mockResolvedValue({
			quotes: [
				{ symbol: 'a', isYahooFinance: false, exchange: 'X' },
				{ symbol: 'b', isYahooFinance: false, exchange: 'Y' },
			],
		})
		const provider = await importProvider()

		expect(await searchOf(provider, { query: 'apple' })).toEqual([])
	})

	it('prefers longname for the display name', async () => {
		yf.search.mockResolvedValue({
			quotes: [
				{
					symbol: 'MSFT',
					isYahooFinance: true,
					exchange: 'NMS',
					shortname: 'Microsoft',
					longname: 'Microsoft Corporation',
				},
			],
		})
		const provider = await importProvider()

		expect((await searchOf(provider, { query: 'msft' }))[0].name).toBe('Microsoft Corporation')
	})

	it('falls back to shortname when longname is missing', async () => {
		yf.search.mockResolvedValue({
			quotes: [{ symbol: 'MSFT', isYahooFinance: true, exchange: 'NMS', shortname: 'Microsoft' }],
		})
		const provider = await importProvider()

		expect((await searchOf(provider, { query: 'msft' }))[0].name).toBe('Microsoft')
	})

	it('falls back to the symbol when both names are missing', async () => {
		yf.search.mockResolvedValue({
			quotes: [{ symbol: 'MSFT', isYahooFinance: true, exchange: 'NMS' }],
		})
		const provider = await importProvider()

		expect((await searchOf(provider, { query: 'msft' }))[0].name).toBe('MSFT')
	})

	it('falls back to the raw exchange code when exchDisp is missing', async () => {
		yf.search.mockResolvedValue({
			quotes: [{ symbol: 'MSFT', isYahooFinance: true, exchange: 'NMS' }],
		})
		const provider = await importProvider()

		expect((await searchOf(provider, { query: 'msft' }))[0].exchange).toBe('NMS')
	})

	it('leaves type undefined when the hit has no quoteType', async () => {
		yf.search.mockResolvedValue({
			quotes: [{ symbol: 'MSFT', isYahooFinance: true, exchange: 'NMS' }],
		})
		const provider = await importProvider()

		expect((await searchOf(provider, { query: 'msft' }))[0].type).toBeUndefined()
	})

	it('returns an empty list for an empty quotes array', async () => {
		yf.search.mockResolvedValue({ quotes: [] })
		const provider = await importProvider()

		expect(await searchOf(provider, { query: 'zzzzzz' })).toEqual([])
	})

	it('rejects a missing query without calling the client', async () => {
		const provider = await importProvider()

		await expect(searchOf(provider, {})).rejects.toThrow('[yahoo] search requires query')
		expectNoClientCalls()
	})

	it('rejects an empty-string query', async () => {
		const provider = await importProvider()

		await expect(searchOf(provider, { query: '' })).rejects.toThrow('[yahoo] search requires query')
		expectNoClientCalls()
	})

	it('propagates a client rejection unchanged', async () => {
		const failure = new Error('yahoo search backend unavailable')
		yf.search.mockRejectedValue(failure)
		const provider = await importProvider()

		await expect(searchOf(provider, { query: 'apple' })).rejects.toBe(failure)
	})

	it('logs the failure before rethrowing when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.search.mockRejectedValue(new Error('boom'))
		const provider = await importProvider()

		await expect(searchOf(provider, { query: 'apple', verbose: true })).rejects.toThrow('boom')
		expect(logged).toHaveBeenCalledWith('[yahoo] search error:', 'boom')
	})

	it('stays quiet when verbose is not set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.search.mockRejectedValue(new Error('boom'))
		const provider = await importProvider()

		await expect(searchOf(provider, { query: 'apple' })).rejects.toThrow('boom')
		expect(logged).not.toHaveBeenCalled()
	})
})

describe('quote/get — single symbol', () => {
	it('asks the client for the one symbol and maps every field', async () => {
		yf.quote.mockResolvedValue(QUOTE_AAPL)
		const provider = await importProvider()

		const result = await provider.execute<QuoteResult>('quote', 'get', { symbol: 'AAPL' })

		expect(yf.quote).toHaveBeenCalledWith('AAPL')
		expect(result).toEqual({ data: MAPPED_QUOTE_AAPL, source: 'yahoo', cached: false })
	})

	it('defaults price, change and changePercent to 0 when the payload omits them', async () => {
		yf.quote.mockResolvedValue({ symbol: 'ZZZ' })
		const provider = await importProvider()

		const quote = await quoteOf(provider, { symbol: 'ZZZ' })

		expect(quote.price).toBe(0)
		expect(quote.change).toBe(0)
		expect(quote.changePercent).toBe(0)
	})

	it('leaves the optional fields undefined when the payload omits them', async () => {
		yf.quote.mockResolvedValue({ symbol: 'ZZZ' })
		const provider = await importProvider()

		const quote = await quoteOf(provider, { symbol: 'ZZZ' })

		expect(quote.volume).toBeUndefined()
		expect(quote.marketCap).toBeUndefined()
		expect(quote.high52w).toBeUndefined()
		expect(quote.low52w).toBeUndefined()
		expect(quote.open).toBeUndefined()
		expect(quote.previousClose).toBeUndefined()
		expect(quote.dayHigh).toBeUndefined()
		expect(quote.dayLow).toBeUndefined()
		expect(quote.source).toBe('yahoo')
	})

	it('keeps a real zero price rather than treating it as missing', async () => {
		yf.quote.mockResolvedValue({ symbol: 'ZZZ', regularMarketPrice: 0, regularMarketChange: 0 })
		const provider = await importProvider()

		const quote = await quoteOf(provider, { symbol: 'ZZZ' })

		expect(quote.price).toBe(0)
		expect(quote.change).toBe(0)
	})

	it('preserves the sign of a negative change', async () => {
		yf.quote.mockResolvedValue({
			symbol: 'AAPL',
			regularMarketPrice: 100,
			regularMarketChange: -12.5,
			regularMarketChangePercent: -11.11,
		})
		const provider = await importProvider()

		const quote = await quoteOf(provider, { symbol: 'AAPL' })

		expect(quote.change).toBe(-12.5)
		expect(quote.changePercent).toBe(-11.11)
	})

	it('reports the symbol as not found when the payload carries no symbol', async () => {
		yf.quote.mockResolvedValue({ regularMarketPrice: 1 })
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'NOPE' })).rejects.toThrow(
			'[yahoo] Symbol "NOPE" not found',
		)
	})

	it('reports the symbol as not found when the client resolves nothing', async () => {
		yf.quote.mockResolvedValue(null)
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'NOPE' })).rejects.toThrow(
			'[yahoo] Symbol "NOPE" not found',
		)
	})

	it('falls back to the single symbol when symbols is an empty array', async () => {
		yf.quote.mockResolvedValue(QUOTE_AAPL)
		const provider = await importProvider()

		const quote = await quoteOf(provider, { symbols: [], symbol: 'AAPL' })

		expect(yf.quote).toHaveBeenCalledWith('AAPL')
		expect(quote.symbol).toBe('AAPL')
	})
})

describe('quote/get — multiple symbols', () => {
	it('asks the client for the whole list in one call and maps each row', async () => {
		yf.quote.mockResolvedValue([
			QUOTE_AAPL,
			{ ...QUOTE_AAPL, symbol: 'MSFT', regularMarketPrice: 4 },
		])
		const provider = await importProvider()

		const quotes = await quotesOf(provider, { symbols: ['AAPL', 'MSFT'] })

		expect(yf.quote).toHaveBeenCalledTimes(1)
		expect(yf.quote).toHaveBeenCalledWith(['AAPL', 'MSFT'])
		expect(quotes).toHaveLength(2)
		expect(quotes[0]).toEqual(MAPPED_QUOTE_AAPL)
		expect(quotes[1].symbol).toBe('MSFT')
		expect(quotes[1].price).toBe(4)
	})

	it('prefers symbols over a symbol supplied alongside it', async () => {
		yf.quote.mockResolvedValue([QUOTE_AAPL])
		const provider = await importProvider()

		await quotesOf(provider, { symbols: ['AAPL'], symbol: 'MSFT' })

		expect(yf.quote).toHaveBeenCalledWith(['AAPL'])
	})

	it('applies the same defaults to every row of a batch', async () => {
		yf.quote.mockResolvedValue([{ symbol: 'A' }, { symbol: 'B', regularMarketPrice: 9 }])
		const provider = await importProvider()

		const quotes = await quotesOf(provider, { symbols: ['A', 'B'] })

		expect(quotes[0]).toEqual({
			symbol: 'A',
			price: 0,
			change: 0,
			changePercent: 0,
			source: 'yahoo',
		})
		expect(quotes[1].price).toBe(9)
	})

	it('reports an empty batch response with the requested symbols', async () => {
		yf.quote.mockResolvedValue([])
		const provider = await importProvider()

		await expect(quotesOf(provider, { symbols: ['AAPL', 'MSFT'] })).rejects.toThrow(
			'[yahoo] No quote data returned for symbols: AAPL, MSFT',
		)
	})

	it('reports a null batch response the same way', async () => {
		yf.quote.mockResolvedValue(null)
		const provider = await importProvider()

		await expect(quotesOf(provider, { symbols: ['AAPL'] })).rejects.toThrow(
			'[yahoo] No quote data returned for symbols: AAPL',
		)
	})
})

describe('quote/get — errors', () => {
	it('rejects when neither symbol nor symbols is supplied', async () => {
		const provider = await importProvider()

		await expect(quoteOf(provider, {})).rejects.toThrow('[yahoo] quote requires symbol or symbols')
		expectNoClientCalls()
	})

	it('rewrites a "Cannot read properties" library crash into a not-found message', async () => {
		yf.quote.mockRejectedValue(
			new TypeError("Cannot read properties of undefined (reading 'regularMarketPrice')"),
		)
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Symbol "NOTREAL" not found or returned no data',
		)
	})

	it('rewrites any error that merely mentions undefined', async () => {
		yf.quote.mockRejectedValue(new Error('quote is undefined'))
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Symbol "NOTREAL" not found or returned no data',
		)
	})

	it('names every requested symbol when a batch crashes that way', async () => {
		yf.quote.mockRejectedValue(new TypeError('Cannot read properties of undefined'))
		const provider = await importProvider()

		await expect(quotesOf(provider, { symbols: ['AAPL', 'NOTREAL'] })).rejects.toThrow(
			'[yahoo] Symbol "AAPL, NOTREAL" not found or returned no data',
		)
	})

	// NOTE: suspected bug — `symbols: []` passes the "symbol or symbols" guard but
	// not the length check, so the single-symbol path runs with `undefined`, and
	// the rewrite then joins the empty array into a nameless symbol.
	it('reports an empty symbols array as a nameless symbol', async () => {
		yf.quote.mockResolvedValue(undefined)
		const provider = await importProvider()

		await expect(quotesOf(provider, { symbols: [] })).rejects.toThrow(
			'[yahoo] Symbol "" not found or returned no data',
		)
		expect(yf.quote).toHaveBeenCalledWith(undefined)
	})

	it('propagates an unrelated library rejection unchanged', async () => {
		const failure = new Error('socket hang up')
		yf.quote.mockRejectedValue(failure)
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'AAPL' })).rejects.toBe(failure)
	})

	it('logs an unrelated failure before rethrowing when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.quote.mockRejectedValue(new Error('socket hang up'))
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'AAPL', verbose: true })).rejects.toThrow(
			'socket hang up',
		)
		expect(logged).toHaveBeenCalledWith('[yahoo] quote error:', 'socket hang up')
	})

	it('does not log the rewritten not-found error even when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.quote.mockRejectedValue(new TypeError('Cannot read properties of undefined'))
		const provider = await importProvider()

		await expect(quoteOf(provider, { symbol: 'NOTREAL', verbose: true })).rejects.toThrow(
			'not found or returned no data',
		)
		expect(logged).not.toHaveBeenCalled()
	})
})

describe('financials/get', () => {
	it('requests five years of annual fundamentals without result validation', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([ANNUAL_2023])
		const provider = await importProvider()

		await financialsOf(provider, { symbol: 'AAPL' })

		expect(yf.fundamentalsTimeSeries).toHaveBeenCalledWith(
			'AAPL',
			{ period1: FIVE_YEARS_AGO, type: 'annual', module: 'all' },
			{ validateResult: false },
		)
	})

	it('requests quarterly fundamentals when the period says so', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([QUARTER_2024_Q2])
		const provider = await importProvider()

		await financialsOf(provider, { symbol: 'AAPL', period: 'quarterly' })

		expect(yf.fundamentalsTimeSeries).toHaveBeenCalledWith(
			'AAPL',
			{ period1: FIVE_YEARS_AGO, type: 'quarterly', module: 'all' },
			{ validateResult: false },
		)
	})

	it('maps every statement field of an annual row', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([ANNUAL_2023])
		const provider = await importProvider()

		const result = await provider.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'AAPL',
		})

		expect(result).toEqual({ data: [MAPPED_ANNUAL_2023], source: 'yahoo', cached: false })
	})

	it('keeps only 12M rows for the annual period', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([ANNUAL_2023, QUARTER_2024_Q2, ANNUAL_2022])
		const provider = await importProvider()

		const statements = await financialsOf(provider, { symbol: 'AAPL' })

		expect(statements.map((s) => s.date)).toEqual(['2023-09-30', '2022-09-24'])
		expect(statements.every((s) => s.period === 'annual')).toBe(true)
	})

	it('keeps only 3M rows for the quarterly period', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([ANNUAL_2023, QUARTER_2024_Q2, ANNUAL_2022])
		const provider = await importProvider()

		const statements = await financialsOf(provider, { symbol: 'AAPL', period: 'quarterly' })

		expect(statements).toHaveLength(1)
		expect(statements[0].date).toBe('2024-03-30')
		expect(statements[0].period).toBe('quarterly')
		expect(statements[0].revenue).toBe(90753000000)
	})

	it('returns nothing when no row matches the requested period type', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([QUARTER_2024_Q2])
		const provider = await importProvider()

		expect(await financialsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('sorts statements newest first regardless of upstream order', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue(annualRows(4, 2019))
		const provider = await importProvider()

		const statements = await financialsOf(provider, { symbol: 'AAPL' })

		expect(statements.map((s) => s.date)).toEqual([
			'2022-12-31',
			'2021-12-31',
			'2020-12-31',
			'2019-12-31',
		])
	})

	it('keeps the ten most recent statements by default', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue(annualRows(12, 2012))
		const provider = await importProvider()

		const statements = await financialsOf(provider, { symbol: 'AAPL' })

		expect(statements).toHaveLength(10)
		expect(statements[0].date).toBe('2023-12-31')
		expect(statements[9].date).toBe('2014-12-31')
	})

	it('honours an explicit smaller limit', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue(annualRows(12, 2012))
		const provider = await importProvider()

		const statements = await financialsOf(provider, { symbol: 'AAPL', limit: 3 })

		expect(statements.map((s) => s.date)).toEqual(['2023-12-31', '2022-12-31', '2021-12-31'])
	})

	it('honours a limit larger than the number of statements available', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue(annualRows(2, 2022))
		const provider = await importProvider()

		expect(await financialsOf(provider, { symbol: 'AAPL', limit: 50 })).toHaveLength(2)
	})

	it('returns nothing for a limit of zero', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue(annualRows(4, 2020))
		const provider = await importProvider()

		expect(await financialsOf(provider, { symbol: 'AAPL', limit: 0 })).toEqual([])
	})

	it('drops numeric fields that are NaN, non-numeric or absent', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([
			{
				date: new Date('2023-09-30T00:00:00.000Z'),
				periodType: '12M',
				totalRevenue: Number.NaN,
				grossProfit: '169148000000',
				netIncome: null,
				basicEPS: 0,
			},
		])
		const provider = await importProvider()

		const [statement] = await financialsOf(provider, { symbol: 'AAPL' })

		expect(statement.revenue).toBeUndefined()
		expect(statement.grossProfit).toBeUndefined()
		expect(statement.netIncome).toBeUndefined()
		expect(statement.operatingIncome).toBeUndefined()
		expect(statement.eps).toBe(0)
	})

	it('formats a Date as a plain calendar day, dropping the time', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([
			{ ...ANNUAL_2023, date: new Date('2023-09-30T23:45:12.000Z') },
		])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' }))[0].date).toBe('2023-09-30')
	})

	it('reads a numeric date as UNIX seconds', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([{ ...ANNUAL_2023, date: 1704067200 }])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' }))[0].date).toBe('2024-01-01')
	})

	it('trims the time off an ISO date string', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([
			{ ...ANNUAL_2023, date: '2023-12-31T00:00:00.000Z' },
		])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' }))[0].date).toBe('2023-12-31')
	})

	it('passes a date-only string through untouched', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([{ ...ANNUAL_2023, date: '2023-03-15' }])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' }))[0].date).toBe('2023-03-15')
	})

	it('maps a null date to an empty string', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([{ ...ANNUAL_2023, date: null }])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' }))[0].date).toBe('')
	})

	it('maps a missing date to an empty string and sorts it last', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([{ ...ANNUAL_2023, date: undefined }, ANNUAL_2022])
		const provider = await importProvider()

		expect((await financialsOf(provider, { symbol: 'AAPL' })).map((s) => s.date)).toEqual([
			'2022-09-24',
			'',
		])
	})

	it('returns an empty list when the client returns no rows', async () => {
		yf.fundamentalsTimeSeries.mockResolvedValue([])
		const provider = await importProvider()

		expect(await financialsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('rejects a missing symbol without calling the client', async () => {
		const provider = await importProvider()

		await expect(financialsOf(provider, {})).rejects.toThrow('[yahoo] financials requires symbol')
		expectNoClientCalls()
	})

	it('propagates a client rejection unchanged', async () => {
		const failure = new Error('fundamentals endpoint 500')
		yf.fundamentalsTimeSeries.mockRejectedValue(failure)
		const provider = await importProvider()

		await expect(financialsOf(provider, { symbol: 'AAPL' })).rejects.toBe(failure)
	})

	it('logs the failure before rethrowing when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.fundamentalsTimeSeries.mockRejectedValue(new Error('fundamentals endpoint 500'))
		const provider = await importProvider()

		await expect(financialsOf(provider, { symbol: 'AAPL', verbose: true })).rejects.toThrow(
			'fundamentals endpoint 500',
		)
		expect(logged).toHaveBeenCalledWith('[yahoo] financials error:', 'fundamentals endpoint 500')
	})
})

describe('history/get', () => {
	it('charts the last 30 days by default', async () => {
		yf.chart.mockResolvedValue(CHART)
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'AAPL' })

		expect(yf.chart).toHaveBeenCalledWith('AAPL', { period1: THIRTY_DAYS_AGO })
	})

	it('honours an explicit day count', async () => {
		yf.chart.mockResolvedValue(CHART)
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'AAPL', days: 7 })

		expect(yf.chart).toHaveBeenCalledWith('AAPL', {
			period1: new Date('2024-06-08T12:00:00.000Z'),
		})
	})

	it('treats an explicitly undefined day count as absent', async () => {
		yf.chart.mockResolvedValue(CHART)
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'AAPL', days: undefined })

		expect(yf.chart).toHaveBeenCalledWith('AAPL', { period1: THIRTY_DAYS_AGO })
	})

	// NOTE: suspected bug — `?? 30` only catches null/undefined, so `--days 0`
	// asks Yahoo for a window that starts now instead of falling back to 30 days.
	it('asks for a zero-length window when days is 0', async () => {
		yf.chart.mockResolvedValue(CHART)
		const provider = await importProvider()

		await historyOf(provider, { symbol: 'AAPL', days: 0 })

		expect(yf.chart).toHaveBeenCalledWith('AAPL', { period1: new Date(NOW) })
	})

	it('maps chart rows to historical quotes in upstream order', async () => {
		yf.chart.mockResolvedValue(CHART)
		const provider = await importProvider()

		const result = await provider.execute<HistoricalQuote[]>('history', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({
			data: [
				{
					date: '2024-06-13',
					open: 214.74,
					high: 216.75,
					low: 211.6,
					close: 214.24,
					adjClose: 213.99,
					volume: 97862700,
				},
				{
					date: '2024-06-14',
					open: 213.85,
					high: 215.17,
					low: 211.3,
					close: 212.49,
					adjClose: 212.24,
					volume: 70122700,
				},
			],
			source: 'yahoo',
			cached: false,
		})
	})

	it('leaves adjClose undefined when the row has no adjusted close', async () => {
		yf.chart.mockResolvedValue({
			quotes: [
				{
					date: new Date('2024-06-14T13:30:00.000Z'),
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
				},
			],
		})
		const provider = await importProvider()

		expect((await historyOf(provider, { symbol: 'AAPL' }))[0].adjClose).toBeUndefined()
	})

	it('returns an empty series when the chart carries no quotes', async () => {
		yf.chart.mockResolvedValue({})
		const provider = await importProvider()

		expect(await historyOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('returns an empty series for an empty quotes array', async () => {
		yf.chart.mockResolvedValue({ quotes: [] })
		const provider = await importProvider()

		expect(await historyOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('rejects a missing symbol without calling the client', async () => {
		const provider = await importProvider()

		await expect(historyOf(provider, {})).rejects.toThrow('[yahoo] history requires symbol')
		expectNoClientCalls()
	})

	it('wraps any client rejection in a history-specific message', async () => {
		yf.chart.mockRejectedValue(new Error('HTTP 404 Not Found'))
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Could not fetch history for "NOTREAL"',
		)
	})

	it('hides the underlying cause unless verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.chart.mockRejectedValue(new Error('HTTP 404 Not Found'))
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'NOTREAL' })).rejects.not.toThrow('HTTP 404')
		expect(logged).not.toHaveBeenCalled()
	})

	it('logs the underlying cause when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.chart.mockRejectedValue(new Error('HTTP 404 Not Found'))
		const provider = await importProvider()

		await expect(historyOf(provider, { symbol: 'NOTREAL', verbose: true })).rejects.toThrow(
			'[yahoo] Could not fetch history for "NOTREAL"',
		)
		expect(logged).toHaveBeenCalledWith('[yahoo] history error:', 'HTTP 404 Not Found')
	})
})

describe('options/get', () => {
	it('flattens calls and puts from every expiration into one list', async () => {
		yf.options.mockResolvedValue(OPTIONS_CHAINS)
		const provider = await importProvider()

		const result = await provider.execute<OptionContract[]>('options', 'get', { symbol: 'AAPL' })

		expect(yf.options).toHaveBeenCalledWith('AAPL')
		expect(result.source).toBe('yahoo')
		expect(result.cached).toBe(false)
		expect(result.data).toEqual([
			{
				strike: 210,
				expiration: '2024-06-21',
				type: 'call',
				lastPrice: 5.15,
				bid: 5.1,
				ask: 5.2,
				volume: 12043,
				openInterest: 30122,
				impliedVolatility: 0.2431,
			},
			{
				strike: 210,
				expiration: '2024-06-21',
				type: 'put',
				lastPrice: 2.75,
				bid: 2.7,
				ask: 2.8,
				volume: 8421,
				openInterest: 19004,
				impliedVolatility: 0.2678,
			},
			{
				strike: 215,
				expiration: '2024-06-28',
				type: 'call',
				lastPrice: 4.05,
				bid: 4,
				ask: 4.1,
				volume: 3311,
				openInterest: 9087,
				impliedVolatility: 0.2255,
			},
			{
				strike: 215,
				expiration: '2024-06-28',
				type: 'put',
				lastPrice: 6.4,
				bid: 6.35,
				ask: 6.45,
				volume: 2210,
				openInterest: 7765,
				impliedVolatility: 0.2512,
			},
		])
	})

	it('tags each contract with its own side', async () => {
		yf.options.mockResolvedValue(OPTIONS_CHAINS)
		const provider = await importProvider()

		const contracts = await optionsOf(provider, { symbol: 'AAPL' })

		expect(contracts.filter((c) => c.type === 'call')).toHaveLength(2)
		expect(contracts.filter((c) => c.type === 'put')).toHaveLength(2)
	})

	it('accepts a chain that only has calls', async () => {
		yf.options.mockResolvedValue({
			options: [{ calls: [{ strike: 100, expiration: new Date('2024-07-19T00:00:00.000Z') }] }],
		})
		const provider = await importProvider()

		expect(await optionsOf(provider, { symbol: 'AAPL' })).toEqual([
			{
				strike: 100,
				expiration: '2024-07-19',
				type: 'call',
				lastPrice: undefined,
				bid: undefined,
				ask: undefined,
				volume: undefined,
				openInterest: undefined,
				impliedVolatility: undefined,
			},
		])
	})

	it('accepts a chain that only has puts', async () => {
		yf.options.mockResolvedValue({
			options: [{ puts: [{ strike: 100, expiration: new Date('2024-07-19T00:00:00.000Z') }] }],
		})
		const provider = await importProvider()

		const contracts = await optionsOf(provider, { symbol: 'AAPL' })

		expect(contracts).toHaveLength(1)
		expect(contracts[0].type).toBe('put')
	})

	it('reads a numeric expiration as UNIX seconds', async () => {
		yf.options.mockResolvedValue({
			options: [{ calls: [{ strike: 100, expiration: 1721347200 }] }],
		})
		const provider = await importProvider()

		expect((await optionsOf(provider, { symbol: 'AAPL' }))[0].expiration).toBe('2024-07-19')
	})

	it('returns an empty list when the payload carries no chains', async () => {
		yf.options.mockResolvedValue({ expirationDates: [] })
		const provider = await importProvider()

		expect(await optionsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('returns an empty list for a chain with neither calls nor puts', async () => {
		yf.options.mockResolvedValue({ options: [{}] })
		const provider = await importProvider()

		expect(await optionsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('rejects a missing symbol without calling the client', async () => {
		const provider = await importProvider()

		await expect(optionsOf(provider, {})).rejects.toThrow('[yahoo] options requires symbol')
		expectNoClientCalls()
	})

	it('wraps any client rejection in an options-specific message', async () => {
		yf.options.mockRejectedValue(new Error('no option chain for symbol'))
		const provider = await importProvider()

		await expect(optionsOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Could not fetch options for "NOTREAL"',
		)
	})

	it('logs the underlying cause when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.options.mockRejectedValue(new Error('no option chain for symbol'))
		const provider = await importProvider()

		await expect(optionsOf(provider, { symbol: 'NOTREAL', verbose: true })).rejects.toThrow(
			'[yahoo] Could not fetch options for "NOTREAL"',
		)
		expect(logged).toHaveBeenCalledWith('[yahoo] options error:', 'no option chain for symbol')
	})
})

describe('earnings/get', () => {
	it('asks for the earnings and calendarEvents modules only', async () => {
		yf.quoteSummary.mockResolvedValue(EARNINGS_SUMMARY)
		const provider = await importProvider()

		await earningsOf(provider, { symbol: 'AAPL' })

		expect(yf.quoteSummary).toHaveBeenCalledWith('AAPL', {
			modules: ['earnings', 'calendarEvents'],
		})
	})

	it('puts the upcoming report ahead of the historical quarters', async () => {
		yf.quoteSummary.mockResolvedValue(EARNINGS_SUMMARY)
		const provider = await importProvider()

		const result = await provider.execute<EarningsData[]>('earnings', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('yahoo')
		expect(result.data).toEqual([
			{ symbol: 'AAPL', earningsDate: '2024-08-01', epsEstimate: 1.35, source: 'yahoo' },
			{
				symbol: 'AAPL',
				earningsDate: '2Q2023',
				epsActual: 1.26,
				epsEstimate: 1.19,
				source: 'yahoo',
			},
			{
				symbol: 'AAPL',
				earningsDate: '3Q2023',
				epsActual: 1.46,
				epsEstimate: 1.39,
				source: 'yahoo',
			},
			{
				symbol: 'AAPL',
				earningsDate: '4Q2023',
				epsActual: 2.18,
				epsEstimate: 2.1,
				source: 'yahoo',
			},
			{
				symbol: 'AAPL',
				earningsDate: '1Q2024',
				epsActual: 1.53,
				epsEstimate: 1.5,
				source: 'yahoo',
			},
		])
	})

	it('leaves the upcoming report without an actual EPS', async () => {
		yf.quoteSummary.mockResolvedValue(EARNINGS_SUMMARY)
		const provider = await importProvider()

		const [upcoming] = await earningsOf(provider, { symbol: 'AAPL' })

		expect(upcoming.epsActual).toBeUndefined()
	})

	// NOTE: suspected bug — calendarEvents.revenueAverage is read from the payload
	// but never mapped, so EarningsData.revenueEstimate is always undefined.
	it('never reports a revenue estimate for the upcoming report', async () => {
		yf.quoteSummary.mockResolvedValue(EARNINGS_SUMMARY)
		const provider = await importProvider()

		const [upcoming] = await earningsOf(provider, { symbol: 'AAPL' })

		expect(upcoming.revenueEstimate).toBeUndefined()
	})

	it('uses only the first upcoming earnings date', async () => {
		yf.quoteSummary.mockResolvedValue({
			...EARNINGS_SUMMARY,
			calendarEvents: {
				earnings: {
					earningsDate: [
						new Date('2024-08-01T20:00:00.000Z'),
						new Date('2024-08-06T20:00:00.000Z'),
					],
					earningsAverage: 1.35,
				},
			},
		})
		const provider = await importProvider()

		const entries = await earningsOf(provider, { symbol: 'AAPL' })

		expect(entries.filter((e) => e.earningsDate === '2024-08-06')).toEqual([])
		expect(entries[0].earningsDate).toBe('2024-08-01')
	})

	it('returns only the historical quarters when no report is scheduled', async () => {
		yf.quoteSummary.mockResolvedValue({ earnings: EARNINGS_SUMMARY.earnings })
		const provider = await importProvider()

		const entries = await earningsOf(provider, { symbol: 'AAPL' })

		expect(entries).toHaveLength(4)
		expect(entries[0].earningsDate).toBe('2Q2023')
	})

	it('ignores an empty earnings-date list', async () => {
		yf.quoteSummary.mockResolvedValue({
			...EARNINGS_SUMMARY,
			calendarEvents: { earnings: { earningsDate: [], earningsAverage: 1.35 } },
		})
		const provider = await importProvider()

		expect(await earningsOf(provider, { symbol: 'AAPL' })).toHaveLength(4)
	})

	it('returns just the upcoming report when there is no earnings history', async () => {
		yf.quoteSummary.mockResolvedValue({ calendarEvents: EARNINGS_SUMMARY.calendarEvents })
		const provider = await importProvider()

		expect(await earningsOf(provider, { symbol: 'AAPL' })).toEqual([
			{ symbol: 'AAPL', earningsDate: '2024-08-01', epsEstimate: 1.35, source: 'yahoo' },
		])
	})

	it('returns an empty list for an empty summary', async () => {
		yf.quoteSummary.mockResolvedValue({})
		const provider = await importProvider()

		expect(await earningsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('echoes the requested symbol on every entry', async () => {
		yf.quoteSummary.mockResolvedValue(EARNINGS_SUMMARY)
		const provider = await importProvider()

		const entries = await earningsOf(provider, { symbol: 'msft' })

		expect(entries.every((e) => e.symbol === 'msft')).toBe(true)
	})

	it('rejects a missing symbol without calling the client', async () => {
		const provider = await importProvider()

		await expect(earningsOf(provider, {})).rejects.toThrow('[yahoo] earnings requires symbol')
		expectNoClientCalls()
	})

	it('wraps any client rejection in an earnings-specific message', async () => {
		yf.quoteSummary.mockRejectedValue(new Error('quoteSummary module unavailable'))
		const provider = await importProvider()

		await expect(earningsOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Could not fetch earnings for "NOTREAL"',
		)
	})

	it('logs the underlying cause when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.quoteSummary.mockRejectedValue(new Error('quoteSummary module unavailable'))
		const provider = await importProvider()

		await expect(earningsOf(provider, { symbol: 'NOTREAL', verbose: true })).rejects.toThrow(
			'[yahoo] Could not fetch earnings for "NOTREAL"',
		)
		expect(logged).toHaveBeenCalledWith(
			'[yahoo] earnings error:',
			'quoteSummary module unavailable',
		)
	})
})

describe('dividends/get', () => {
	it('charts five years of dividend events', async () => {
		yf.chart.mockResolvedValue(DIVIDEND_CHART)
		const provider = await importProvider()

		await dividendsOf(provider, { symbol: 'AAPL' })

		expect(yf.chart).toHaveBeenCalledWith('AAPL', {
			period1: FIVE_YEARS_AGO,
			events: 'dividends',
		})
	})

	it('maps the dividend map to dated amounts, newest first', async () => {
		yf.chart.mockResolvedValue(DIVIDEND_CHART)
		const provider = await importProvider()

		const result = await provider.execute<DividendEvent[]>('dividends', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({
			data: [
				{ date: '2024-02-09', amount: 0.24, source: 'yahoo' },
				{ date: '2023-08-11', amount: 0.24, source: 'yahoo' },
				{ date: '2023-05-12', amount: 0.24, source: 'yahoo' },
			],
			source: 'yahoo',
			cached: false,
		})
	})

	it('sorts by date rather than trusting the upstream key order', async () => {
		yf.chart.mockResolvedValue({
			events: {
				dividends: {
					b: { date: new Date('2021-01-15T00:00:00.000Z'), amount: 0.2 },
					a: { date: new Date('2023-01-15T00:00:00.000Z'), amount: 0.23 },
					c: { date: new Date('2022-01-15T00:00:00.000Z'), amount: 0.22 },
				},
			},
		})
		const provider = await importProvider()

		expect((await dividendsOf(provider, { symbol: 'AAPL' })).map((d) => d.date)).toEqual([
			'2023-01-15',
			'2022-01-15',
			'2021-01-15',
		])
	})

	it('returns an empty list when the chart has no events', async () => {
		yf.chart.mockResolvedValue({})
		const provider = await importProvider()

		expect(await dividendsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('returns an empty list when the dividend map is empty', async () => {
		yf.chart.mockResolvedValue({ events: { dividends: {} } })
		const provider = await importProvider()

		expect(await dividendsOf(provider, { symbol: 'AAPL' })).toEqual([])
	})

	it('rejects a missing symbol without calling the client', async () => {
		const provider = await importProvider()

		await expect(dividendsOf(provider, {})).rejects.toThrow('[yahoo] dividends requires symbol')
		expectNoClientCalls()
	})

	it('wraps any client rejection in a dividends-specific message', async () => {
		yf.chart.mockRejectedValue(new Error('chart events unavailable'))
		const provider = await importProvider()

		await expect(dividendsOf(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[yahoo] Could not fetch dividends for "NOTREAL"',
		)
	})

	it('logs the underlying cause when verbose is set', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		yf.chart.mockRejectedValue(new Error('chart events unavailable'))
		const provider = await importProvider()

		await expect(dividendsOf(provider, { symbol: 'NOTREAL', verbose: true })).rejects.toThrow(
			'[yahoo] Could not fetch dividends for "NOTREAL"',
		)
		expect(logged).toHaveBeenCalledWith('[yahoo] dividends error:', 'chart events unavailable')
	})
})

describe('unsupported operations', () => {
	it('names the category/action pair it cannot serve', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'list', { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Unsupported operation: quote/list',
		)
		expectNoClientCalls()
	})

	it('rejects a category it has no capability for', async () => {
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', { series: 'GDP' })).rejects.toThrow(
			'[yahoo] Unsupported operation: macro/get',
		)
	})

	it('rejects the right action under the wrong category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('search', 'get', { query: 'apple' })).rejects.toThrow(
			'[yahoo] Unsupported operation: search/get',
		)
	})

	it('matches the operation key case-sensitively', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'Get', { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Unsupported operation: quote/Get',
		)
	})

	it('rejects an empty action name', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', '', { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Unsupported operation: quote/',
		)
	})
})

describe('rate limiting', () => {
	it('spends exactly one token per operation', async () => {
		yf.quote.mockResolvedValue(QUOTE_AAPL)
		const { provider, limiter } = await importWithLimiter()

		expect(limiter.getRemaining('yahoo', provider.rateLimits)).toBe(60)
		await quoteOf(provider, { symbol: 'AAPL' })
		expect(limiter.getRemaining('yahoo', provider.rateLimits)).toBe(59)
		await quoteOf(provider, { symbol: 'AAPL' })
		expect(limiter.getRemaining('yahoo', provider.rateLimits)).toBe(58)
	})

	it('spends a token even on an unsupported operation', async () => {
		const { provider, limiter } = await importWithLimiter()

		await expect(provider.execute('quote', 'list', {})).rejects.toThrow(/Unsupported operation/)
		expect(limiter.getRemaining('yahoo', provider.rateLimits)).toBe(59)
	})

	it('lets the last token through and refuses the next call', async () => {
		yf.quote.mockResolvedValue(QUOTE_AAPL)
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 59; i += 1) limiter.consumeToken('yahoo', provider.rateLimits)
		expect(limiter.getRemaining('yahoo', provider.rateLimits)).toBe(1)

		await expect(quoteOf(provider, { symbol: 'AAPL' })).resolves.toMatchObject({ symbol: 'AAPL' })
		expect(yf.quote).toHaveBeenCalledTimes(1)

		await expect(quoteOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		expect(yf.quote).toHaveBeenCalledTimes(1)
	})

	it('refuses every category once the bucket is empty', async () => {
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 60; i += 1) limiter.consumeToken('yahoo', provider.rateLimits)

		await expect(searchOf(provider, { query: 'apple' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		await expect(historyOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		await expect(optionsOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		await expect(earningsOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		await expect(dividendsOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
		expectNoClientCalls()
	})

	it('checks the bucket before validating arguments', async () => {
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 60; i += 1) limiter.consumeToken('yahoo', provider.rateLimits)

		await expect(searchOf(provider, {})).rejects.toThrow('[yahoo] Rate limit exceeded')
		await expect(quoteOf(provider, {})).rejects.toThrow('[yahoo] Rate limit exceeded')
	})

	it('checks the bucket before rejecting an unsupported operation', async () => {
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 60; i += 1) limiter.consumeToken('yahoo', provider.rateLimits)

		await expect(provider.execute('quote', 'list', {})).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)
	})

	it('serves requests again once the window refills a token', async () => {
		yf.quote.mockResolvedValue(QUOTE_AAPL)
		const { provider, limiter } = await importWithLimiter()

		for (let i = 0; i < 60; i += 1) limiter.consumeToken('yahoo', provider.rateLimits)
		await expect(quoteOf(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)

		// 60 requests per 60s means one token is restored every second.
		vi.setSystemTime(new Date('2024-06-15T12:00:01.000Z'))

		await expect(quoteOf(provider, { symbol: 'AAPL' })).resolves.toMatchObject({ symbol: 'AAPL' })
		expect(yf.quote).toHaveBeenCalledTimes(1)
	})

	it('starts each freshly imported module generation with a full bucket', async () => {
		const first = await importWithLimiter()
		for (let i = 0; i < 60; i += 1) first.limiter.consumeToken('yahoo', first.provider.rateLimits)
		await expect(searchOf(first.provider, { query: 'apple' })).rejects.toThrow(
			'[yahoo] Rate limit exceeded',
		)

		yf.search.mockResolvedValue({ quotes: [] })
		const second = await importWithLimiter()

		expect(second.limiter.getRemaining('yahoo', second.provider.rateLimits)).toBe(60)
		await expect(searchOf(second.provider, { query: 'apple' })).resolves.toEqual([])
	})
})
