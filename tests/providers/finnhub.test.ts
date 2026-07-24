import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type { EarningsData, HistoricalQuote, QuoteResult, SearchResult } from '../../src/types.js'
import { type FetchMock, type Responder, type Route, mockFetch } from '../helpers/mock-fetch.js'
import {
	type TempHome,
	clearConfigEnv,
	freshImport,
	freshImportAll,
	makeTempHome,
} from '../helpers/modules.js'

/**
 * src/providers/finnhub.ts reads its API key through `core/config.ts` (which
 * memoizes the resolved config) and spends `core/rate-limiter.ts` tokens from a
 * module-scope bucket. Both must be pristine per test, so every test pulls the
 * provider through `freshImport`/`freshImportAll` — that yields a fresh config
 * cache and a fresh token bucket inside one module generation.
 *
 * $HOME points at a throwaway directory and the cwd at an empty one, so the
 * config layer can never read the developer's real config or a repo `.env`.
 * Nothing here touches the network, and everything clock-dependent (the candle
 * from/to window, the token bucket) runs against a pinned system time.
 *
 * $TZ is pinned too. Candle dates are rendered with `toISOString()`, so the claim
 * "the ambient timezone cannot shift the date" is only testable on a machine whose
 * zone is *not* UTC — every test runs on UTC for determinism, and the one test that
 * makes that claim moves itself west of Greenwich so a local-time formatter would
 * visibly disagree.
 */

type FinnhubModule = typeof import('../../src/providers/finnhub.js')
type LimiterModule = typeof import('../../src/core/rate-limiter.js')
type RouterModule = typeof import('../../src/core/router.js')

const BASE_URL = 'https://finnhub.io/api/v1'

const SEARCH_MATCH = '/search?'
const QUOTE_MATCH = '/quote?'
const EARNINGS_MATCH = '/stock/earnings'
const CANDLE_MATCH = '/stock/candle'

const API_KEY = 'test-finnhub-key-123'

/** The instant every clock-sensitive test runs at, and its UNIX-second value. */
const NOW_ISO = '2024-06-15T12:00:00Z'
const NOW_UNIX = 1_718_452_800

// --- Fixtures (shaped like real Finnhub payloads, trimmed) ------------------

/**
 * GET /search?q=apple
 *
 * The Xetra row carries a `displaySymbol` that differs from `symbol` on purpose:
 * Finnhub hands back two spellings, and a fixture where they agree cannot show
 * which of the two the mapper actually reads.
 */
const SEARCH_APPLE = {
	count: 3,
	result: [
		{ description: 'APPLE INC', displaySymbol: 'AAPL', symbol: 'AAPL', type: 'Common Stock' },
		{ description: 'APPLE INC', displaySymbol: 'APC', symbol: 'APC.DE', type: 'Common Stock' },
		{
			description: 'APPLE HOSPITALITY REIT INC',
			displaySymbol: 'APLE',
			symbol: 'APLE',
			type: 'REIT',
		},
	],
}

/** GET /quote?symbol=AAPL */
const QUOTE_AAPL = {
	c: 212.49,
	d: 4.34,
	dp: 2.0834,
	h: 215.17,
	l: 211.3,
	o: 213.85,
	pc: 208.15,
	t: NOW_UNIX,
}

/** What Finnhub returns for a symbol it does not know: every price is zero. */
const QUOTE_UNKNOWN = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }

/** GET /stock/earnings?symbol=AAPL */
const EARNINGS_AAPL = [
	{
		actual: 1.53,
		estimate: 1.5041,
		period: '2024-03-31',
		quarter: 2,
		surprise: 0.0259,
		surprisePercent: 1.7219,
		symbol: 'AAPL',
		year: 2024,
	},
	{
		actual: 2.18,
		estimate: 2.1,
		period: '2023-12-31',
		quarter: 1,
		surprise: 0.08,
		surprisePercent: 3.8095,
		symbol: 'AAPL',
		year: 2024,
	},
]

/** GET /stock/candle?symbol=AAPL&resolution=D — five sessions, oldest first. */
const CANDLES_AAPL = {
	c: [193.12, 207.15, 213.07, 214.24, 212.49],
	h: [193.14, 207.16, 220.2, 216.75, 215.17],
	l: [191.08, 202.51, 206.9, 211.6, 211.3],
	o: [191.35, 207.82, 207.37, 214.74, 213.85],
	s: 'ok',
	t: [1_717_977_600, 1_718_064_000, 1_718_150_400, 1_718_236_800, 1_718_323_200],
	v: [97_262_077, 172_373_300, 198_134_293, 97_862_729, 70_122_748],
}

/** The rows CANDLES_AAPL must map to (t is 00:00Z on each of those dates). */
const CANDLE_ROWS: HistoricalQuote[] = [
	{
		date: '2024-06-10',
		open: 191.35,
		high: 193.14,
		low: 191.08,
		close: 193.12,
		volume: 97_262_077,
	},
	{
		date: '2024-06-11',
		open: 207.82,
		high: 207.16,
		low: 202.51,
		close: 207.15,
		volume: 172_373_300,
	},
	{ date: '2024-06-12', open: 207.37, high: 220.2, low: 206.9, close: 213.07, volume: 198_134_293 },
	{ date: '2024-06-13', open: 214.74, high: 216.75, low: 211.6, close: 214.24, volume: 97_862_729 },
	{ date: '2024-06-14', open: 213.85, high: 215.17, low: 211.3, close: 212.49, volume: 70_122_748 },
]

