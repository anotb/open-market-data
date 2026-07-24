import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type {
	FinancialStatement,
	HistoricalQuote,
	QuoteResult,
	SearchResult,
} from '../../src/types.js'
import {
	type FetchMock,
	type Responder,
	type Route,
	expectNoUnmatched,
	mockFetch,
} from '../helpers/mock-fetch.js'
import {
	type TempHome,
	clearConfigEnv,
	freshImport,
	freshImportAll,
	makeTempHome,
} from '../helpers/modules.js'

/**
 * src/providers/alpha-vantage.ts reads its key through `core/config.ts` (which
 * memoizes the resolved config) and spends `core/rate-limiter.ts` tokens from a
 * module-scope bucket. Both must be pristine per test, so every test pulls the
 * provider through `freshImport`/`freshImportAll` — one module generation gives
 * a fresh config cache and a fresh 25-token bucket.
 *
 * $HOME points at a throwaway directory and the cwd at an empty one, so the
 * config layer can never read the developer's real config or a repo `.env`.
 * Nothing here touches the network; tests that care about the token bucket pin
 * the clock so no refill can sneak in.
 */

type AlphaVantageModule = typeof import('../../src/providers/alpha-vantage.js')
type LimiterModule = typeof import('../../src/core/rate-limiter.js')

const BASE_URL = 'https://www.alphavantage.co/query'
const API_KEY = 'test-av-key-123'

const QUOTE_MATCH = 'function=GLOBAL_QUOTE'
const SEARCH_MATCH = 'function=SYMBOL_SEARCH'
const INCOME_MATCH = 'function=INCOME_STATEMENT'
const BALANCE_MATCH = 'function=BALANCE_SHEET'
const DAILY_MATCH = 'function=TIME_SERIES_DAILY'

// --- Fixtures (shaped like real Alpha Vantage payloads, trimmed) -------------

/** GET /query?function=GLOBAL_QUOTE&symbol=IBM */
const GLOBAL_QUOTE_IBM: Record<string, unknown> = {
	'01. symbol': 'IBM',
	'02. open': '168.5000',
	'03. high': '170.3200',
	'04. low': '168.1000',
	'05. price': '169.6800',
	'06. volume': '3462021',
	'07. latest trading day': '2024-06-14',
	'08. previous close': '168.8300',
	'09. change': '0.8500',
	'10. change percent': '0.5034%',
}

/** A Global Quote envelope with individual fields overridden or removed. */
function quotePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { 'Global Quote': { ...GLOBAL_QUOTE_IBM, ...overrides } }
}

/** GET /query?function=SYMBOL_SEARCH&keywords=ibm */
const SYMBOL_SEARCH = {
	bestMatches: [
		{
			'1. symbol': 'IBM',
			'2. name': 'International Business Machines Corp',
			'3. type': 'Equity',
			'4. region': 'United States',
			'5. marketOpen': '09:30',
			'6. marketClose': '16:00',
			'7. timezone': 'UTC-04',
			'8. currency': 'USD',
			'9. matchScore': '1.0000',
		},
		{
			'1. symbol': 'IBM.LON',
			'2. name': 'International Business Machines',
			'3. type': 'Equity',
			'4. region': 'United Kingdom',
			'5. marketOpen': '08:00',
			'6. marketClose': '16:30',
			'7. timezone': 'UTC+01',
			'8. currency': 'USD',
			'9. matchScore': '0.6667',
		},
	],
}

interface IncomeFixture {
	fiscalDateEnding: string
	reportedCurrency?: string
	totalRevenue?: unknown
	grossProfit?: unknown
	operatingIncome?: unknown
	netIncome?: unknown
	operatingCashflow?: unknown
}

interface BalanceFixture {
	fiscalDateEnding: string
	reportedCurrency?: string
	totalAssets?: unknown
	totalLiabilities?: unknown
	totalShareholderEquity?: unknown
	longTermDebt?: unknown
	commonStockSharesOutstanding?: unknown
}

/** Six fiscal years of INCOME_STATEMENT annualReports, newest first. */
const ANNUAL_INCOME: IncomeFixture[] = [
	{
		fiscalDateEnding: '2023-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '61860000000',
		grossProfit: '34300000000',
		operatingIncome: '6224000000',
		netIncome: '7502000000',
		operatingCashflow: '13931000000',
	},
	{
		fiscalDateEnding: '2022-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '60530000000',
		grossProfit: '32687000000',
		operatingIncome: '5967000000',
		netIncome: '1639000000',
		operatingCashflow: '10435000000',
	},
	{
		fiscalDateEnding: '2021-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '57350000000',
		grossProfit: '31486000000',
		operatingIncome: '4778000000',
		netIncome: '5743000000',
		operatingCashflow: '12796000000',
	},
	{
		fiscalDateEnding: '2020-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '55179000000',
		grossProfit: '26206000000',
		operatingIncome: '4609000000',
		netIncome: '5590000000',
		operatingCashflow: '18197000000',
	},
	{
		fiscalDateEnding: '2019-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '57714000000',
		grossProfit: '26681000000',
		operatingIncome: '8994000000',
		netIncome: '9431000000',
		operatingCashflow: '14770000000',
	},
	{
		fiscalDateEnding: '2018-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '79591000000',
		grossProfit: '36936000000',
		operatingIncome: '11342000000',
		netIncome: '8728000000',
		operatingCashflow: '15247000000',
	},
]

/** The matching BALANCE_SHEET annualReports. */
const ANNUAL_BALANCE: BalanceFixture[] = [
	{
		fiscalDateEnding: '2023-12-31',
		reportedCurrency: 'USD',
		totalAssets: '135241000000',
		totalLiabilities: '112628000000',
		totalShareholderEquity: '22533000000',
		longTermDebt: '50121000000',
		commonStockSharesOutstanding: '915258000',
	},
	{
		fiscalDateEnding: '2022-12-31',
		reportedCurrency: 'USD',
		totalAssets: '127243000000',
		totalLiabilities: '105222000000',
		totalShareholderEquity: '21944000000',
		longTermDebt: '46189000000',
		commonStockSharesOutstanding: '905958000',
	},
	{
		fiscalDateEnding: '2021-12-31',
		reportedCurrency: 'USD',
		totalAssets: '132001000000',
		totalLiabilities: '113005000000',
		totalShareholderEquity: '18901000000',
		longTermDebt: '44917000000',
		commonStockSharesOutstanding: '896320000',
	},
	{
		fiscalDateEnding: '2020-12-31',
		reportedCurrency: 'USD',
		totalAssets: '155971000000',
		totalLiabilities: '135244000000',
		totalShareholderEquity: '20597000000',
		longTermDebt: '54355000000',
		commonStockSharesOutstanding: '892653000',
	},
	{
		fiscalDateEnding: '2019-12-31',
		reportedCurrency: 'USD',
		totalAssets: '152186000000',
		totalLiabilities: '131202000000',
		totalShareholderEquity: '20841000000',
		longTermDebt: '54102000000',
		commonStockSharesOutstanding: '887110000',
	},
	{
		fiscalDateEnding: '2018-12-31',
		reportedCurrency: 'USD',
		totalAssets: '123382000000',
		totalLiabilities: '106452000000',
		totalShareholderEquity: '16796000000',
		longTermDebt: '35605000000',
		commonStockSharesOutstanding: '892426000',
	},
]

