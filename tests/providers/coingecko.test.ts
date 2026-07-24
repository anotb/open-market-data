import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type { CryptoCandle, CryptoQuote, SearchResult } from '../../src/types.js'
import {
	type FetchMock,
	type Responder,
	type Route,
	expectNoUnmatched,
	mockFetch,
} from '../helpers/mock-fetch.js'
import { type TempHome, clearConfigEnv, freshImport, makeTempHome } from '../helpers/modules.js'

/**
 * src/providers/coingecko.ts reads its API key through `core/config.ts`, which
 * memoizes the resolved config, and spends `core/rate-limiter.ts` tokens from a
 * module-scope bucket. Both must be pristine per test, so every test pulls the
 * provider through `freshImport` — that yields a fresh config cache and a fresh
 * token bucket in the same module generation.
 *
 * $HOME points at a throwaway directory and the cwd at an empty one, so the
 * config layer can never read the developer's real config or a repo `.env`.
 * Nothing here touches the network; the two tests that care about the token
 * bucket pin the clock so no refill can sneak in.
 */

type CoingeckoModule = typeof import('../../src/providers/coingecko.js')

const BASE_URL = 'https://api.coingecko.com/api/v3'

const PRICE_MATCH = '/simple/price'
const MARKETS_MATCH = '/coins/markets'
const OHLC_MATCH = '/ohlc'
const CHART_MATCH = '/market_chart'
const TRENDING_MATCH = '/search/trending'
const GLOBAL_MATCH = '/global'
const SEARCH_MATCH = '/search?'

const API_KEY = 'CG-demo-key-123'
const KEY_HEADER = 'x-cg-demo-api-key'

const HOUR = 3_600_000
/** 2024-06-15T12:00:00.000Z — lands exactly on an hour boundary. */
const T0 = 1_718_452_800_000

// --- Fixtures (shaped like real CoinGecko payloads, trimmed) ----------------

/** GET /simple/price?ids=bitcoin&vs_currencies=usd&... */
const BITCOIN_PRICE = {
	bitcoin: {
		usd: 50000,
		usd_24h_vol: 28_450_000_000,
		usd_24h_change: 2,
		usd_market_cap: 985_000_000_000,
	},
}

/** GET /coins/markets?vs_currency=usd&order=market_cap_desc&... */
const MARKETS = [
	{
		id: 'bitcoin',
		symbol: 'btc',
		name: 'Bitcoin',
		image: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
		current_price: 67234,
		market_cap: 1_327_000_000_000,
		market_cap_rank: 1,
		total_volume: 28_450_000_000,
		high_24h: 68120,
		low_24h: 66540,
		price_change_24h: 812.5,
		price_change_percentage_24h: 1.2234,
		circulating_supply: 19_720_000,
		ath: 73738,
	},
	{
		id: 'newcoin',
		symbol: 'new',
		name: 'Freshly Listed',
		image: 'https://assets.coingecko.com/coins/images/2/large/new.png',
		current_price: 0.42,
		market_cap: 12_000_000,
		market_cap_rank: 987,
		total_volume: 350_000,
		high_24h: null,
		low_24h: null,
		price_change_24h: null,
		price_change_percentage_24h: null,
		circulating_supply: null,
		ath: null,
	},
]

/** GET /coins/bitcoin/ohlc?vs_currency=usd&days=30 */
const OHLC: [number, number, number, number, number][] = [
	[T0, 66000, 67000, 65500, 66800],
	[T0 + 4 * HOUR, 66800, 67500, 66700, 67200],
]

/** GET /coins/bitcoin/market_chart?vs_currency=usd&days=30 */
const CHART = {
	prices: [
		[T0, 66000],
		[T0 + 4 * HOUR, 66800],
	],
	total_volumes: [
		[T0, 28_450_000_000],
		[T0 + 4 * HOUR, 29_100_000_000],
	],
}

/** GET /search/trending */
const TRENDING = {
	coins: [
		{
			item: {
				id: 'pepe',
				coin_id: 29850,
				name: 'Pepe',
				symbol: 'pepe',
				market_cap_rank: 24,
				thumb: 'https://assets.coingecko.com/coins/images/29850/thumb/pepe.png',
				price_btc: 1.7e-10,
				data: {
					price: 0.0000112,
					price_change_percentage_24h: { usd: 8.42, eur: 7.9 },
					market_cap: '$4,712,000,000',
					total_volume: '$1,204,000,000',
				},
			},
		},
		{
			item: {
				id: 'obscure-token',
				coin_id: 51234,
				name: 'Obscure Token',
				symbol: 'obs',
				market_cap_rank: null,
				thumb: 'https://assets.coingecko.com/coins/images/51234/thumb/obs.png',
				price_btc: 0,
			},
		},
	],
}

/** GET /global */
const GLOBAL = {
	data: {
		active_cryptocurrencies: 14203,
		upcoming_icos: 0,
		ongoing_icos: 49,
		markets: 1123,
		total_market_cap: { btc: 36_000_000, usd: 2_410_000_000_000 },
		total_volume: { btc: 1_200_000, usd: 82_000_000_000 },
		market_cap_percentage: { btc: 54.2, eth: 16.1 },
		market_cap_change_percentage_24h_usd: -1.234,
		updated_at: 1_718_452_800,
	},
}