// --- Per-test environment ---------------------------------------------------

let home: TempHome
let cwdDir: string
let restoreEnv: () => void
const originalCwd = process.cwd()
const ORIGINAL_TZ = process.env.TZ

function setTimeZone(zone: string | undefined): void {
	if (zone === undefined) Reflect.deleteProperty(process.env, 'TZ')
	else process.env.TZ = zone
}

beforeEach(() => {
	restoreEnv = clearConfigEnv()
	setTimeZone('UTC')
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-finnhub-cwd-'))
	process.chdir(cwdDir)
	process.env.FINNHUB_API_KEY = API_KEY
})

afterEach(() => {
	vi.useRealTimers()
	setTimeZone(ORIGINAL_TZ)
	process.chdir(originalCwd)
	rmSync(cwdDir, { recursive: true, force: true })
	home.cleanup()
	restoreEnv()
})

/** A provider from a brand new module generation (fresh config + token bucket). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<FinnhubModule>('../../src/providers/finnhub.js')
	return mod.finnhub
}

/** Same, but with the router from that generation so its provider registry is empty. */
async function importWithRouter(): Promise<{ provider: Provider; router: RouterModule }> {
	const mods = await freshImportAll({
		finnhub: '../../src/providers/finnhub.js',
		router: '../../src/core/router.js',
	})
	return {
		provider: (mods.finnhub as unknown as FinnhubModule).finnhub,
		router: mods.router as unknown as RouterModule,
	}
}

/** Same, but with the rate limiter from that generation so tokens are observable. */
async function importWithLimiter(): Promise<{ provider: Provider; remaining: () => number }> {
	const mods = await freshImportAll({
		finnhub: '../../src/providers/finnhub.js',
		limiter: '../../src/core/rate-limiter.js',
	})
	const provider = (mods.finnhub as unknown as FinnhubModule).finnhub
	const limiter = mods.limiter as unknown as LimiterModule
	return { provider, remaining: () => limiter.getRemaining('finnhub', provider.rateLimits) }
}

interface MountOptions {
	search?: Responder
	quote?: Responder
	earnings?: Responder
	candle?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = []
	if (options.search) routes.push({ match: SEARCH_MATCH, respond: options.search })
	if (options.quote) routes.push({ match: QUOTE_MATCH, respond: options.quote })
	if (options.earnings) routes.push({ match: EARNINGS_MATCH, respond: options.earnings })
	if (options.candle) routes.push({ match: CANDLE_MATCH, respond: options.candle })
	return mockFetch(routes)
}

async function search(
	provider: Provider,
	args: Record<string, unknown> = { query: 'apple' },
): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', args)
	return result.data
}

async function quote(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<QuoteResult> {
	const result = await provider.execute<QuoteResult>('quote', 'get', args)
	return result.data
}

async function earnings(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<EarningsData[]> {
	const result = await provider.execute<EarningsData[]>('earnings', 'get', args)
	return result.data
}

async function history(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<HistoricalQuote[]> {
	const result = await provider.execute<HistoricalQuote[]>('history', 'get', args)
	return result.data
}

/** Removes the key env var (biome forbids the `delete` operator). */
function unsetApiKey(): void {
	Reflect.deleteProperty(process.env, 'FINNHUB_API_KEY')
}

function writeKeyConfig(key: string): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify({ finnhubApiKey: key }, null, 2))
}

function pinClock(): void {
	vi.useFakeTimers()
	vi.setSystemTime(new Date(NOW_ISO))
}

describe('provider metadata', () => {
	it('identifies itself as finnhub and demands a key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('finnhub')
		expect(provider.requiresKey).toBe(true)
		expect(provider.keyEnvVar).toBe('FINNHUB_API_KEY')
	})

	it('advertises search, quote and earnings with their priorities', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['search', 'quote', 'earnings'])
		expect(provider.priority).toEqual({ search: 5, quote: 3, earnings: 2 })
	})

	it('is unroutable for history even though execute implements history/get', async () => {
		// NOTE: suspected bug — `capabilities` omits 'history', and core/router.ts only
		// considers providers whose capabilities include the category, so the working
		// history/get branch below is unreachable through the CLI. Asserted against the
		// real router rather than left as prose: the same registered, enabled provider is
		// routable for quote and invisible for history.
		const { provider, router } = await importWithRouter()
		router.registerProvider(provider)

		expect(router.getProvidersForCategory('quote').map((p) => p.name)).toEqual(['finnhub'])
		expect(router.getProvidersForCategory('history')).toEqual([])
	})

	it('advertises the documented free-tier limit of 60 requests per minute', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 60, windowMs: 60_000 })
	})
})

describe('isEnabled', () => {
	it('is enabled when FINNHUB_API_KEY is set', async () => {
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
		writeKeyConfig('file-finnhub-key')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})

	it('is disabled when the env var is an empty string', async () => {
		process.env.FINNHUB_API_KEY = ''
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
		process.env.ALPHA_VANTAGE_API_KEY = 'av-key'
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})
})