const QUARTERLY_INCOME: IncomeFixture[] = [
	{
		fiscalDateEnding: '2024-03-31',
		reportedCurrency: 'USD',
		totalRevenue: '14462000000',
		grossProfit: '7885000000',
		operatingIncome: '1246000000',
		netIncome: '1605000000',
		operatingCashflow: '4204000000',
	},
	{
		fiscalDateEnding: '2023-12-31',
		reportedCurrency: 'USD',
		totalRevenue: '17381000000',
		grossProfit: '10222000000',
		operatingIncome: '3208000000',
		netIncome: '3288000000',
		operatingCashflow: '4527000000',
	},
]

const QUARTERLY_BALANCE: BalanceFixture[] = [
	{
		fiscalDateEnding: '2024-03-31',
		reportedCurrency: 'USD',
		totalAssets: '137170000000',
		totalLiabilities: '113630000000',
		totalShareholderEquity: '23434000000',
		longTermDebt: '52045000000',
		commonStockSharesOutstanding: '919088000',
	},
	{
		fiscalDateEnding: '2023-12-31',
		reportedCurrency: 'USD',
		totalAssets: '135241000000',
		totalLiabilities: '112628000000',
		totalShareholderEquity: '22533000000',
		longTermDebt: '50121000000',
		commonStockSharesOutstanding: '915258000',
	},
]

interface BarFixture {
	'1. open'?: unknown
	'2. high'?: unknown
	'3. low'?: unknown
	'4. close'?: unknown
	'5. volume'?: unknown
}

/** GET /query?function=TIME_SERIES_DAILY&symbol=IBM */
function dailyPayload(series: Record<string, BarFixture>): Record<string, unknown> {
	return {
		'Meta Data': {
			'1. Information': 'Daily Prices (open, high, low, close) and Volumes',
			'2. Symbol': 'IBM',
			'3. Last Refreshed': '2024-06-14',
			'4. Output Size': 'Compact',
			'5. Time Zone': 'US/Eastern',
		},
		'Time Series (Daily)': series,
	}
}

/** A distinguishable bar: open 100+n, high 101+n, low 99+n, close 100.5+n. */
function bar(n: number): BarFixture {
	return {
		'1. open': `${100 + n}.0000`,
		'2. high': `${101 + n}.0000`,
		'3. low': `${99 + n}.0000`,
		'4. close': `${100 + n}.5000`,
		'5. volume': `${1_000_000 + n}`,
	}
}

/** `count` consecutive calendar days ending 2024-06-14, keyed newest first. */
function syntheticDays(count: number): Record<string, BarFixture> {
	const out: Record<string, BarFixture> = {}
	const end = Date.UTC(2024, 5, 14)
	for (let i = 0; i < count; i++) {
		const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10)
		out[date] = bar(count - i)
	}
	return out
}

// --- Per-test environment ---------------------------------------------------

let home: TempHome
let cwdDir: string
let restoreEnv: () => void
const originalCwd = process.cwd()

beforeEach(() => {
	restoreEnv = clearConfigEnv()
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-av-cwd-'))
	process.chdir(cwdDir)
	process.env.ALPHA_VANTAGE_API_KEY = API_KEY
})

afterEach(() => {
	vi.useRealTimers()
	process.chdir(originalCwd)
	rmSync(cwdDir, { recursive: true, force: true })
	home.cleanup()
	restoreEnv()
})

/** A provider from a brand new module generation (fresh config + token bucket). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<AlphaVantageModule>('../../src/providers/alpha-vantage.js')
	return mod.alphaVantage
}

/** Same, but with the rate limiter from that generation so tokens are observable. */
async function importWithLimiter(): Promise<{ provider: Provider; remaining: () => number }> {
	const mods = await freshImportAll({
		av: '../../src/providers/alpha-vantage.js',
		limiter: '../../src/core/rate-limiter.js',
	})
	const provider = (mods.av as unknown as AlphaVantageModule).alphaVantage
	const limiter = mods.limiter as unknown as LimiterModule
	return { provider, remaining: () => limiter.getRemaining('alphavantage', provider.rateLimits) }
}

interface MountOptions {
	quote?: Responder
	search?: Responder
	income?: Responder
	balance?: Responder
	daily?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = []
	if (options.quote) routes.push({ match: QUOTE_MATCH, respond: options.quote })
	if (options.search) routes.push({ match: SEARCH_MATCH, respond: options.search })
	if (options.income) routes.push({ match: INCOME_MATCH, respond: options.income })
	if (options.balance) routes.push({ match: BALANCE_MATCH, respond: options.balance })
	if (options.daily) routes.push({ match: DAILY_MATCH, respond: options.daily })
	return mockFetch(routes)
}

/** Shorthand for the two-request financials pair. */
function mountFinancials(income: unknown, balance: unknown): FetchMock {
	return mount({ income: { json: income }, balance: { json: balance } })
}

async function search(
	provider: Provider,
	args: Record<string, unknown> = { query: 'ibm' },
): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', args)
	return result.data
}

async function getQuote(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'IBM' },
): Promise<QuoteResult> {
	const result = await provider.execute<QuoteResult>('quote', 'get', args)
	return result.data
}

async function getFinancials(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'IBM' },
): Promise<FinancialStatement[]> {
	const result = await provider.execute<FinancialStatement[]>('financials', 'get', args)
	return result.data
}

async function getHistory(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'IBM' },
): Promise<HistoricalQuote[]> {
	const result = await provider.execute<HistoricalQuote[]>('history', 'get', args)
	return result.data
}

/** Removes the key env var (biome forbids the `delete` operator). */
function unsetApiKey(): void {
	Reflect.deleteProperty(process.env, 'ALPHA_VANTAGE_API_KEY')
}

function writeKeyConfig(key: string): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify({ alphaVantageApiKey: key }, null, 2))
}

function pinClock(): void {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
}