/** GET /search?query=pepe */
const SEARCH_RESPONSE = {
	coins: [
		{
			id: 'pepe',
			name: 'Pepe',
			api_symbol: 'pepe',
			symbol: 'PEPE',
			market_cap_rank: 24,
			thumb: 'https://assets.coingecko.com/coins/images/29850/thumb/pepe.png',
		},
		{
			id: 'pepe-2-0',
			name: 'Pepe 2.0',
			api_symbol: 'pepe-2-0',
			symbol: 'PEPE2.0',
			market_cap_rank: null,
			thumb: 'https://assets.coingecko.com/coins/images/30000/thumb/pepe2.png',
		},
	],
	exchanges: [{ id: 'pepe-exchange', name: 'Pepe Exchange', market_type: 'spot' }],
	categories: [{ id: 1, name: 'Meme' }],
}

interface GlobalPayload {
	active_cryptocurrencies: number
	markets: number
	total_market_cap: Record<string, number>
	total_volume: Record<string, number>
	market_cap_percentage: Record<string, number>
	market_cap_change_percentage_24h_usd: number
}

// --- Per-test environment ---------------------------------------------------

let home: TempHome
let cwdDir: string
let restoreEnv: () => void
const originalCwd = process.cwd()

beforeEach(() => {
	restoreEnv = clearConfigEnv()
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-coingecko-cwd-'))
	process.chdir(cwdDir)
	process.env.COINGECKO_API_KEY = API_KEY
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
	const mod = await freshImport<CoingeckoModule>('../../src/providers/coingecko.js')
	return mod.coingecko
}

interface MountOptions {
	price?: Responder
	markets?: Responder
	ohlc?: Responder
	chart?: Responder
	trending?: Responder
	global?: Responder
	search?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = []
	if (options.price) routes.push({ match: PRICE_MATCH, respond: options.price })
	if (options.markets) routes.push({ match: MARKETS_MATCH, respond: options.markets })
	if (options.ohlc) routes.push({ match: OHLC_MATCH, respond: options.ohlc })
	if (options.chart) routes.push({ match: CHART_MATCH, respond: options.chart })
	if (options.trending) routes.push({ match: TRENDING_MATCH, respond: options.trending })
	if (options.global) routes.push({ match: GLOBAL_MATCH, respond: options.global })
	if (options.search) routes.push({ match: SEARCH_MATCH, respond: options.search })
	return mockFetch(routes)
}

/** Echoes back whatever coin id the provider asked for, priced at $1. */
const echoPrice: Responder = (ctx) => ({
	json: { [ctx.parsed.searchParams.get('ids') ?? '']: { usd: 1 } },
})

/** Removes the key env var (biome forbids the `delete` operator). */
function unsetApiKey(): void {
	Reflect.deleteProperty(process.env, 'COINGECKO_API_KEY')
}

function writeKeyConfig(key: string): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify({ coingeckoApiKey: key }, null, 2))
}

async function getQuote(provider: Provider, symbol: unknown = 'BTC'): Promise<CryptoQuote> {
	const result = await provider.execute<CryptoQuote>('crypto', 'quote', { symbol })
	return result.data
}

async function getTop(
	provider: Provider,
	args: Record<string, unknown> = {},
): Promise<CryptoQuote[]> {
	const result = await provider.execute<CryptoQuote[]>('crypto', 'top', args)
	return result.data
}

async function getHistory(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'BTC' },
): Promise<CryptoCandle[]> {
	const result = await provider.execute<CryptoCandle[]>('crypto', 'history', args)
	return result.data
}

async function getTrending(provider: Provider): Promise<CryptoQuote[]> {
	const result = await provider.execute<CryptoQuote[]>('crypto', 'trending', {})
	return result.data
}

async function search(provider: Provider, query: unknown): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', { query })
	return result.data
}

describe('provider metadata', () => {
	it('identifies itself as coingecko and demands a key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('coingecko')
		expect(provider.requiresKey).toBe(true)
		expect(provider.keyEnvVar).toBe('COINGECKO_API_KEY')
	})

	it('advertises the crypto and search categories with their priorities', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['crypto', 'search'])
		expect(provider.priority).toEqual({ crypto: 2, search: 4 })
	})

	it('advertises the demo-plan limit of 30 requests per minute', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 30, windowMs: 60_000 })
	})
})

describe('isEnabled', () => {
	it('is enabled when COINGECKO_API_KEY is set', async () => {
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
		writeKeyConfig('CG-file-key')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})

	it('is disabled when the env var is an empty string', async () => {
		process.env.COINGECKO_API_KEY = ''
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
		process.env.FRED_API_KEY = 'fred-key'
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})
})

describe('authentication', () => {
	it('sends the configured key in the x-cg-demo-api-key header', async () => {
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await getTrending(provider)

		expect(fx.call()?.headers[KEY_HEADER]).toBe(API_KEY)
	})

	it('prefers the environment key over the config file', async () => {
		writeKeyConfig('CG-file-key')
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await getTrending(provider)

		expect(fx.call()?.headers[KEY_HEADER]).toBe(API_KEY)
	})

	it('falls back to the config file key', async () => {
		unsetApiKey()
		writeKeyConfig('CG-file-key')
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await getTrending(provider)

		expect(fx.call()?.headers[KEY_HEADER]).toBe('CG-file-key')
	})

	it('throws a configuration hint when no key is available', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow(
			'CoinGecko API key not configured. Set COINGECKO_API_KEY or run: omd config set coingeckoApiKey <key>',
		)
	})

	it('never issues a request when the key is missing', async () => {
		unsetApiKey()
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow('API key not configured')

		expect(fx.callCount()).toBe(0)
	})

	it('checks the key on every action, including ones that resolve a coin id first', async () => {
		unsetApiKey()
		const fx = mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('API key not configured')

		expect(fx.callCount()).toBe(0)
	})
})