describe('authentication', () => {
	it('sends the configured key as the token query param', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await quote(provider)

		expect(fx.query(QUOTE_MATCH).token).toBe(API_KEY)
	})

	it('prefers the environment key over the config file', async () => {
		writeKeyConfig('file-finnhub-key')
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider)

		expect(fx.query(SEARCH_MATCH).token).toBe(API_KEY)
	})

	it('falls back to the config file key', async () => {
		unsetApiKey()
		writeKeyConfig('file-finnhub-key')
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider)

		expect(fx.query(SEARCH_MATCH).token).toBe('file-finnhub-key')
	})

	it('throws a configuration hint when no key is available', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow(
			'[finnhub] FINNHUB_API_KEY not set. Run: omd config set finnhubApiKey <key>',
		)
	})

	it('treats an empty-string key as missing', async () => {
		process.env.FINNHUB_API_KEY = ''
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow('FINNHUB_API_KEY not set')
	})

	it('never issues a request when the key is missing', async () => {
		unsetApiKey()
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow('FINNHUB_API_KEY not set')

		expect(fx.callCount()).toBe(0)
	})

	it('rejects search/search without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('FINNHUB_API_KEY not set')
	})

	it('rejects earnings/get without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(earnings(provider)).rejects.toThrow('FINNHUB_API_KEY not set')
	})

	it('rejects history/get without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(history(provider)).rejects.toThrow('FINNHUB_API_KEY not set')
	})

	it('splices a key containing an ampersand straight into the query string', async () => {
		// NOTE: suspected bug — the token is interpolated without encodeURIComponent, so a
		// key holding a reserved character silently becomes extra query params and the
		// server sees a truncated token.
		process.env.FINNHUB_API_KEY = 'abc&injected=1'
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await quote(provider)

		expect(fx.urls(QUOTE_MATCH)[0]).toBe(`${BASE_URL}/quote?symbol=AAPL&token=abc&injected=1`)
		expect(fx.query(QUOTE_MATCH)).toEqual({ symbol: 'AAPL', token: 'abc', injected: '1' })
	})
})

describe('url construction', () => {
	it('builds the quote url against the documented base url', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await quote(provider)

		expect(fx.urls()).toEqual([`${BASE_URL}/quote?symbol=AAPL&token=${API_KEY}`])
	})

	it('builds the search url with the q parameter', async () => {
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider, { query: 'apple' })

		expect(fx.urls()).toEqual([`${BASE_URL}/search?q=apple&token=${API_KEY}`])
	})

	it('builds the earnings url under /stock/earnings', async () => {
		const fx = mount({ earnings: { json: EARNINGS_AAPL } })
		const provider = await importProvider()

		await earnings(provider)

		expect(fx.urls()).toEqual([`${BASE_URL}/stock/earnings?symbol=AAPL&token=${API_KEY}`])
	})

	it('builds the candle url under /stock/candle', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider)

		expect(fx.urls()).toEqual([
			`${BASE_URL}/stock/candle?symbol=AAPL&resolution=D&from=1715860800&to=1718452800&token=${API_KEY}`,
		])
	})

	it('joins the token with & because every finnhub path already carries a query string', async () => {
		const fx = mount({
			search: { json: SEARCH_APPLE },
			quote: { json: QUOTE_AAPL },
			earnings: { json: EARNINGS_AAPL },
			candle: { json: CANDLES_AAPL },
		})
		const provider = await importProvider()
		pinClock()

		await search(provider)
		await quote(provider)
		await earnings(provider)
		await history(provider)

		expect(fx.callCount()).toBe(4)
		for (const url of fx.urls()) {
			expect(url).toContain('&token=')
			expect(url).not.toContain('?token=')
			// A second '?' would mean the separator logic picked the wrong joiner.
			expect(url.split('?')).toHaveLength(2)
		}
	})
})