describe('provider metadata', () => {
	it('identifies itself as alphavantage and demands a key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('alphavantage')
		expect(provider.requiresKey).toBe(true)
		expect(provider.keyEnvVar).toBe('ALPHA_VANTAGE_API_KEY')
	})

	it('advertises search, quote, financials and history with their priorities', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['search', 'quote', 'financials', 'history'])
		expect(provider.priority).toEqual({ search: 6, quote: 5, financials: 4, history: 4 })
	})

	it('advertises the free tier limit of 25 requests per day', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 25, windowMs: 86_400_000 })
	})
})

describe('isEnabled', () => {
	it('is enabled when ALPHA_VANTAGE_API_KEY is set', async () => {
		const fx = mount()
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
		expect(fx.callCount()).toBe(0)
	})

	it('is disabled when no key is configured anywhere', async () => {
		unsetApiKey()
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('is enabled from the config file alone', async () => {
		unsetApiKey()
		writeKeyConfig('file-av-key')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})

	it('is disabled when the env var is an empty string', async () => {
		process.env.ALPHA_VANTAGE_API_KEY = ''
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('is disabled when the config file holds an empty key', async () => {
		unsetApiKey()
		writeKeyConfig('')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('ignores another provider key entirely', async () => {
		unsetApiKey()
		process.env.FINNHUB_API_KEY = 'finnhub-key'
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})
})

describe('api key handling', () => {
	it('sends the configured key as the apikey query param', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.query(QUOTE_MATCH).apikey).toBe(API_KEY)
	})

	it('carries the apikey on both requests of a financials lookup', async () => {
		const fx = mountFinancials(
			{ symbol: 'IBM', annualReports: ANNUAL_INCOME },
			{ symbol: 'IBM', annualReports: ANNUAL_BALANCE },
		)
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.callCount()).toBe(2)
		for (const call of fx.calls) {
			expect(call.parsed.searchParams.get('apikey')).toBe(API_KEY)
		}
	})

	it('prefers the environment key over the config file', async () => {
		writeKeyConfig('file-av-key')
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.query(QUOTE_MATCH).apikey).toBe(API_KEY)
	})

	it('falls back to the config file key', async () => {
		unsetApiKey()
		writeKeyConfig('file-av-key')
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.query(QUOTE_MATCH).apikey).toBe('file-av-key')
	})

	it('throws a configuration hint when no key is available', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(
			'[alphavantage] ALPHA_VANTAGE_API_KEY not set. Run: omd config set alphaVantageApiKey <key>',
		)
	})

	it('never issues a request when the key is missing', async () => {
		unsetApiKey()
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')

		expect(fx.callCount()).toBe(0)
	})

	it('treats an empty-string key as missing', async () => {
		process.env.ALPHA_VANTAGE_API_KEY = ''
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')
	})

	it('rejects search without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')
	})

	it('rejects financials without a key before either request goes out', async () => {
		unsetApiKey()
		const fx = mountFinancials({ annualReports: ANNUAL_INCOME }, { annualReports: ANNUAL_BALANCE })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')
		expect(fx.callCount()).toBe(0)
	})

	it('rejects history without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')
	})

	it('url-encodes a key containing reserved characters', async () => {
		process.env.ALPHA_VANTAGE_API_KEY = 'a b&c'
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.urls(QUOTE_MATCH)[0]).toContain('apikey=a+b%26c')
		expect(fx.query(QUOTE_MATCH).apikey).toBe('a b&c')
	})
})

describe('request plumbing', () => {
	it('builds the quote url against the Alpha Vantage query endpoint', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.urls()).toEqual([`${BASE_URL}?function=GLOBAL_QUOTE&symbol=IBM&apikey=${API_KEY}`])
	})

	it('sends only function, symbol and apikey for a quote', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider, { symbol: 'IBM', days: 5, period: 'annual' })

		expect(fx.query(QUOTE_MATCH)).toEqual({
			function: 'GLOBAL_QUOTE',
			symbol: 'IBM',
			apikey: API_KEY,
		})
	})

	it('sends the search keywords rather than a symbol', async () => {
		const fx = mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		await search(provider, { query: 'international business' })

		expect(fx.query(SEARCH_MATCH)).toEqual({
			function: 'SYMBOL_SEARCH',
			keywords: 'international business',
			apikey: API_KEY,
		})
	})

	it('url-encodes a query with spaces and reserved characters', async () => {
		const fx = mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		await search(provider, { query: 'b&o a/s' })

		expect(fx.urls(SEARCH_MATCH)[0]).toContain('keywords=b%26o+a%2Fs')
		expect(fx.query(SEARCH_MATCH).keywords).toBe('b&o a/s')
	})

	it('requests the income statement before the balance sheet', async () => {
		const fx = mountFinancials({ annualReports: ANNUAL_INCOME }, { annualReports: ANNUAL_BALANCE })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.urls()).toEqual([
			`${BASE_URL}?function=INCOME_STATEMENT&symbol=IBM&apikey=${API_KEY}`,
			`${BASE_URL}?function=BALANCE_SHEET&symbol=IBM&apikey=${API_KEY}`,
		])
	})

	it('never leaks the period argument into the financials request', async () => {
		const fx = mountFinancials(
			{ quarterlyReports: QUARTERLY_INCOME },
			{ quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		await getFinancials(provider, { symbol: 'IBM', period: 'quarterly' })

		expect(fx.query(INCOME_MATCH)).toEqual({
			function: 'INCOME_STATEMENT',
			symbol: 'IBM',
			apikey: API_KEY,
		})
	})

	it('builds the history url with the outputsize hint', async () => {
		const fx = mount({ daily: { json: dailyPayload({ '2024-06-14': bar(0) }) } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'IBM', days: 10 })

		expect(fx.urls()).toEqual([
			`${BASE_URL}?function=TIME_SERIES_DAILY&symbol=IBM&outputsize=compact&apikey=${API_KEY}`,
		])
	})

	it('sends the symbol exactly as given, without upper-casing it', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider, { symbol: 'ibm' })

		expect(fx.query(QUOTE_MATCH).symbol).toBe('ibm')
	})

	it('url-encodes a symbol containing reserved characters', async () => {
		const fx = mount({ quote: { json: quotePayload({ '01. symbol': 'BRK/B' }) } })
		const provider = await importProvider()

		await getQuote(provider, { symbol: 'BRK/B' })

		expect(fx.urls(QUOTE_MATCH)[0]).toContain('symbol=BRK%2FB')
		expect(fx.query(QUOTE_MATCH).symbol).toBe('BRK/B')
	})

	it('issues exactly one request for a quote', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})
})