describe('request plumbing', () => {
	it('targets the public v3 base url', async () => {
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await getTrending(provider)

		expect(fx.urls()).toEqual([`${BASE_URL}/search/trending`])
	})

	it('surfaces the status and body of a non-OK response', async () => {
		mount({ trending: { status: 429, text: '{"status":{"error_code":429}}' } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow(
			'CoinGecko API error 429: {"status":{"error_code":429}}',
		)
	})

	it('reports a 401 with the upstream body verbatim', async () => {
		mount({ trending: { status: 401, text: 'invalid api key' } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow('CoinGecko API error 401: invalid api key')
	})

	it('reports an empty body as a trailing colon', async () => {
		mount({ trending: { status: 503 } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow('CoinGecko API error 503: ')
	})

	it('treats a 204 as success rather than an error', async () => {
		// NOTE: suspected bug — `res.ok` is true for 204, so the empty body reaches
		// `res.json()` and surfaces as a raw SyntaxError instead of a provider error.
		mount({ trending: { status: 204 } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow(SyntaxError)
	})

	it('propagates a network-level rejection untouched', async () => {
		mount({ trending: { throw: new Error('ECONNREFUSED') } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow('ECONNREFUSED')
	})

	it('rejects malformed JSON from an OK response', async () => {
		mount({ trending: { text: 'not json at all' } })
		const provider = await importProvider()

		await expect(getTrending(provider)).rejects.toThrow(SyntaxError)
	})
})

describe('rate limiting', () => {
	it('allows exactly thirty requests before the bucket runs dry', async () => {
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		for (let i = 0; i < 30; i++) {
			await getTrending(provider)
		}

		await expect(getTrending(provider)).rejects.toThrow('CoinGecko rate limit exceeded')
		expect(fx.callCount()).toBe(30)
	})

	it('spends two tokens on a quote that has to resolve the coin id', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE }, price: echoPrice })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		for (let i = 0; i < 15; i++) {
			await getQuote(provider, 'PEPE')
		}

		await expect(getQuote(provider, 'PEPE')).rejects.toThrow('CoinGecko rate limit exceeded')
		expect(fx.callCount()).toBe(30)
	})

	it('burns rate-limit tokens even when the key is missing', async () => {
		// NOTE: suspected bug — `request()` consumes a token before `getApiKey()`, so an
		// unconfigured install exhausts its 30/min budget on requests never sent, and the
		// user then sees a misleading "rate limit exceeded" instead of the setup hint.
		unsetApiKey()
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		for (let i = 0; i < 30; i++) {
			await expect(getTrending(provider)).rejects.toThrow('API key not configured')
		}

		await expect(getTrending(provider)).rejects.toThrow('CoinGecko rate limit exceeded')
		expect(fx.callCount()).toBe(0)
	})

	it('gives every module generation a fresh bucket', async () => {
		mount({ trending: { json: TRENDING } })
		const first = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		for (let i = 0; i < 30; i++) {
			await getTrending(first)
		}
		await expect(getTrending(first)).rejects.toThrow('rate limit exceeded')

		const second = await importProvider()
		await expect(getTrending(second)).resolves.toBeDefined()
	})
})

describe('resolveCoinId', () => {
	const SYMBOL_MAP: [string, string][] = [
		['BTC', 'bitcoin'],
		['ETH', 'ethereum'],
		['SOL', 'solana'],
		['BNB', 'binancecoin'],
		['XRP', 'ripple'],
		['ADA', 'cardano'],
		['DOGE', 'dogecoin'],
		['DOT', 'polkadot'],
		['AVAX', 'avalanche-2'],
		['MATIC', 'matic-network'],
		['LINK', 'chainlink'],
		['UNI', 'uniswap'],
		['ATOM', 'cosmos'],
		['LTC', 'litecoin'],
	]

	it.each(SYMBOL_MAP)('maps %s to %s without hitting /search', async (symbol, id) => {
		const fx = mount({ price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, symbol)

		expect(fx.query(PRICE_MATCH).ids).toBe(id)
		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('uppercases the lookup so lowercase symbols hit the built-in map', async () => {
		const fx = mount({ price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'btc')

		expect(fx.query(PRICE_MATCH).ids).toBe('bitcoin')
		expect(fx.callCount()).toBe(1)
	})

	it('handles mixed case symbols too', async () => {
		const fx = mount({ price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'AvAx')

		expect(fx.query(PRICE_MATCH).ids).toBe('avalanche-2')
	})

	it('falls back to /search for an unmapped symbol', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE }, price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'PEPE')

		expect(fx.urls(SEARCH_MATCH)).toEqual([`${BASE_URL}/search?query=PEPE`])
		expect(fx.query(PRICE_MATCH).ids).toBe('pepe')
	})

	it('takes the first coin of the search result', async () => {
		const fx = mount({
			search: {
				json: {
					coins: [
						{ id: 'pepe-2-0', name: 'Pepe 2.0', symbol: 'PEPE2.0', market_cap_rank: null },
						{ id: 'pepe', name: 'Pepe', symbol: 'PEPE', market_cap_rank: 24 },
					],
				},
			},
			price: echoPrice,
		})
		const provider = await importProvider()

		await getQuote(provider, 'PEPE')

		expect(fx.query(PRICE_MATCH).ids).toBe('pepe-2-0')
	})

	it('accepts the first coin even when its symbol does not match the request', async () => {
		// NOTE: suspected bug — /search ranks by name relevance, so an unmapped symbol can
		// resolve to a completely different asset. The quote is then labelled with the
		// requested symbol while carrying the wrong coin's price.
		const fx = mount({
			search: {
				json: {
					coins: [{ id: 'pepe-cash', name: 'Pepe Cash', symbol: 'PEPECASH', market_cap_rank: 900 }],
				},
			},
			price: { json: { 'pepe-cash': { usd: 0.0004 } } },
		})
		const provider = await importProvider()

		const quote = await getQuote(provider, 'PEPE')

		expect(fx.query(PRICE_MATCH).ids).toBe('pepe-cash')
		expect(quote).toMatchObject({ symbol: 'PEPE', price: 0.0004 })
	})

	it('queries /search with the symbol as typed, not uppercased', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE }, price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'pepe')

		expect(fx.query(SEARCH_MATCH).query).toBe('pepe')
	})

	it('url-encodes a symbol containing spaces and specials', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE }, price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'shiba inu&co')

		expect(fx.urls(SEARCH_MATCH)).toEqual([`${BASE_URL}/search?query=shiba%20inu%26co`])
		expect(fx.query(SEARCH_MATCH).query).toBe('shiba inu&co')
	})

	it('throws when the search returns no coins', async () => {
		mount({ search: { json: { coins: [], exchanges: [], categories: [] } } })
		const provider = await importProvider()

		await expect(getQuote(provider, 'NOTACOIN')).rejects.toThrow(
			'CoinGecko: could not resolve coin ID for symbol "NOTACOIN"',
		)
	})

	it('quotes the symbol as typed in the resolution error', async () => {
		mount({ search: { json: { coins: [] } } })
		const provider = await importProvider()

		await expect(getQuote(provider, 'notacoin')).rejects.toThrow(
			'could not resolve coin ID for symbol "notacoin"',
		)
	})

	it('never asks for a price when resolution fails', async () => {
		const fx = mount({ search: { json: { coins: [] } }, price: echoPrice })
		const provider = await importProvider()

		await expect(getQuote(provider, 'NOTACOIN')).rejects.toThrow('could not resolve coin ID')

		expect(fx.callCount(PRICE_MATCH)).toBe(0)
	})

	it('throws a TypeError when the search payload has no coins array', async () => {
		// NOTE: suspected bug — `data.coins.length` is read without a guard, so a
		// truncated payload surfaces as a raw TypeError instead of a provider error.
		mount({ search: { json: { exchanges: [], categories: [] } } })
		const provider = await importProvider()

		await expect(getQuote(provider, 'PEPE')).rejects.toThrow(TypeError)
	})

	it('throws a TypeError when no symbol is supplied at all', async () => {
		// NOTE: suspected bug — other providers reject a missing symbol with a helpful
		// message; here `symbol.toUpperCase()` throws before any validation runs.
		const fx = mount({ price: echoPrice })
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'quote', {})).rejects.toThrow(TypeError)
		expect(fx.callCount()).toBe(0)
	})
})