describe('http error handling', () => {
	it('reports the status and body of a 401', async () => {
		mount({ quote: { status: 401, text: '{"error":"Invalid API key"}' } })
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow(
			'[finnhub] API error 401: {"error":"Invalid API key"}',
		)
	})

	it('reports a 403 for an endpoint outside the free plan', async () => {
		mount({ candle: { status: 403, text: '{"error":"You do not have access to this resource."}' } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider)).rejects.toThrow(
			'[finnhub] API error 403: {"error":"You do not have access to this resource."}',
		)
	})

	it('reports a 429 with the upstream body verbatim', async () => {
		mount({ search: { status: 429, text: 'API limit reached. Please try again later.' } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow(
			'[finnhub] API error 429: API limit reached. Please try again later.',
		)
	})

	it('reports an empty body as a trailing colon', async () => {
		mount({ earnings: { status: 500 } })
		const provider = await importProvider()

		await expect(earnings(provider)).rejects.toThrow('[finnhub] API error 500: ')
	})

	it('propagates a network-level rejection untouched', async () => {
		mount({ quote: { throw: new Error('ECONNREFUSED') } })
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow('ECONNREFUSED')
	})

	it('rejects malformed JSON from an OK response', async () => {
		mount({ quote: { text: '<html>maintenance</html>' } })
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow(SyntaxError)
	})

	it('treats a 204 as success rather than an error', async () => {
		// NOTE: suspected bug — `res.ok` is true for 204, so the empty body reaches
		// `res.json()` and surfaces as a raw SyntaxError instead of a provider error.
		mount({ search: { status: 204 } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow(SyntaxError)
	})
})

describe('rate limiting', () => {
	it('allows exactly 60 requests before the bucket runs dry', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()
		pinClock()

		for (let i = 0; i < 60; i++) {
			await quote(provider)
		}

		await expect(quote(provider)).rejects.toThrow('[finnhub] Rate limit exceeded')
		expect(fx.callCount()).toBe(60)
	})

	it('spends one token per request', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		expect(remaining()).toBe(60)
		await quote(provider)

		expect(remaining()).toBe(59)
	})

	it('still spends a token when the upstream call fails', async () => {
		mount({ quote: { status: 500, text: 'boom' } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(quote(provider)).rejects.toThrow('[finnhub] API error 500')

		expect(remaining()).toBe(59)
	})

	it('spends a token even when the API key is missing', async () => {
		// NOTE: suspected bug — `consumeToken` runs before `getKey()`, so an unconfigured
		// install burns its whole minute budget on calls that never leave the process.
		unsetApiKey()
		mount({ quote: { json: QUOTE_AAPL } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(quote(provider)).rejects.toThrow('FINNHUB_API_KEY not set')

		expect(remaining()).toBe(59)
	})

	it('reports a rate limit rather than the missing key once the budget is gone', async () => {
		// NOTE: same root cause — after 60 unconfigured calls the actionable "set your key"
		// message is replaced by a misleading rate-limit error.
		unsetApiKey()
		const provider = await importProvider()
		pinClock()

		for (let i = 0; i < 60; i++) {
			await expect(quote(provider)).rejects.toThrow('FINNHUB_API_KEY not set')
		}

		await expect(quote(provider)).rejects.toThrow('[finnhub] Rate limit exceeded')
	})

	it('does not spend a token on an argument validation failure', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		for (let i = 0; i < 5; i++) {
			await expect(provider.execute('quote', 'get', {})).rejects.toThrow('quote requires symbol')
		}

		expect(remaining()).toBe(60)
	})

	it('does not spend a token on an unsupported operation', async () => {
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(provider.execute('macro', 'get', {})).rejects.toThrow('Unsupported operation')

		expect(remaining()).toBe(60)
	})

	it('shares one bucket across the different finnhub endpoints', async () => {
		mount({ quote: { json: QUOTE_AAPL }, search: { json: SEARCH_APPLE } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await quote(provider)
		await search(provider)

		expect(remaining()).toBe(58)
	})

	it('gives every module generation a fresh bucket', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const first = await importProvider()
		pinClock()

		for (let i = 0; i < 60; i++) {
			await quote(first)
		}
		await expect(quote(first)).rejects.toThrow('Rate limit exceeded')

		const second = await importProvider()
		await expect(quote(second)).resolves.toBeDefined()
	})
})

describe('quote/get', () => {
	it('maps every price field onto a QuoteResult', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(result).toEqual({
			symbol: 'AAPL',
			price: 212.49,
			change: 4.34,
			changePercent: 2.0834,
			open: 213.85,
			previousClose: 208.15,
			dayHigh: 215.17,
			dayLow: 211.3,
			source: 'finnhub',
		})
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		const result = await provider.execute<QuoteResult>('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('finnhub')
		expect(result.cached).toBe(false)
	})

	it('upper-cases the symbol in both the request and the result', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'aapl' })

		expect(fx.query(QUOTE_MATCH).symbol).toBe('AAPL')
		expect(result.symbol).toBe('AAPL')
	})

	it('upper-cases a mixed-case symbol with a share class suffix', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'brk.b' })

		expect(fx.query(QUOTE_MATCH).symbol).toBe('BRK.B')
		expect(result.symbol).toBe('BRK.B')
	})

	it('url-encodes a symbol containing reserved characters', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await quote(provider, { symbol: 'a&b c' })

		expect(fx.urls(QUOTE_MATCH)[0]).toContain('symbol=A%26B%20C')
		expect(fx.query(QUOTE_MATCH).symbol).toBe('A&B C')
	})

	it('issues exactly one request', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await quote(provider)

		expect(fx.callCount()).toBe(1)
	})

	it('coerces a null change to zero', async () => {
		mount({ quote: { json: { ...QUOTE_AAPL, d: null } } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(result.change).toBe(0)
	})

	it('coerces a null change percent to zero', async () => {
		mount({ quote: { json: { ...QUOTE_AAPL, dp: null } } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(result.changePercent).toBe(0)
	})

	it('coerces an absent change and change percent to zero', async () => {
		mount({ quote: { json: { c: 100, h: 101, l: 99, o: 99.5, pc: 100, t: NOW_UNIX } } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(result.change).toBe(0)
		expect(result.changePercent).toBe(0)
	})

	it('keeps a negative change and change percent', async () => {
		mount({ quote: { json: { ...QUOTE_AAPL, d: -3.21, dp: -1.5234 } } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(result.change).toBe(-3.21)
		expect(result.changePercent).toBe(-1.5234)
	})

	it('drops the quote timestamp, which QuoteResult has no field for', async () => {
		mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		const result = await quote(provider)

		expect(Object.keys(result).sort()).toEqual([
			'change',
			'changePercent',
			'dayHigh',
			'dayLow',
			'open',
			'previousClose',
			'price',
			'source',
			'symbol',
		])
	})

	it('rejects an all-zero payload as an invalid ticker', async () => {
		mount({ quote: { json: QUOTE_UNKNOWN } })
		const provider = await importProvider()

		await expect(quote(provider, { symbol: 'NOTREAL' })).rejects.toThrow(
			'[finnhub] No quote data for "NOTREAL" — ticker may be invalid',
		)
	})

	it('names the symbol exactly as the caller typed it in the invalid-ticker error', async () => {
		mount({ quote: { json: QUOTE_UNKNOWN } })
		const provider = await importProvider()

		await expect(quote(provider, { symbol: 'notreal' })).rejects.toThrow(
			'No quote data for "notreal" — ticker may be invalid',
		)
	})

	it('still rejects an all-zero payload when the change fields are non-zero', async () => {
		mount({ quote: { json: { c: 0, d: 1.5, dp: 2.5, h: 0, l: 0, o: 0, pc: 0, t: NOW_UNIX } } })
		const provider = await importProvider()

		await expect(quote(provider, { symbol: 'NOTREAL' })).rejects.toThrow('ticker may be invalid')
	})

	it('accepts a payload whose last price is zero but whose other prices are not', async () => {
		mount({
			quote: { json: { c: 0, d: -12.5, dp: -100, h: 13.1, l: 12.4, o: 12.6, pc: 12.5, t: 0 } },
		})
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'HALTED' })

		expect(result.price).toBe(0)
		expect(result.previousClose).toBe(12.5)
	})

	it('accepts a payload where only the previous close is non-zero', async () => {
		mount({ quote: { json: { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 4.2, t: 0 } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'THIN' })

		expect(result.previousClose).toBe(4.2)
		expect(result.price).toBe(0)
	})

	it('accepts a payload where only the open is non-zero', async () => {
		mount({ quote: { json: { c: 0, d: null, dp: null, h: 0, l: 0, o: 7.5, pc: 0, t: 0 } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'THIN' })

		expect(result.open).toBe(7.5)
	})

	it('accepts a payload where only the day high is non-zero', async () => {
		mount({ quote: { json: { c: 0, d: null, dp: null, h: 9.9, l: 0, o: 0, pc: 0, t: 0 } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'THIN' })

		expect(result.dayHigh).toBe(9.9)
	})

	it('accepts a payload where only the day low is non-zero', async () => {
		mount({ quote: { json: { c: 0, d: null, dp: null, h: 0, l: 8.8, o: 0, pc: 0, t: 0 } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'THIN' })

		expect(result.dayLow).toBe(8.8)
	})

	it('returns an undefined price for an empty payload instead of rejecting it', async () => {
		// NOTE: suspected bug — the invalid-ticker guard only fires on exact zeros, so a
		// truncated payload slips through and produces a QuoteResult with no price at all.
		mount({ quote: { json: {} } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'NOTREAL' })

		expect(result.price).toBeUndefined()
		expect(result.symbol).toBe('NOTREAL')
		expect(result.change).toBe(0)
	})

	it('returns a null price when every price field is null', async () => {
		// NOTE: same root cause — `null === 0` is false, so nulls bypass the guard.
		mount({ quote: { json: { c: null, d: null, dp: null, h: null, l: null, o: null, pc: null } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'NOTREAL' })

		expect(result.price).toBeNull()
		expect(result.changePercent).toBe(0)
	})

	it('does not treat string zeros as an invalid ticker', async () => {
		// NOTE: same root cause — the guard uses `===`, so stringified zeros pass through.
		mount({ quote: { json: { c: '0', d: '0', dp: '0', h: '0', l: '0', o: '0', pc: '0', t: 0 } } })
		const provider = await importProvider()

		const result = await quote(provider, { symbol: 'NOTREAL' })

		expect(result.price).toBe('0')
	})

	it('surfaces a raw TypeError for a null JSON body', async () => {
		// NOTE: suspected bug — `data.c` is dereferenced without a guard, so `null` (valid
		// JSON) escapes as a TypeError rather than a provider-shaped error.
		mount({ quote: { json: null } })
		const provider = await importProvider()

		await expect(quote(provider)).rejects.toThrow(TypeError)
	})
})

describe('search/search', () => {
	it('maps symbol, description and type onto SearchResult rows', async () => {
		mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([
			{ symbol: 'AAPL', name: 'APPLE INC', type: 'Common Stock', source: 'finnhub' },
			{ symbol: 'APC.DE', name: 'APPLE INC', type: 'Common Stock', source: 'finnhub' },
			{
				symbol: 'APLE',
				name: 'APPLE HOSPITALITY REIT INC',
				type: 'REIT',
				source: 'finnhub',
			},
		])
	})

	it('keeps the hits in the order Finnhub ranked them', async () => {
		mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results.map((r) => r.symbol)).toEqual(['AAPL', 'APC.DE', 'APLE'])
	})

	it('prefers the canonical symbol over displaySymbol', async () => {
		// The two spellings diverge hardest on venue-qualified rows: `symbol` is the token
		// every other Finnhub endpoint accepts, `displaySymbol` is the human-facing label.
		mount({
			search: {
				json: {
					count: 1,
					result: [
						{
							description: 'Binance BTCUSDT',
							displaySymbol: 'BTC/USDT',
							symbol: 'BINANCE:BTCUSDT',
							type: 'Crypto',
						},
					],
				},
			},
		})
		const provider = await importProvider()

		const results = await search(provider)

		expect(results[0].symbol).toBe('BINANCE:BTCUSDT')
	})

	it('drops displaySymbol and count from the mapped rows', async () => {
		mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(Object.keys(results[0]).sort()).toEqual(['name', 'source', 'symbol', 'type'])
	})

	it('leaves the exchange field off every result', async () => {
		mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results.every((r) => r.exchange === undefined)).toBe(true)
	})

	it('returns an empty array when result is null', async () => {
		mount({ search: { json: { count: 0, result: null } } })
		const provider = await importProvider()

		const results = await search(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('returns an empty array when result is absent', async () => {
		mount({ search: { json: { count: 0 } } })
		const provider = await importProvider()

		const results = await search(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('returns an empty array when result is an empty list', async () => {
		mount({ search: { json: { count: 0, result: [] } } })
		const provider = await importProvider()

		const results = await search(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('leaves name and type undefined when Finnhub omits them', async () => {
		mount({ search: { json: { count: 1, result: [{ symbol: 'SPARSE' }] } } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results[0]).toEqual({
			symbol: 'SPARSE',
			name: undefined,
			type: undefined,
			source: 'finnhub',
		})
	})

	it('sends the query verbatim without upper-casing it', async () => {
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider, { query: 'Apple Inc' })

		expect(fx.query(SEARCH_MATCH).q).toBe('Apple Inc')
	})

	it('url-encodes a query with spaces and reserved characters', async () => {
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider, { query: 'johnson & johnson' })

		expect(fx.urls(SEARCH_MATCH)[0]).toContain('q=johnson%20%26%20johnson')
		expect(fx.query(SEARCH_MATCH).q).toBe('johnson & johnson')
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'apple' })

		expect(result.source).toBe('finnhub')
		expect(result.cached).toBe(false)
	})

	it('issues exactly one request', async () => {
		const fx = mount({ search: { json: SEARCH_APPLE } })
		const provider = await importProvider()

		await search(provider)

		expect(fx.callCount()).toBe(1)
	})

	it('surfaces a raw TypeError for a null JSON body', async () => {
		// NOTE: suspected bug — search guards `data.result` but not `data` itself, unlike
		// earnings which does `(data ?? [])`, so `null` escapes as a TypeError.
		mount({ search: { json: null } })
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow(TypeError)
	})
})

describe('earnings/get', () => {
	it('maps period onto earningsDate and the eps figures', async () => {
		mount({ earnings: { json: EARNINGS_AAPL } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results).toEqual([
			{
				symbol: 'AAPL',
				earningsDate: '2024-03-31',
				epsActual: 1.53,
				epsEstimate: 1.5041,
				source: 'finnhub',
			},
			{
				symbol: 'AAPL',
				earningsDate: '2023-12-31',
				epsActual: 2.18,
				epsEstimate: 2.1,
				source: 'finnhub',
			},
		])
	})

	it('drops quarter, year, surprise and surprisePercent', async () => {
		mount({ earnings: { json: EARNINGS_AAPL } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(Object.keys(results[0]).sort()).toEqual([
			'earningsDate',
			'epsActual',
			'epsEstimate',
			'source',
			'symbol',
		])
	})

	it('turns a null actual into undefined', async () => {
		mount({ earnings: { json: [{ ...EARNINGS_AAPL[0], actual: null }] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0].epsActual).toBeUndefined()
		expect(results[0].epsEstimate).toBe(1.5041)
	})

	it('turns a null estimate into undefined', async () => {
		mount({ earnings: { json: [{ ...EARNINGS_AAPL[0], estimate: null }] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0].epsEstimate).toBeUndefined()
		expect(results[0].epsActual).toBe(1.53)
	})

	it('turns both null eps figures into undefined for an unreported quarter', async () => {
		mount({
			earnings: { json: [{ actual: null, estimate: null, period: '2024-09-30', symbol: 'AAPL' }] },
		})
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0]).toEqual({
			symbol: 'AAPL',
			earningsDate: '2024-09-30',
			epsActual: undefined,
			epsEstimate: undefined,
			source: 'finnhub',
		})
	})

	it('keeps a genuine zero eps rather than dropping it', async () => {
		mount({ earnings: { json: [{ ...EARNINGS_AAPL[0], actual: 0, estimate: 0 }] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0].epsActual).toBe(0)
		expect(results[0].epsEstimate).toBe(0)
	})

	it('keeps a negative eps', async () => {
		mount({ earnings: { json: [{ ...EARNINGS_AAPL[0], actual: -0.42 }] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0].epsActual).toBe(-0.42)
	})

	it('leaves earningsDate undefined when the period is absent', async () => {
		mount({ earnings: { json: [{ actual: 1.1, estimate: 1, symbol: 'AAPL' }] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results[0].earningsDate).toBeUndefined()
	})

	it('labels rows with the requested symbol, upper-cased, not the row symbol', async () => {
		const fx = mount({ earnings: { json: [{ ...EARNINGS_AAPL[0], symbol: 'WRONG' }] } })
		const provider = await importProvider()

		const results = await earnings(provider, { symbol: 'aapl' })

		expect(fx.query(EARNINGS_MATCH).symbol).toBe('AAPL')
		expect(results[0].symbol).toBe('AAPL')
	})

	it('returns an empty array for a null body', async () => {
		mount({ earnings: { json: null } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results).toEqual([])
	})

	it('returns an empty array when Finnhub knows of no earnings', async () => {
		mount({ earnings: { json: [] } })
		const provider = await importProvider()

		const results = await earnings(provider)

		expect(results).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ earnings: { json: EARNINGS_AAPL } })
		const provider = await importProvider()

		const result = await provider.execute<EarningsData[]>('earnings', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('finnhub')
		expect(result.cached).toBe(false)
	})

	it('issues exactly one request', async () => {
		const fx = mount({ earnings: { json: EARNINGS_AAPL } })
		const provider = await importProvider()

		await earnings(provider)

		expect(fx.callCount()).toBe(1)
	})

	it('surfaces a raw TypeError when the body is an object rather than an array', async () => {
		// NOTE: suspected bug — `(data ?? []).map` assumes an array, so an error envelope
		// like `{"error":"..."}` served with a 200 escapes as a TypeError.
		mount({ earnings: { json: { error: 'You do not have access to this resource.' } } })
		const provider = await importProvider()

		await expect(earnings(provider)).rejects.toThrow(TypeError)
	})
})

describe('history/get window', () => {
	it('spans exactly 30 days back from now by default', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider)

		expect(fx.query(CANDLE_MATCH)).toEqual({
			symbol: 'AAPL',
			resolution: 'D',
			from: '1715860800',
			to: '1718452800',
			token: API_KEY,
		})
	})

	it('ends the window at the current second', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider)

		expect(Number(fx.query(CANDLE_MATCH).to)).toBe(NOW_UNIX)
	})

	it('floors a sub-second clock to whole UNIX seconds', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00.750Z'))

		await history(provider)

		expect(fx.query(CANDLE_MATCH).to).toBe('1718452800')
	})

	it('always asks for daily resolution', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: 5, resolution: '60' })

		expect(fx.query(CANDLE_MATCH).resolution).toBe('D')
	})

	it('honours an explicit seven day window', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: 7 })

		expect(fx.query(CANDLE_MATCH).from).toBe('1717848000')
		expect(fx.query(CANDLE_MATCH).to).toBe('1718452800')
	})

	it('honours a one day window', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: 1 })

		expect(fx.query(CANDLE_MATCH).from).toBe('1718366400')
	})

	it('honours a one year window', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: 365 })

		expect(fx.query(CANDLE_MATCH).from).toBe('1686916800')
	})

	it('defaults to 30 days when days is null', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: null })

		expect(fx.query(CANDLE_MATCH).from).toBe('1715860800')
	})

	it('defaults to 30 days when days is undefined', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: undefined })

		expect(fx.query(CANDLE_MATCH).from).toBe('1715860800')
	})

	it('requests an empty window for days = 0 instead of defaulting', async () => {
		// NOTE: suspected bug — `(args.days as number) ?? 30` only defaults on null/undefined,
		// so `--days 0` asks Finnhub for a zero-width window.
		const fx = mount({ candle: { json: { ...CANDLES_AAPL, s: 'no_data' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider, { symbol: 'AAPL', days: 0 })).rejects.toThrow('no_data')

		expect(fx.query(CANDLE_MATCH).from).toBe('1718452800')
		expect(fx.query(CANDLE_MATCH).to).toBe('1718452800')
	})

	it('sends from=NaN when the CLI could not parse --days', async () => {
		// NOTE: same root cause — `NaN ?? 30` is NaN, so a typo like `--days abc` reaches
		// Finnhub as the literal string "NaN" instead of being rejected locally.
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: Number.NaN })

		expect(fx.query(CANDLE_MATCH).from).toBe('NaN')
	})

	it('sends a from later than to for a negative days value', async () => {
		// NOTE: same root cause — a negative window is never rejected, it just inverts.
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'AAPL', days: -7 })

		expect(fx.query(CANDLE_MATCH).from).toBe('1719057600')
	})

	it('upper-cases and encodes the symbol', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider, { symbol: 'brk.b' })

		expect(fx.query(CANDLE_MATCH).symbol).toBe('BRK.B')
	})
})