describe('transport errors', () => {
	it('reports the status and status text of a 500', async () => {
		mount({ quote: { status: 500, statusText: 'Internal Server Error', text: 'boom' } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(
			'[alphavantage] HTTP 500: Internal Server Error',
		)
	})

	it('reports a 404 with its status text', async () => {
		mount({ quote: { status: 404, statusText: 'Not Found' } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] HTTP 404: Not Found')
	})

	it('reports a 429 with its status text', async () => {
		mount({ search: { status: 429, statusText: 'Too Many Requests' } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('[alphavantage] HTTP 429: Too Many Requests')
	})

	it('reports a 403 raised by the history route', async () => {
		mount({ daily: { status: 403, statusText: 'Forbidden' } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow('[alphavantage] HTTP 403: Forbidden')
	})

	it('leaves a trailing colon when the response carries no status text', async () => {
		mount({ quote: { status: 503 } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] HTTP 503: ')
	})

	it('never parses the body of a non-OK response', async () => {
		mount({ quote: { status: 500, statusText: 'Server Error', text: '<html>nginx</html>' } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('HTTP 500: Server Error')
	})

	it('propagates an income statement failure out of financials', async () => {
		mount({
			income: { status: 500, statusText: 'Server Error' },
			balance: { json: { annualReports: ANNUAL_BALANCE } },
		})
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('[alphavantage] HTTP 500: Server Error')
	})

	it('propagates a balance sheet failure out of financials', async () => {
		mount({
			income: { json: { annualReports: ANNUAL_INCOME } },
			balance: { status: 502, statusText: 'Bad Gateway' },
		})
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('[alphavantage] HTTP 502: Bad Gateway')
	})

	it('propagates a network-level rejection untouched', async () => {
		mount({ quote: { throw: new Error('ECONNREFUSED') } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('ECONNREFUSED')
	})

	it('rejects malformed JSON from an OK response', async () => {
		mount({ quote: { text: '<html>maintenance</html>' } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(SyntaxError)
	})

	it('surfaces a 204 as a raw JSON parse error rather than a provider error', async () => {
		// NOTE: suspected bug — `response.ok` is true for 204, so the empty body reaches
		// `response.json()` and escapes as a SyntaxError instead of a `[alphavantage] …` error.
		mount({ quote: { status: 204 } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(SyntaxError)
	})
})

describe('body-level error signalling', () => {
	it('throws the "Error Message" an invalid symbol produces', async () => {
		const invalid =
			'Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for GLOBAL_QUOTE.'
		mount({ quote: { json: { 'Error Message': invalid } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(`[alphavantage] ${invalid}`)
	})

	it('throws the "Note" the per-minute throttle produces', async () => {
		const note =
			'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.'
		mount({ quote: { json: { Note: note } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(`[alphavantage] ${note}`)
	})

	it('throws the "Information" the daily-limit notice produces', async () => {
		const info =
			'We have detected your API key as demo. Our standard API rate limit is 25 requests per day.'
		mount({ quote: { json: { Information: info } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(`[alphavantage] ${info}`)
	})

	it('all three signals arrive with HTTP 200, not an error status', async () => {
		const fx = mount({ search: { json: { Information: 'rate limit reached' } } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('[alphavantage] rate limit reached')
		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('prefers "Error Message" over "Note" and "Information"', async () => {
		mount({
			quote: { json: { 'Error Message': 'bad call', Note: 'throttled', Information: 'daily cap' } },
		})
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] bad call')
	})

	it('prefers "Note" over "Information"', async () => {
		mount({ quote: { json: { Note: 'throttled', Information: 'daily cap' } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] throttled')
	})

	it('detects the error field on the history route too', async () => {
		mount({ daily: { json: { 'Error Message': 'Invalid API call.' } } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow('[alphavantage] Invalid API call.')
	})

	it('detects the error field on the search route too', async () => {
		mount({ search: { json: { Note: 'call frequency exceeded' } } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('[alphavantage] call frequency exceeded')
	})

	it('fails a financials lookup when only the balance sheet reports the limit', async () => {
		mount({
			income: { json: { annualReports: ANNUAL_INCOME } },
			balance: { json: { Information: 'daily cap reached' } },
		})
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('[alphavantage] daily cap reached')
	})

	it('ignores an empty-string error field because the check is truthiness-based', async () => {
		mount({ quote: { json: { 'Error Message': '', Note: '', ...quotePayload() } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.symbol).toBe('IBM')
	})
})

describe('rate limiting', () => {
	it('allows exactly 25 requests before the bucket runs dry', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()
		pinClock()

		for (let i = 0; i < 25; i++) {
			await getQuote(provider)
		}

		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] Rate limit exceeded')
		expect(fx.callCount()).toBe(25)
	})

	it('spends one token on a quote', async () => {
		mount({ quote: { json: quotePayload() } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		expect(remaining()).toBe(25)
		await getQuote(provider)

		expect(remaining()).toBe(24)
	})

	it('spends one token on a search', async () => {
		mount({ search: { json: SYMBOL_SEARCH } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await search(provider)

		expect(remaining()).toBe(24)
	})

	it('spends one token on a history lookup', async () => {
		mount({ daily: { json: dailyPayload({ '2024-06-14': bar(0) }) } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await getHistory(provider)

		expect(remaining()).toBe(24)
	})

	it('spends two tokens on a financials lookup because it fetches two statements', async () => {
		mountFinancials({ annualReports: ANNUAL_INCOME }, { annualReports: ANNUAL_BALANCE })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await getFinancials(provider)

		expect(remaining()).toBe(23)
	})

	it('still spends a token when the upstream call fails', async () => {
		mount({ quote: { status: 500, statusText: 'Server Error' } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(getQuote(provider)).rejects.toThrow('HTTP 500')

		expect(remaining()).toBe(24)
	})

	it('fails the balance sheet half of financials when only one token is left', async () => {
		const fx = mount({
			quote: { json: quotePayload() },
			income: { json: { annualReports: ANNUAL_INCOME } },
			balance: { json: { annualReports: ANNUAL_BALANCE } },
		})
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		for (let i = 0; i < 24; i++) {
			await getQuote(provider)
		}
		expect(remaining()).toBe(1)

		await expect(getFinancials(provider)).rejects.toThrow('[alphavantage] Rate limit exceeded')
		expect(fx.callCount(INCOME_MATCH)).toBe(1)
		expect(fx.callCount(BALANCE_MATCH)).toBe(0)
	})

	it('never issues a request once the bucket is empty', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()
		pinClock()

		for (let i = 0; i < 25; i++) {
			await getQuote(provider)
		}
		await expect(getQuote(provider)).rejects.toThrow('Rate limit exceeded')
		await expect(getQuote(provider)).rejects.toThrow('Rate limit exceeded')

		expect(fx.callCount()).toBe(25)
	})

	it('gives every module generation a fresh bucket', async () => {
		mount({ quote: { json: quotePayload() } })
		const first = await importProvider()
		pinClock()

		for (let i = 0; i < 25; i++) {
			await getQuote(first)
		}
		await expect(getQuote(first)).rejects.toThrow('Rate limit exceeded')

		const second = await importProvider()
		await expect(getQuote(second)).resolves.toBeDefined()
	})

	it('burns the daily budget on calls that never leave the process when no key is set', async () => {
		// NOTE: suspected bug — `avFetch` consumes a rate-limit token *before* `getApiKey()`
		// runs, so an unconfigured install spends its 25-request daily allowance on requests
		// that are never sent, and then reports "Rate limit exceeded" instead of the missing key.
		unsetApiKey()
		mount({ quote: { json: quotePayload() } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		for (let i = 0; i < 25; i++) {
			await expect(getQuote(provider)).rejects.toThrow('ALPHA_VANTAGE_API_KEY not set')
		}

		expect(remaining()).toBe(0)
		await expect(getQuote(provider)).rejects.toThrow('[alphavantage] Rate limit exceeded')
	})
})

describe('numeric coercion', () => {
	const CASES: [raw: unknown, expected: number | undefined][] = [
		['61860000000', 61860000000],
		['0', 0],
		['0.00', 0],
		['1234.56', 1234.56],
		['-4230000000', -4230000000],
		['-0.75', -0.75],
		['1e9', 1000000000],
		[42, 42],
		['None', undefined],
		['', undefined],
		[null, undefined],
		[undefined, undefined],
		['N/A', undefined],
		['1,234', undefined],
		['abc', undefined],
		['12.3.4', undefined],
	]

	it.each(CASES)('maps the raw revenue %j to %j', async (raw, expected) => {
		mountFinancials(
			{ annualReports: [{ fiscalDateEnding: '2023-12-31', totalRevenue: raw }] },
			{ annualReports: [] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(expected)
	})

	it('treats the literal string "None" as missing rather than zero', async () => {
		mount({ quote: { json: quotePayload({ '06. volume': 'None' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.volume).toBeUndefined()
	})

	it('is case sensitive about "None", so "none" parses as unparseable', async () => {
		mount({ quote: { json: quotePayload({ '06. volume': 'none' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.volume).toBeUndefined()
	})

	it('turns a whitespace-only value into zero instead of undefined', async () => {
		// NOTE: suspected bug — the guard only rejects the empty string, and `Number('   ')`
		// is 0, so a padded-blank field becomes a real-looking data point at zero.
		mountFinancials(
			{ annualReports: [{ fiscalDateEnding: '2023-12-31', totalRevenue: '   ' }] },
			{ annualReports: [] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(0)
	})

	it('keeps a genuine zero distinct from a missing value', async () => {
		mount({ quote: { json: quotePayload({ '02. open': '0.0000', '03. high': 'None' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.open).toBe(0)
		expect(quote.dayHigh).toBeUndefined()
	})
})

describe('search/search', () => {
	it('maps every match onto a SearchResult row', async () => {
		mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([
			{
				symbol: 'IBM',
				name: 'International Business Machines Corp',
				exchange: 'United States',
				type: 'Equity',
				source: 'alphavantage',
			},
			{
				symbol: 'IBM.LON',
				name: 'International Business Machines',
				exchange: 'United Kingdom',
				type: 'Equity',
				source: 'alphavantage',
			},
		])
	})

	it('keeps the order Alpha Vantage ranked the matches in', async () => {
		mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results.map((r) => r.symbol)).toEqual(['IBM', 'IBM.LON'])
	})

	it('drops the currency, timezone and match score metadata', async () => {
		mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(Object.keys(results[0]).sort()).toEqual(['exchange', 'name', 'source', 'symbol', 'type'])
	})

	it('returns an empty list when nothing matches', async () => {
		mount({ search: { json: { bestMatches: [] } } })
		const provider = await importProvider()

		const results = await search(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('defaults a missing bestMatches array to an empty list', async () => {
		mount({ search: { json: {} } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([])
	})

	it('defaults a null bestMatches array to an empty list', async () => {
		mount({ search: { json: { bestMatches: null } } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([])
	})

	it('leaves fields undefined when a match omits them', async () => {
		mount({ search: { json: { bestMatches: [{ '1. symbol': 'SPARSE' }] } } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([
			{
				symbol: 'SPARSE',
				name: undefined,
				exchange: undefined,
				type: undefined,
				source: 'alphavantage',
			},
		])
	})

	it('rejects a missing query', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('search', 'search', {})).rejects.toThrow(
			'[alphavantage] search requires query',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string query', async () => {
		const provider = await importProvider()

		await expect(search(provider, { query: '' })).rejects.toThrow(
			'[alphavantage] search requires query',
		)
	})

	it('checks the query before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('search', 'search', {})).rejects.toThrow(
			'[alphavantage] search requires query',
		)
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ search: { json: SYMBOL_SEARCH } })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'ibm' })

		expect(result.source).toBe('alphavantage')
		expect(result.cached).toBe(false)
	})
})

describe('quote/get', () => {
	it('maps every numbered Global Quote field', async () => {
		mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote).toEqual({
			symbol: 'IBM',
			price: 169.68,
			change: 0.85,
			changePercent: 0.5034,
			volume: 3462021,
			open: 168.5,
			previousClose: 168.83,
			dayHigh: 170.32,
			dayLow: 168.1,
			source: 'alphavantage',
		})
	})

	it('echoes the symbol from the payload rather than the request', async () => {
		mount({ quote: { json: quotePayload({ '01. symbol': 'IBM' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider, { symbol: 'ibm' })

		expect(quote.symbol).toBe('IBM')
	})

	it('strips the trailing percent sign from the change percent', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': '1.2345%' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(1.2345)
	})

	it('keeps a negative change percent negative', async () => {
		mount({
			quote: { json: quotePayload({ '09. change': '-3.1000', '10. change percent': '-1.8340%' }) },
		})
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.change).toBe(-3.1)
		expect(quote.changePercent).toBe(-1.834)
	})

	it('accepts a change percent that carries no percent sign', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': '0.5034' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0.5034)
	})

	it('accepts an explicitly signed change percent', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': '+0.5034%' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0.5034)
	})

	it('falls back to zero for a non-numeric change percent', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': 'None%' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0)
	})

	it('falls back to zero for an empty change percent', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': '' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0)
	})

	it('falls back to zero when the change percent field is absent', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': undefined }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0)
	})

	it('falls back to zero when the change percent field is null', async () => {
		mount({ quote: { json: quotePayload({ '10. change percent': null }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0)
	})

	it('strips only the first percent sign, so a doubled one falls back to zero', async () => {
		// NOTE: suspected bug — `replace('%', '')` removes a single occurrence anywhere in the
		// string rather than trimming a trailing sign, so any residue silently becomes 0.
		mount({ quote: { json: quotePayload({ '10. change percent': '0.5034%%' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.changePercent).toBe(0)
	})

	it('crashes with a raw TypeError when the change percent is not a string', async () => {
		// NOTE: suspected bug — the `?? '0'` guard only covers null/undefined, so a numeric
		// change percent reaches `.replace` and escapes as an unprefixed TypeError.
		mount({ quote: { json: quotePayload({ '10. change percent': 0.5034 }) } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(TypeError)
	})

	it('falls back to zero for a missing price and change', async () => {
		mount({
			quote: { json: quotePayload({ '05. price': undefined, '09. change': undefined }) },
		})
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.price).toBe(0)
		expect(quote.change).toBe(0)
	})

	it('falls back to zero for an unparseable price', async () => {
		mount({ quote: { json: quotePayload({ '05. price': 'None' }) } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.price).toBe(0)
	})

	it('leaves the optional fields undefined when Alpha Vantage omits them', async () => {
		mount({
			quote: {
				json: quotePayload({
					'02. open': undefined,
					'03. high': undefined,
					'04. low': undefined,
					'06. volume': undefined,
					'08. previous close': undefined,
				}),
			},
		})
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.volume).toBeUndefined()
		expect(quote.open).toBeUndefined()
		expect(quote.previousClose).toBeUndefined()
		expect(quote.dayHigh).toBeUndefined()
		expect(quote.dayLow).toBeUndefined()
	})

	it('never reports a market cap or 52 week range', async () => {
		mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.marketCap).toBeUndefined()
		expect(quote.high52w).toBeUndefined()
		expect(quote.low52w).toBeUndefined()
	})

	it('throws when the payload has no Global Quote key', async () => {
		mount({ quote: { json: { 'Meta Data': {} } } })
		const provider = await importProvider()

		await expect(getQuote(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[alphavantage] No quote data returned for "AAPL"',
		)
	})

	it('throws for the empty Global Quote an unknown symbol produces', async () => {
		mount({ quote: { json: { 'Global Quote': {} } } })
		const provider = await importProvider()

		await expect(getQuote(provider, { symbol: 'NOSUCHTICKER' })).rejects.toThrow(
			'[alphavantage] No quote data returned for "NOSUCHTICKER"',
		)
	})

	it('throws when the Global Quote is null', async () => {
		mount({ quote: { json: { 'Global Quote': null } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(
			'[alphavantage] No quote data returned for "IBM"',
		)
	})

	it('throws when the Global Quote carries an empty symbol', async () => {
		mount({ quote: { json: quotePayload({ '01. symbol': '' }) } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow(
			'[alphavantage] No quote data returned for "IBM"',
		)
	})

	it('rejects a missing symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', {})).rejects.toThrow(
			'[alphavantage] quote requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol', async () => {
		const provider = await importProvider()

		await expect(getQuote(provider, { symbol: '' })).rejects.toThrow(
			'[alphavantage] quote requires symbol',
		)
	})

	it('checks the symbol before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', {})).rejects.toThrow(
			'[alphavantage] quote requires symbol',
		)
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ quote: { json: quotePayload() } })
		const provider = await importProvider()

		const result = await provider.execute<QuoteResult>('quote', 'get', { symbol: 'IBM' })

		expect(result.source).toBe('alphavantage')
		expect(result.cached).toBe(false)
	})
})

describe('financials/get', () => {
	it('reads the annual reports by default', async () => {
		mountFinancials(
			{ symbol: 'IBM', annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ symbol: 'IBM', annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements.map((s) => s.date)).toEqual([
			'2023-12-31',
			'2022-12-31',
			'2021-12-31',
			'2020-12-31',
			'2019-12-31',
		])
		expect(statements.every((s) => s.period === 'annual')).toBe(true)
	})

	it('reads the quarterly reports when asked for them', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: 'quarterly' })

		expect(statements.map((s) => s.date)).toEqual(['2024-03-31', '2023-12-31'])
		expect(statements.every((s) => s.period === 'quarterly')).toBe(true)
	})

	it('treats a null period as annual', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: null })

		expect(statements[0].date).toBe('2023-12-31')
		expect(statements[0].period).toBe('annual')
	})

	it('treats an explicitly undefined period as annual', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: undefined })

		expect(statements[0].period).toBe('annual')
	})

	it('routes an unrecognised period to the quarterly reports', async () => {
		// NOTE: suspected bug — the period is never validated: anything other than the exact
		// string 'annual' selects quarterlyReports and is then stamped onto every row, so
		// `--period ttm` silently returns quarterly data labelled "ttm".
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: 'ttm' })

		expect(statements.map((s) => s.date)).toEqual(['2024-03-31', '2023-12-31'])
		expect(statements[0].period).toBe('ttm')
	})

	it('routes an empty-string period to the quarterly reports', async () => {
		// NOTE: same root cause — `?? 'annual'` only fires for null/undefined.
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: QUARTERLY_INCOME },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: QUARTERLY_BALANCE },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: '' })

		expect(statements.map((s) => s.date)).toEqual(['2024-03-31', '2023-12-31'])
		expect(statements[0].period).toBe('')
	})

	it('joins the balance sheet onto the income statement by fiscal date', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME.slice(0, 1) },
			{ annualReports: ANNUAL_BALANCE.slice(0, 1) },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toEqual([
			{
				period: 'annual',
				date: '2023-12-31',
				revenue: 61860000000,
				grossProfit: 34300000000,
				operatingIncome: 6224000000,
				netIncome: 7502000000,
				operatingCashFlow: 13931000000,
				totalAssets: 135241000000,
				totalLiabilities: 112628000000,
				stockholdersEquity: 22533000000,
				longTermDebt: 50121000000,
				sharesOutstanding: 915258000,
				source: 'alphavantage',
			},
		])
	})

	it('joins by date rather than by position', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME.slice(0, 2) },
			{ annualReports: [ANNUAL_BALANCE[1], ANNUAL_BALANCE[0]] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].date).toBe('2023-12-31')
		expect(statements[0].totalAssets).toBe(135241000000)
		expect(statements[1].date).toBe('2022-12-31')
		expect(statements[1].totalAssets).toBe(127243000000)
	})

	it('still yields a row when no balance sheet matches the fiscal date', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME.slice(0, 2) },
			{ annualReports: [ANNUAL_BALANCE[0]] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(2)
		expect(statements[1]).toEqual({
			period: 'annual',
			date: '2022-12-31',
			revenue: 60530000000,
			grossProfit: 32687000000,
			operatingIncome: 5967000000,
			netIncome: 1639000000,
			operatingCashFlow: 10435000000,
			totalAssets: undefined,
			totalLiabilities: undefined,
			stockholdersEquity: undefined,
			longTermDebt: undefined,
			sharesOutstanding: undefined,
			source: 'alphavantage',
		})
	})

	it('ignores a balance sheet report that no income statement matches', async () => {
		mountFinancials({ annualReports: [ANNUAL_INCOME[0]] }, { annualReports: ANNUAL_BALANCE })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(statements[0].date).toBe('2023-12-31')
	})

	it('keeps the last balance report when two share a fiscal date', async () => {
		mountFinancials(
			{ annualReports: [ANNUAL_INCOME[0]] },
			{
				annualReports: [
					{ ...ANNUAL_BALANCE[0], totalAssets: '1' },
					{ ...ANNUAL_BALANCE[0], totalAssets: '2' },
				],
			},
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].totalAssets).toBe(2)
	})

	it('caps the result at five reports even when more are returned', async () => {
		mountFinancials({ annualReports: ANNUAL_INCOME }, { annualReports: ANNUAL_BALANCE })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(5)
		expect(statements.map((s) => s.date)).not.toContain('2018-12-31')
	})

	it('returns every report when fewer than five are available', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME.slice(0, 3) },
			{ annualReports: ANNUAL_BALANCE.slice(0, 3) },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(3)
	})

	it('defaults a missing income report array to empty', async () => {
		mountFinancials({ symbol: 'IBM' }, { annualReports: ANNUAL_BALANCE })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toEqual([])
	})

	it('defaults a missing balance report array to empty', async () => {
		mountFinancials({ annualReports: ANNUAL_INCOME.slice(0, 1) }, { symbol: 'IBM' })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(statements[0].totalAssets).toBeUndefined()
		expect(statements[0].revenue).toBe(61860000000)
	})

	it('returns an empty list when both report arrays are missing', async () => {
		mountFinancials({ symbol: 'IBM' }, { symbol: 'IBM' })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toEqual([])
	})

	it('returns an empty list when the requested period has no reports', async () => {
		mountFinancials(
			{ annualReports: ANNUAL_INCOME, quarterlyReports: [] },
			{ annualReports: ANNUAL_BALANCE, quarterlyReports: [] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'IBM', period: 'quarterly' })

		expect(statements).toEqual([])
	})

	it('leaves the operating cash flow undefined for a real income statement payload', async () => {
		// NOTE: suspected bug — Alpha Vantage only reports operatingCashflow from the CASH_FLOW
		// function, never from INCOME_STATEMENT, so `operatingCashFlow` is always undefined in
		// practice even though the CLI renders a column for it.
		mountFinancials(
			{
				annualReports: [
					{
						fiscalDateEnding: '2023-12-31',
						reportedCurrency: 'USD',
						totalRevenue: '61860000000',
						grossProfit: '34300000000',
						operatingIncome: '6224000000',
						netIncome: '7502000000',
					},
				],
			},
			{ annualReports: [ANNUAL_BALANCE[0]] },
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].operatingCashFlow).toBeUndefined()
		expect(statements[0].netIncome).toBe(7502000000)
	})

	it('never populates the eps fields', async () => {
		mountFinancials({ annualReports: [ANNUAL_INCOME[0]] }, { annualReports: [ANNUAL_BALANCE[0]] })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].eps).toBeUndefined()
		expect(statements[0].epsDiluted).toBeUndefined()
	})

	it('coerces "None" balance figures to undefined', async () => {
		mountFinancials(
			{ annualReports: [ANNUAL_INCOME[0]] },
			{
				annualReports: [
					{ ...ANNUAL_BALANCE[0], longTermDebt: 'None', commonStockSharesOutstanding: 'None' },
				],
			},
		)
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].longTermDebt).toBeUndefined()
		expect(statements[0].sharesOutstanding).toBeUndefined()
		expect(statements[0].totalAssets).toBe(135241000000)
	})

	it('rejects a missing symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('financials', 'get', {})).rejects.toThrow(
			'[alphavantage] financials requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol', async () => {
		const provider = await importProvider()

		await expect(getFinancials(provider, { symbol: '' })).rejects.toThrow(
			'[alphavantage] financials requires symbol',
		)
	})

	it('checks the symbol before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('financials', 'get', { period: 'annual' })).rejects.toThrow(
			'[alphavantage] financials requires symbol',
		)
	})

	it('reports the source and cache flag on the envelope', async () => {
		mountFinancials({ annualReports: [ANNUAL_INCOME[0]] }, { annualReports: [ANNUAL_BALANCE[0]] })
		const provider = await importProvider()

		const result = await provider.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'IBM',
		})

		expect(result.source).toBe('alphavantage')
		expect(result.cached).toBe(false)
	})
})

describe('history/get', () => {
	it('maps a daily bar onto a HistoricalQuote', async () => {
		mount({
			daily: {
				json: dailyPayload({
					'2024-06-14': {
						'1. open': '168.5000',
						'2. high': '170.3200',
						'3. low': '168.1000',
						'4. close': '169.6800',
						'5. volume': '3462021',
					},
				}),
			},
		})
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes).toEqual([
			{ date: '2024-06-14', open: 168.5, high: 170.32, low: 168.1, close: 169.68, volume: 3462021 },
		])
	})

	it('never populates the adjusted close', async () => {
		mount({ daily: { json: dailyPayload({ '2024-06-14': bar(0) }) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes[0].adjClose).toBeUndefined()
	})

	it('sorts the series newest first regardless of payload order', async () => {
		mount({
			daily: {
				json: dailyPayload({
					'2024-06-12': bar(1),
					'2024-06-14': bar(3),
					'2024-06-11': bar(0),
					'2024-06-13': bar(2),
				}),
			},
		})
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes.map((q) => q.date)).toEqual([
			'2024-06-14',
			'2024-06-13',
			'2024-06-12',
			'2024-06-11',
		])
		expect(quotes[0].close).toBe(103.5)
	})

	it('sorts across month and year boundaries', async () => {
		mount({
			daily: {
				json: dailyPayload({
					'2023-12-29': bar(1),
					'2024-01-02': bar(3),
					'2023-09-05': bar(0),
					'2024-01-01': bar(2),
				}),
			},
		})
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes.map((q) => q.date)).toEqual([
			'2024-01-02',
			'2024-01-01',
			'2023-12-29',
			'2023-09-05',
		])
	})

	it('defaults to 30 days and keeps the newest 30 rows', async () => {
		mount({ daily: { json: dailyPayload(syntheticDays(40)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes).toHaveLength(30)
		expect(quotes[0].date).toBe('2024-06-14')
		expect(quotes[29].date).toBe('2024-05-16')
	})

	it('asks for the compact series by default', async () => {
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		await getHistory(provider)

		expect(fx.query(DAILY_MATCH).outputsize).toBe('compact')
	})

	it('asks for the compact series at exactly 100 days', async () => {
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'IBM', days: 100 })

		expect(fx.query(DAILY_MATCH).outputsize).toBe('compact')
	})

	it('asks for the full series at 101 days', async () => {
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'IBM', days: 101 })

		expect(fx.query(DAILY_MATCH).outputsize).toBe('full')
	})

	it('asks for the full series for a multi-year request', async () => {
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'IBM', days: 3650 })

		expect(fx.query(DAILY_MATCH).outputsize).toBe('full')
	})

	it('asks for the compact series at 99 days', async () => {
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'IBM', days: 99 })

		expect(fx.query(DAILY_MATCH).outputsize).toBe('compact')
	})

	it('slices the sorted series down to the requested number of days', async () => {
		mount({ daily: { json: dailyPayload(syntheticDays(10)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: 3 })

		expect(quotes.map((q) => q.date)).toEqual(['2024-06-14', '2024-06-13', '2024-06-12'])
	})

	it('keeps only the newest row for a single day', async () => {
		mount({ daily: { json: dailyPayload(syntheticDays(10)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: 1 })

		expect(quotes.map((q) => q.date)).toEqual(['2024-06-14'])
	})

	it('returns everything when fewer rows exist than were requested', async () => {
		mount({ daily: { json: dailyPayload(syntheticDays(4)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: 250 })

		expect(quotes).toHaveLength(4)
	})

	it('returns an empty series for an empty Time Series object', async () => {
		mount({ daily: { json: dailyPayload({}) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes).toEqual([])
	})

	it('defaults every missing OHLCV field to zero', async () => {
		mount({ daily: { json: dailyPayload({ '2024-06-14': {} }) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes).toEqual([{ date: '2024-06-14', open: 0, high: 0, low: 0, close: 0, volume: 0 }])
	})

	it('defaults individually unparseable OHLCV fields to zero', async () => {
		mount({
			daily: {
				json: dailyPayload({
					'2024-06-14': {
						'1. open': 'None',
						'2. high': '',
						'3. low': null,
						'4. close': '169.6800',
						'5. volume': 'N/A',
					},
				}),
			},
		})
		const provider = await importProvider()

		const quotes = await getHistory(provider)

		expect(quotes).toEqual([
			{ date: '2024-06-14', open: 0, high: 0, low: 0, close: 169.68, volume: 0 },
		])
	})

	it('throws when the payload has no Time Series (Daily) key', async () => {
		mount({ daily: { json: { 'Meta Data': { '2. Symbol': 'AAPL' } } } })
		const provider = await importProvider()

		await expect(getHistory(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[alphavantage] No history data returned for "AAPL"',
		)
	})

	it('throws when the Time Series is null', async () => {
		mount({ daily: { json: { 'Time Series (Daily)': null } } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow(
			'[alphavantage] No history data returned for "IBM"',
		)
	})

	it('returns nothing at all for a zero day request', async () => {
		// NOTE: suspected bug — `slice(0, 0)` returns an empty array, so `--days 0` silently
		// yields no data instead of falling back to the 30 day default or being rejected.
		mount({ daily: { json: dailyPayload(syntheticDays(10)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: 0 })

		expect(quotes).toEqual([])
	})

	it('drops the oldest rows for a negative day count', async () => {
		// NOTE: suspected bug — `slice(0, -2)` drops from the tail, so `--days -2` returns
		// every row except the two oldest instead of being rejected.
		mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: -2 })

		expect(quotes.map((q) => q.date)).toEqual(['2024-06-14', '2024-06-13', '2024-06-12'])
	})

	it('sends outputsize=compact for a NaN day count the CLI failed to parse', async () => {
		// NOTE: suspected bug — `Number.NaN > 100` is false and `slice(0, NaN)` is `slice(0, 0)`,
		// so a typo like `--days abc` quietly returns an empty series.
		const fx = mount({ daily: { json: dailyPayload(syntheticDays(5)) } })
		const provider = await importProvider()

		const quotes = await getHistory(provider, { symbol: 'IBM', days: Number.NaN })

		expect(fx.query(DAILY_MATCH).outputsize).toBe('compact')
		expect(quotes).toEqual([])
	})

	it('rejects a missing symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('history', 'get', {})).rejects.toThrow(
			'[alphavantage] history requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol', async () => {
		const provider = await importProvider()

		await expect(getHistory(provider, { symbol: '' })).rejects.toThrow(
			'[alphavantage] history requires symbol',
		)
	})

	it('checks the symbol before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('history', 'get', { days: 5 })).rejects.toThrow(
			'[alphavantage] history requires symbol',
		)
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ daily: { json: dailyPayload(syntheticDays(3)) } })
		const provider = await importProvider()

		const result = await provider.execute<HistoricalQuote[]>('history', 'get', { symbol: 'IBM' })

		expect(result.source).toBe('alphavantage')
		expect(result.cached).toBe(false)
	})
})

describe('action dispatch', () => {
	it('rejects a category it does not serve', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'quote', { symbol: 'BTC' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: crypto/quote',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an unknown action inside a supported category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'batch', { symbol: 'IBM' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: quote/batch',
		)
	})

	it('rejects an empty action', async () => {
		const provider = await importProvider()

		await expect(provider.execute('history', '', { symbol: 'IBM' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: history/',
		)
	})

	it('matches actions case-sensitively', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'GET', { symbol: 'IBM' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: quote/GET',
		)
	})

	it('does not expose search/search under another category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'search', { query: 'ibm' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: quote/search',
		)
	})

	it('does not expose the get action under the search category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('search', 'get', { symbol: 'IBM' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: search/get',
		)
	})

	it('reports the unsupported route even when no key is configured', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('options', 'chain', { symbol: 'IBM' })).rejects.toThrow(
			'[alphavantage] Unsupported operation: options/chain',
		)
	})

	it('never issues a request or spends a token for an unsupported route', async () => {
		const fx = mount({ quote: { json: quotePayload() } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(provider.execute('earnings', 'get', { symbol: 'IBM' })).rejects.toThrow(
			'Unsupported operation',
		)

		expect(fx.callCount()).toBe(0)
		expect(remaining()).toBe(25)
		expectNoUnmatched(fx)
	})
})