describe('crypto/quote', () => {
	it('maps a full simple/price entry onto a CryptoQuote', async () => {
		mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote).toEqual({
			symbol: 'BTC',
			price: 50000,
			change24h: 1000,
			changePercent24h: 2,
			volume24h: 28_450_000_000,
			marketCap: 985_000_000_000,
			source: 'coingecko',
		})
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		const result = await provider.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })

		expect(result.source).toBe('coingecko')
		expect(result.cached).toBe(false)
	})

	it('asks for change, volume and market cap in one call', async () => {
		const fx = mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.query(PRICE_MATCH)).toEqual({
			ids: 'bitcoin',
			vs_currencies: 'usd',
			include_24hr_change: 'true',
			include_24hr_vol: 'true',
			include_market_cap: 'true',
		})
	})

	it('derives change24h as price times percent over one hundred', async () => {
		mount({ price: { json: { bitcoin: { usd: 50000, usd_24h_change: 2 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.change24h).toBeCloseTo(1000, 9)
		expect(quote.changePercent24h).toBe(2)
	})

	it('derives a negative change from a negative percent', async () => {
		mount({ price: { json: { ethereum: { usd: 3000, usd_24h_change: -4.5 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider, 'ETH')

		expect(quote.change24h).toBeCloseTo(-135, 9)
		expect(quote.changePercent24h).toBe(-4.5)
	})

	it('derives a fractional change for a sub-cent coin', async () => {
		mount({ price: { json: { dogecoin: { usd: 0.16, usd_24h_change: 12.5 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider, 'DOGE')

		expect(quote.change24h).toBeCloseTo(0.02, 12)
	})

	it('keeps a flat market at exactly zero rather than undefined', async () => {
		mount({ price: { json: { bitcoin: { usd: 50000, usd_24h_change: 0 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.change24h).toBe(0)
		expect(quote.changePercent24h).toBe(0)
	})

	it('leaves change24h undefined — never NaN — when the percent is absent', async () => {
		mount({ price: { json: { bitcoin: { usd: 50000, usd_24h_vol: 1 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		// `toBeUndefined` is what rules NaN out: an unguarded `price * (pct / 100)`
		// would land here as NaN, which is not undefined.
		expect(quote.change24h).toBeUndefined()
		expect(quote.changePercent24h).toBeUndefined()
		// The rest of the quote is still mapped, so the guard is scoped to change24h.
		expect(quote.price).toBe(50000)
		expect(quote.volume24h).toBe(1)
	})

	it('treats a null percent as absent', async () => {
		mount({ price: { json: { bitcoin: { usd: 50000, usd_24h_change: null } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.change24h).toBeUndefined()
		expect(quote.changePercent24h).toBeNull()
	})

	it('leaves volume and market cap undefined when the payload omits them', async () => {
		mount({ price: { json: { bitcoin: { usd: 50000 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.volume24h).toBeUndefined()
		expect(quote.marketCap).toBeUndefined()
		expect(quote.price).toBe(50000)
	})

	it('uppercases the requested symbol in the result', async () => {
		mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		const quote = await getQuote(provider, 'btc')

		expect(quote.symbol).toBe('BTC')
	})

	it('labels the quote with the requested symbol, not the coin id', async () => {
		mount({ search: { json: SEARCH_RESPONSE }, price: { json: { pepe: { usd: 0.0000112 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider, 'pepe')

		expect(quote.symbol).toBe('PEPE')
	})

	it('throws when the response does not carry the requested coin id', async () => {
		mount({ price: { json: {} } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('CoinGecko: no price data for "bitcoin"')
	})

	it('names the coin id, not the symbol, in the no-price-data error', async () => {
		mount({ price: { json: { BTC: { usd: 50000 } } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('no price data for "bitcoin"')
	})

	it('throws when the coin key is present but null', async () => {
		mount({ price: { json: { bitcoin: null } } })
		const provider = await importProvider()

		await expect(getQuote(provider)).rejects.toThrow('no price data for "bitcoin"')
	})

	it('returns an undefined price when the entry has no usd field', async () => {
		// NOTE: suspected bug — only the coin key is validated, so a coin with no USD
		// market yields `price: undefined` behind a `price: number` type, which blows up
		// in the formatter downstream.
		mount({ price: { json: { bitcoin: { usd_24h_vol: 1 } } } })
		const provider = await importProvider()

		const quote = await getQuote(provider)

		expect(quote.price).toBeUndefined()
		expect(quote.change24h).toBeUndefined()
	})

	it('issues exactly one request for a mapped symbol', async () => {
		const fx = mount({ price: { json: BITCOIN_PRICE } })
		const provider = await importProvider()

		await getQuote(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('issues two requests for an unmapped symbol', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE }, price: echoPrice })
		const provider = await importProvider()

		await getQuote(provider, 'PEPE')

		expect(fx.callCount()).toBe(2)
		expect(fx.urls().map((u) => u.split('?')[0])).toEqual([
			`${BASE_URL}/search`,
			`${BASE_URL}/simple/price`,
		])
	})
})

describe('crypto/top', () => {
	it('maps every market field onto a CryptoQuote', async () => {
		mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes[0]).toEqual({
			symbol: 'BTC',
			name: 'Bitcoin',
			price: 67234,
			change24h: 812.5,
			changePercent24h: 1.2234,
			volume24h: 28_450_000_000,
			marketCap: 1_327_000_000_000,
			marketCapRank: 1,
			high24h: 68120,
			low24h: 66540,
			circulatingSupply: 19_720_000,
			ath: 73738,
			source: 'coingecko',
		})
	})

	it('converts every nullable field to undefined', async () => {
		mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes[1]).toEqual({
			symbol: 'NEW',
			name: 'Freshly Listed',
			price: 0.42,
			change24h: undefined,
			changePercent24h: undefined,
			volume24h: 350_000,
			marketCap: 12_000_000,
			marketCapRank: 987,
			high24h: undefined,
			low24h: undefined,
			circulatingSupply: undefined,
			ath: undefined,
			source: 'coingecko',
		})
	})

	it('keeps a zero-valued field instead of dropping it', async () => {
		mount({
			markets: {
				json: [
					{
						id: 'zerocoin',
						symbol: 'zero',
						name: 'Zero Coin',
						current_price: 0,
						market_cap: 0,
						market_cap_rank: 5000,
						total_volume: 0,
						high_24h: 0,
						low_24h: 0,
						price_change_24h: 0,
						price_change_percentage_24h: 0,
						circulating_supply: 0,
						ath: 0,
					},
				],
			},
		})
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes[0]).toMatchObject({
			price: 0,
			change24h: 0,
			changePercent24h: 0,
			high24h: 0,
			low24h: 0,
			circulatingSupply: 0,
			ath: 0,
		})
	})

	it('lets a null market cap rank through as null', async () => {
		// NOTE: suspected bug — every other nullable field is normalised with
		// `?? undefined`, but market_cap_rank is not, so an unranked coin puts `null`
		// into a `marketCapRank?: number` field.
		mount({
			markets: {
				json: [
					{
						id: 'unranked',
						symbol: 'unr',
						name: 'Unranked',
						current_price: 1,
						market_cap: 0,
						market_cap_rank: null,
						total_volume: 0,
						high_24h: null,
						low_24h: null,
						price_change_24h: null,
						price_change_percentage_24h: null,
						circulating_supply: null,
						ath: null,
					},
				],
			},
		})
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes[0].marketCapRank).toBeNull()
	})

	it('uppercases the coingecko lowercase symbols', async () => {
		mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes.map((q) => q.symbol)).toEqual(['BTC', 'NEW'])
	})

	it('preserves the market-cap ordering of the feed', async () => {
		mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes.map((q) => q.marketCapRank)).toEqual([1, 987])
	})

	it('passes the requested limit as per_page', async () => {
		const fx = mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		await getTop(provider, { limit: 50 })

		expect(fx.query(MARKETS_MATCH)).toEqual({
			vs_currency: 'usd',
			order: 'market_cap_desc',
			per_page: '50',
			sparkline: 'false',
		})
	})

	it('defaults to ten per page when no limit is given', async () => {
		const fx = mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		await getTop(provider)

		expect(fx.query(MARKETS_MATCH).per_page).toBe('10')
	})

	it('defaults to ten per page when the limit is explicitly undefined', async () => {
		const fx = mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		await getTop(provider, { limit: undefined })

		expect(fx.query(MARKETS_MATCH).per_page).toBe('10')
	})

	it('sends per_page=0 for a limit of zero', async () => {
		// NOTE: suspected bug — the `limit = 10` default only fires for `undefined`, so a
		// zero limit asks CoinGecko for an empty page instead of falling back.
		const fx = mount({ markets: { json: [] } })
		const provider = await importProvider()

		const quotes = await getTop(provider, { limit: 0 })

		expect(fx.query(MARKETS_MATCH).per_page).toBe('0')
		expect(quotes).toEqual([])
	})

	it('sends per_page=null for a null limit', async () => {
		// NOTE: same defaulting gap — `null` is not `undefined`, so it is interpolated
		// straight into the query string.
		const fx = mount({ markets: { json: [] } })
		const provider = await importProvider()

		await getTop(provider, { limit: null })

		expect(fx.query(MARKETS_MATCH).per_page).toBe('null')
	})

	it('returns an empty list for an empty feed', async () => {
		mount({ markets: { json: [] } })
		const provider = await importProvider()

		const quotes = await getTop(provider)

		expect(quotes).toEqual([])
	})

	it('never resolves a coin id for the top list', async () => {
		const fx = mount({ markets: { json: MARKETS } })
		const provider = await importProvider()

		await getTop(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})
})

describe('crypto/history', () => {
	const DAY_SNAPS: [number, string][] = [
		[1, '1'],
		[7, '7'],
		[14, '14'],
		[30, '30'],
		[90, '90'],
		[180, '180'],
		[365, '365'],
		[5, '7'],
		[31, '90'],
		[100, '180'],
		[200, '365'],
		[366, 'max'],
		[1000, 'max'],
	]

	it.each(DAY_SNAPS)('snaps %i days to %s on both endpoints', async (days, expected) => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days })

		expect(fx.query(OHLC_MATCH).days).toBe(expected)
		expect(fx.query(CHART_MATCH).days).toBe(expected)
	})

	it('snaps one day past the largest bucket to max', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: 365.5 })

		expect(fx.query(OHLC_MATCH).days).toBe('max')
	})

	it('snaps a fractional day up to the next valid bucket', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: 1.5 })

		expect(fx.query(OHLC_MATCH).days).toBe('7')
	})

	it('snaps zero days down to the one-day bucket', async () => {
		// NOTE: suspected bug — `?? 30` does not catch 0, so `--days 0` silently becomes a
		// one-day chart instead of the documented 30-day default.
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: 0 })

		expect(fx.query(OHLC_MATCH).days).toBe('1')
	})

	it('snaps a negative day count to the one-day bucket', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: -10 })

		expect(fx.query(OHLC_MATCH).days).toBe('1')
	})

	it('defaults to thirty days when days is omitted', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC' })

		expect(fx.query(OHLC_MATCH).days).toBe('30')
		expect(fx.query(CHART_MATCH).days).toBe('30')
	})

	it('defaults to thirty days when days is null', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: null })

		expect(fx.query(OHLC_MATCH).days).toBe('30')
	})

	it('builds both urls from the resolved coin id', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'eth', days: 7 })

		expect(fx.urls(OHLC_MATCH)).toEqual([`${BASE_URL}/coins/ethereum/ohlc?vs_currency=usd&days=7`])
		expect(fx.urls(CHART_MATCH)).toEqual([
			`${BASE_URL}/coins/ethereum/market_chart?vs_currency=usd&days=7`,
		])
	})

	it('resolves an unmapped symbol before fetching either series', async () => {
		const fx = mount({
			search: { json: SEARCH_RESPONSE },
			ohlc: { json: OHLC },
			chart: { json: CHART },
		})
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'PEPE' })

		expect(fx.callCount()).toBe(3)
		expect(fx.urls(OHLC_MATCH)[0]).toContain('/coins/pepe/ohlc')
		expect(fx.urls(CHART_MATCH)[0]).toContain('/coins/pepe/market_chart')
	})

	it('ignores the interval argument entirely', async () => {
		const fx = mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		await getHistory(provider, { symbol: 'BTC', days: 7, interval: '4h' })

		expect(fx.query(OHLC_MATCH)).toEqual({ vs_currency: 'usd', days: '7' })
	})

	it('maps ohlc tuples onto candles with an ISO timestamp', async () => {
		mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles).toEqual([
			{
				time: '2024-06-15T12:00:00.000Z',
				open: 66000,
				high: 67000,
				low: 65500,
				close: 66800,
				volume: 28_450_000_000,
			},
			{
				time: '2024-06-15T16:00:00.000Z',
				open: 66800,
				high: 67500,
				low: 66700,
				close: 67200,
				volume: 29_100_000_000,
			},
		])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ ohlc: { json: OHLC }, chart: { json: CHART } })
		const provider = await importProvider()

		const result = await provider.execute<CryptoCandle[]>('crypto', 'history', { symbol: 'BTC' })

		expect(result.source).toBe('coingecko')
		expect(result.cached).toBe(false)
	})

	it('falls back to zero volume when no sample shares the candle hour', async () => {
		mount({
			ohlc: { json: [[T0, 66000, 67000, 65500, 66800]] },
			chart: { json: { prices: [], total_volumes: [[T0 + 5 * HOUR, 28_450_000_000]] } },
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles[0].volume).toBe(0)
	})

	it('joins a volume sample within half an hour of the candle', async () => {
		mount({
			ohlc: { json: [[T0, 66000, 67000, 65500, 66800]] },
			chart: { json: { prices: [], total_volumes: [[T0 + HOUR / 2 - 1, 12345]] } },
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles[0].volume).toBe(12345)
	})

	it('drops a volume sample exactly thirty minutes after the candle', async () => {
		mount({
			ohlc: { json: [[T0, 66000, 67000, 65500, 66800]] },
			chart: { json: { prices: [], total_volumes: [[T0 + HOUR / 2, 12345]] } },
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles[0].volume).toBe(0)
	})

	it('joins a volume sample exactly thirty minutes before the candle', async () => {
		// Math.round is half-up, so the -30min sample rounds into the candle's bucket
		// while the +30min sample rounds out of it.
		mount({
			ohlc: { json: [[T0, 66000, 67000, 65500, 66800]] },
			chart: { json: { prices: [], total_volumes: [[T0 - HOUR / 2, 12345]] } },
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles[0].volume).toBe(12345)
	})

	it('lets the last sample win when two land in the same hour bucket', async () => {
		mount({
			ohlc: { json: [[T0, 66000, 67000, 65500, 66800]] },
			chart: {
				json: {
					prices: [],
					total_volumes: [
						[T0 - 60_000, 111],
						[T0 + 60_000, 222],
					],
				},
			},
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles[0].volume).toBe(222)
	})

	it('reports zero volume for daily candles that miss the daily volume stamps', async () => {
		// NOTE: suspected bug — the hour-bucket join silently degrades to `volume: 0`
		// whenever OHLC and market_chart stamps drift apart (they do for multi-day
		// ranges), so candles claim zero traded volume instead of "unknown".
		const dayMs = 24 * HOUR
		mount({
			ohlc: {
				json: [
					[T0, 66000, 67000, 65500, 66800],
					[T0 + dayMs, 66800, 67500, 66700, 67200],
				],
			},
			chart: {
				json: {
					prices: [],
					total_volumes: [
						[T0 + 2 * HOUR, 28_450_000_000],
						[T0 + dayMs + 2 * HOUR, 29_100_000_000],
					],
				},
			},
		})
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles.map((c) => c.volume)).toEqual([0, 0])
	})

	it('returns an empty list when the ohlc series is empty', async () => {
		mount({ ohlc: { json: [] }, chart: { json: CHART } })
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles).toEqual([])
	})

	it('returns zero-volume candles when the volume series is empty', async () => {
		mount({ ohlc: { json: OHLC }, chart: { json: { prices: [], total_volumes: [] } } })
		const provider = await importProvider()

		const candles = await getHistory(provider)

		expect(candles.map((c) => c.volume)).toEqual([0, 0])
	})

	it('propagates an ohlc endpoint failure', async () => {
		mount({ ohlc: { status: 404, text: 'coin not found' }, chart: { json: CHART } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow('CoinGecko API error 404: coin not found')
	})

	it('propagates a market_chart endpoint failure', async () => {
		mount({ ohlc: { json: OHLC }, chart: { status: 500, text: 'boom' } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow('CoinGecko API error 500: boom')
	})

	it('throws a TypeError when market_chart omits total_volumes', async () => {
		// NOTE: suspected bug — `chartData.total_volumes` is iterated without a guard, so
		// a partial payload surfaces as a raw TypeError.
		mount({ ohlc: { json: OHLC }, chart: { json: { prices: [] } } })
		const provider = await importProvider()

		await expect(getHistory(provider)).rejects.toThrow(TypeError)
	})
})

describe('crypto/trending', () => {
	it('requests the trending endpoint with no query params', async () => {
		const fx = mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		await getTrending(provider)

		expect(fx.urls()).toEqual([`${BASE_URL}/search/trending`])
	})

	it('maps a trending coin with full data', async () => {
		mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		const quotes = await getTrending(provider)

		expect(quotes[0]).toEqual({
			symbol: 'PEPE',
			name: 'Pepe',
			price: 0.0000112,
			marketCapRank: 24,
			changePercent24h: 8.42,
			source: 'coingecko',
		})
	})

	it('defaults the price to zero and the rank to undefined when data is absent', async () => {
		mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		const quotes = await getTrending(provider)

		expect(quotes[1]).toEqual({
			symbol: 'OBS',
			name: 'Obscure Token',
			price: 0,
			marketCapRank: undefined,
			changePercent24h: undefined,
			source: 'coingecko',
		})
	})

	it('picks the usd entry out of the per-currency change map', async () => {
		mount({
			trending: {
				json: {
					coins: [
						{
							item: {
								id: 'pepe',
								name: 'Pepe',
								symbol: 'pepe',
								market_cap_rank: 24,
								price_btc: 1.7e-10,
								data: { price: 1, price_change_percentage_24h: { eur: 7.9, gbp: 6.4 } },
							},
						},
					],
				},
			},
		})
		const provider = await importProvider()

		const quotes = await getTrending(provider)

		expect(quotes[0].changePercent24h).toBeUndefined()
	})

	it('keeps a genuine zero price rather than defaulting it', async () => {
		mount({
			trending: {
				json: {
					coins: [
						{
							item: {
								id: 'dead-coin',
								name: 'Dead Coin',
								symbol: 'dead',
								market_cap_rank: 9999,
								price_btc: 0,
								data: { price: 0, price_change_percentage_24h: { usd: -100 } },
							},
						},
					],
				},
			},
		})
		const provider = await importProvider()

		const quotes = await getTrending(provider)

		expect(quotes[0].price).toBe(0)
		expect(quotes[0].changePercent24h).toBe(-100)
	})

	it('returns an empty list when nothing is trending', async () => {
		mount({ trending: { json: { coins: [] } } })
		const provider = await importProvider()

		const quotes = await getTrending(provider)

		expect(quotes).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		const result = await provider.execute<CryptoQuote[]>('crypto', 'trending', {})

		expect(result.source).toBe('coingecko')
		expect(result.cached).toBe(false)
	})
})

describe('crypto/global', () => {
	it('unwraps the data envelope of the global endpoint', async () => {
		mount({ global: { json: GLOBAL } })
		const provider = await importProvider()

		const result = await provider.execute<GlobalPayload>('crypto', 'global', {})

		expect(result.data.active_cryptocurrencies).toBe(14203)
		expect(result.data.markets).toBe(1123)
		expect(result.data.total_market_cap.usd).toBe(2_410_000_000_000)
		expect(result.data.total_volume.usd).toBe(82_000_000_000)
		expect(result.data.market_cap_percentage.btc).toBe(54.2)
		expect(result.data.market_cap_change_percentage_24h_usd).toBe(-1.234)
	})

	it('requests the global endpoint with no query params', async () => {
		const fx = mount({ global: { json: GLOBAL } })
		const provider = await importProvider()

		await provider.execute('crypto', 'global', {})

		expect(fx.urls()).toEqual([`${BASE_URL}/global`])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ global: { json: GLOBAL } })
		const provider = await importProvider()

		const result = await provider.execute<GlobalPayload>('crypto', 'global', {})

		expect(result.source).toBe('coingecko')
		expect(result.cached).toBe(false)
	})

	it('resolves with undefined data when the payload has no data key', async () => {
		// NOTE: suspected bug — `data.data` is returned unchecked, so a malformed payload
		// resolves successfully with `undefined` data instead of raising.
		mount({ global: { json: { status: 'ok' } } })
		const provider = await importProvider()

		const result = await provider.execute<GlobalPayload>('crypto', 'global', {})

		expect(result.data).toBeUndefined()
	})
})

describe('search/search', () => {
	it('maps every coin to a crypto search result', async () => {
		mount({ search: { json: SEARCH_RESPONSE } })
		const provider = await importProvider()

		const results = await search(provider, 'pepe')

		expect(results).toEqual([
			{ symbol: 'PEPE', name: 'Pepe', type: 'crypto', source: 'coingecko' },
			{ symbol: 'PEPE2.0', name: 'Pepe 2.0', type: 'crypto', source: 'coingecko' },
		])
	})

	it('ignores exchange and category hits', async () => {
		mount({ search: { json: SEARCH_RESPONSE } })
		const provider = await importProvider()

		const results = await search(provider, 'pepe')

		expect(results).toHaveLength(2)
	})

	it('uppercases lowercase symbols', async () => {
		mount({
			search: { json: { coins: [{ id: 'solana', name: 'Solana', symbol: 'sol' }] } },
		})
		const provider = await importProvider()

		const results = await search(provider, 'solana')

		expect(results[0].symbol).toBe('SOL')
	})

	it('url-encodes the query', async () => {
		const fx = mount({ search: { json: SEARCH_RESPONSE } })
		const provider = await importProvider()

		await search(provider, 'bitcoin cash & friends')

		expect(fx.urls()).toEqual([`${BASE_URL}/search?query=bitcoin%20cash%20%26%20friends`])
	})

	it('returns an empty list when nothing matches', async () => {
		mount({ search: { json: { coins: [], exchanges: [], categories: [] } } })
		const provider = await importProvider()

		const results = await search(provider, 'zzzzz')

		expect(results).toEqual([])
	})

	it('does not throw for an empty result the way coin resolution does', async () => {
		mount({ search: { json: { coins: [] } } })
		const provider = await importProvider()

		await expect(search(provider, 'zzzzz')).resolves.toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ search: { json: SEARCH_RESPONSE } })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'pepe' })

		expect(result.source).toBe('coingecko')
		expect(result.cached).toBe(false)
	})

	it('throws a TypeError when the payload has no coins array', async () => {
		mount({ search: { json: { exchanges: [] } } })
		const provider = await importProvider()

		await expect(search(provider, 'pepe')).rejects.toThrow(TypeError)
	})

	it('sends the literal string undefined when no query is supplied', async () => {
		// NOTE: suspected bug — a missing query is interpolated as "undefined" and sent
		// upstream instead of being rejected with a helpful message.
		const fx = mount({ search: { json: { coins: [] } } })
		const provider = await importProvider()

		await search(provider, undefined)

		expect(fx.query().query).toBe('undefined')
	})
})

describe('action dispatch', () => {
	it('rejects an unknown crypto action', async () => {
		const fx = mockFetch([])
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'candles', { symbol: 'BTC' })).rejects.toThrow(
			'CoinGecko crypto does not support action: candles',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty crypto action', async () => {
		mockFetch([])
		const provider = await importProvider()

		await expect(provider.execute('crypto', '', {})).rejects.toThrow(
			'CoinGecko crypto does not support action: ',
		)
	})

	it('rejects an unknown search action', async () => {
		const fx = mockFetch([])
		const provider = await importProvider()

		await expect(provider.execute('search', 'lookup', { query: 'btc' })).rejects.toThrow(
			'CoinGecko search does not support action: lookup',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('does not accept the crypto actions under the search category', async () => {
		mockFetch([])
		const provider = await importProvider()

		await expect(provider.execute('search', 'trending', {})).rejects.toThrow(
			'CoinGecko search does not support action: trending',
		)
	})

	it('treats every non-search category as crypto', async () => {
		// NOTE: suspected bug — only 'search' is special-cased, so an unsupported
		// category such as 'macro' silently falls through to the crypto switch and
		// returns crypto data for a macro request.
		mount({ trending: { json: TRENDING } })
		const provider = await importProvider()

		const result = await provider.execute<CryptoQuote[]>('macro', 'trending', {})

		expect(result.data[0].symbol).toBe('PEPE')
	})

	it('blames crypto in the error for an unsupported category', async () => {
		mockFetch([])
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'CoinGecko crypto does not support action: get',
		)
	})
})