describe('history/get mapping', () => {
	it('maps t/o/h/l/c/v onto HistoricalQuote rows', async () => {
		mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows).toEqual(CANDLE_ROWS)
	})

	it('keeps the candles in the order Finnhub sent them', async () => {
		mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows.map((r) => r.date)).toEqual([
			'2024-06-10',
			'2024-06-11',
			'2024-06-12',
			'2024-06-13',
			'2024-06-14',
		])
	})

	it('renders the date in UTC, so the ambient timezone cannot shift it', async () => {
		// Run the mapping west of Greenwich: 2024-06-15T00:00:00Z is still the 14th in New
		// York, so a local-time formatter would collapse both candles onto 2024-06-14.
		setTimeZone('America/New_York')
		mount({
			candle: {
				json: {
					c: [1, 2],
					h: [1, 2],
					l: [1, 2],
					o: [1, 2],
					s: 'ok',
					// One second before, and exactly at, midnight UTC on 2024-06-15.
					t: [1_718_409_599, 1_718_409_600],
					v: [10, 20],
				},
			},
		})
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows.map((r) => r.date)).toEqual(['2024-06-14', '2024-06-15'])
	})

	it('renders the UNIX epoch as 1970-01-01', async () => {
		mount({
			candle: { json: { c: [1], h: [1], l: [1], o: [1], s: 'ok', t: [0], v: [0] } },
		})
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows[0].date).toBe('1970-01-01')
	})

	it('leaves out the adjusted close, which Finnhub candles do not carry', async () => {
		mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(Object.keys(rows[0]).sort()).toEqual(['close', 'date', 'high', 'low', 'open', 'volume'])
	})

	it('returns an empty array for an ok response with no candles', async () => {
		mount({ candle: { json: { c: [], h: [], l: [], o: [], s: 'ok', t: [], v: [] } } })
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		const result = await provider.execute<HistoricalQuote[]>('history', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('finnhub')
		expect(result.cached).toBe(false)
	})

	it('issues exactly one request', async () => {
		const fx = mount({ candle: { json: CANDLES_AAPL } })
		const provider = await importProvider()
		pinClock()

		await history(provider)

		expect(fx.callCount()).toBe(1)
	})

	it('fills undefined for series shorter than the timestamp array', async () => {
		// NOTE: suspected bug — the map is driven by `data.t` with no length check, so a
		// ragged payload silently yields rows whose OHLCV fields are undefined.
		mount({
			candle: {
				json: {
					c: [1],
					h: [2],
					l: [0.5],
					o: [1],
					s: 'ok',
					t: [1_718_323_200, 1_718_409_600],
					v: [5],
				},
			},
		})
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows).toHaveLength(2)
		expect(rows[1]).toEqual({
			date: '2024-06-15',
			open: undefined,
			high: undefined,
			low: undefined,
			close: undefined,
			volume: undefined,
		})
	})

	it('ignores series longer than the timestamp array', async () => {
		mount({
			candle: {
				json: { c: [1, 2, 3], h: [1], l: [1], o: [1], s: 'ok', t: [1_718_323_200], v: [5] },
			},
		})
		const provider = await importProvider()
		pinClock()

		const rows = await history(provider)

		expect(rows).toHaveLength(1)
	})

	it('surfaces a raw TypeError when an ok response has no timestamps', async () => {
		// NOTE: suspected bug — `data.t.map` is called without a guard.
		mount({ candle: { json: { s: 'ok' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider)).rejects.toThrow(TypeError)
	})
})

describe('history/get status handling', () => {
	it('explains that no_data may mean the endpoint needs a paid plan', async () => {
		mount({ candle: { json: { s: 'no_data' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider, { symbol: 'AAPL' })).rejects.toThrow(
			'[finnhub] Candle data not available for "AAPL" (status: no_data). This endpoint may require a paid plan.',
		)
	})

	it('names an arbitrary upstream status in the error', async () => {
		mount({ candle: { json: { s: 'error' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider, { symbol: 'AAPL' })).rejects.toThrow('(status: error)')
	})

	it('reports an absent status as undefined', async () => {
		mount({ candle: { json: { c: [], t: [] } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider)).rejects.toThrow('(status: undefined)')
	})

	it('compares the status case-sensitively', async () => {
		mount({ candle: { json: { ...CANDLES_AAPL, s: 'OK' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider)).rejects.toThrow('(status: OK)')
	})

	it('names the symbol exactly as the caller typed it', async () => {
		mount({ candle: { json: { s: 'no_data' } } })
		const provider = await importProvider()
		pinClock()

		await expect(history(provider, { symbol: 'aapl' })).rejects.toThrow(
			'Candle data not available for "aapl"',
		)
	})
})

describe('argument validation', () => {
	it('rejects search without a query', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('search', 'search', {})).rejects.toThrow(
			'[finnhub] search requires query',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string query', async () => {
		const provider = await importProvider()

		await expect(search(provider, { query: '' })).rejects.toThrow('[finnhub] search requires query')
	})

	it('rejects an undefined query', async () => {
		const provider = await importProvider()

		await expect(search(provider, { query: undefined })).rejects.toThrow('search requires query')
	})

	it('rejects quote without a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', {})).rejects.toThrow(
			'[finnhub] quote requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol for quote', async () => {
		const provider = await importProvider()

		await expect(quote(provider, { symbol: '' })).rejects.toThrow('[finnhub] quote requires symbol')
	})

	it('rejects earnings without a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('earnings', 'get', {})).rejects.toThrow(
			'[finnhub] earnings requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol for earnings', async () => {
		const provider = await importProvider()

		await expect(earnings(provider, { symbol: '' })).rejects.toThrow(
			'[finnhub] earnings requires symbol',
		)
	})

	it('rejects history without a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('history', 'get', {})).rejects.toThrow(
			'[finnhub] history requires symbol',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string symbol for history', async () => {
		const provider = await importProvider()

		await expect(history(provider, { symbol: '' })).rejects.toThrow(
			'[finnhub] history requires symbol',
		)
	})

	it('checks the argument before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', {})).rejects.toThrow('quote requires symbol')
	})
})

describe('action dispatch', () => {
	it('rejects a category it does not serve', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', { seriesId: 'GDP' })).rejects.toThrow(
			'[finnhub] Unsupported operation: macro/get',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an unknown action inside a supported category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'batch', { symbol: 'AAPL' })).rejects.toThrow(
			'[finnhub] Unsupported operation: quote/batch',
		)
	})

	it('rejects the search action under the wrong category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'search', { query: 'apple' })).rejects.toThrow(
			'[finnhub] Unsupported operation: quote/search',
		)
	})

	it('rejects the get action under the search category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('search', 'get', { query: 'apple' })).rejects.toThrow(
			'[finnhub] Unsupported operation: search/get',
		)
	})

	it('rejects an empty action', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', '', {})).rejects.toThrow(
			'[finnhub] Unsupported operation: quote/',
		)
	})

	it('matches actions case-sensitively', async () => {
		const provider = await importProvider()

		await expect(provider.execute('quote', 'GET', { symbol: 'AAPL' })).rejects.toThrow(
			'[finnhub] Unsupported operation: quote/GET',
		)
	})

	it('rejects the filing category it has no implementation for', async () => {
		const provider = await importProvider()

		await expect(provider.execute('filing', 'list', { symbol: 'AAPL' })).rejects.toThrow(
			'[finnhub] Unsupported operation: filing/list',
		)
	})

	it('reports the unsupported route even when no key is configured', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'quote', { symbol: 'BTC' })).rejects.toThrow(
			'[finnhub] Unsupported operation: crypto/quote',
		)
	})

	it('never issues a request for an unsupported route', async () => {
		const fx = mount({ quote: { json: QUOTE_AAPL } })
		const provider = await importProvider()

		await expect(provider.execute('quote', 'stream', { symbol: 'AAPL' })).rejects.toThrow(
			'Unsupported operation',
		)

		expect(fx.callCount()).toBe(0)
	})
})
