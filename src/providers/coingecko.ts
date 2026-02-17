import { loadConfig } from '../core/config.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { CryptoCandle, CryptoQuote, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

const BASE_URL = 'https://api.coingecko.com/api/v3'

const rateLimits: RateLimitConfig = {
	maxRequests: 30,
	windowMs: 60_000,
}

const SYMBOL_TO_ID: Record<string, string> = {
	BTC: 'bitcoin',
	ETH: 'ethereum',
	SOL: 'solana',
	BNB: 'binancecoin',
	XRP: 'ripple',
	ADA: 'cardano',
	DOGE: 'dogecoin',
	DOT: 'polkadot',
	AVAX: 'avalanche-2',
	MATIC: 'matic-network',
	LINK: 'chainlink',
	UNI: 'uniswap',
	ATOM: 'cosmos',
	LTC: 'litecoin',
}

function getApiKey(): string {
	const config = loadConfig()
	const key = config.coingeckoApiKey
	if (!key) {
		throw new Error(
			'CoinGecko API key not configured. Set COINGECKO_API_KEY or run: omd config set coingeckoApiKey <key>',
		)
	}
	return key
}

async function request<T>(path: string): Promise<T> {
	if (!consumeToken('coingecko', rateLimits)) {
		throw new Error('CoinGecko rate limit exceeded')
	}

	const key = getApiKey()
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { 'x-cg-demo-api-key': key },
	})

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`CoinGecko API error ${res.status}: ${body}`)
	}
	return res.json() as Promise<T>
}

interface SearchCoin {
	id: string
	name: string
	symbol: string
	market_cap_rank: number | null
}

interface SearchResponse {
	coins: SearchCoin[]
}

async function resolveCoinId(symbol: string): Promise<string> {
	const upper = symbol.toUpperCase()
	const mapped = SYMBOL_TO_ID[upper]
	if (mapped) return mapped

	const data = await request<SearchResponse>(`/search?query=${encodeURIComponent(symbol)}`)
	if (data.coins.length === 0) {
		throw new Error(`CoinGecko: could not resolve coin ID for symbol "${symbol}"`)
	}
	return data.coins[0].id
}

interface SimplePriceEntry {
	usd: number
	usd_24h_change?: number
	usd_24h_vol?: number
	usd_market_cap?: number
}

async function getQuote(symbol: string): Promise<ProviderResult<CryptoQuote>> {
	const id = await resolveCoinId(symbol)
	const data = await request<Record<string, SimplePriceEntry>>(
		`/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
	)

	const entry = data[id]
	if (!entry) {
		throw new Error(`CoinGecko: no price data for "${id}"`)
	}

	const changePercent = entry.usd_24h_change
	// usd_24h_change is a percentage — compute absolute dollar change from price
	const change24h = changePercent != null ? entry.usd * (changePercent / 100) : undefined

	return {
		data: {
			symbol: symbol.toUpperCase(),
			price: entry.usd,
			change24h,
			changePercent24h: changePercent,
			volume24h: entry.usd_24h_vol,
			marketCap: entry.usd_market_cap,
			source: 'coingecko',
		},
		source: 'coingecko',
		cached: false,
	}
}

interface MarketCoin {
	id: string
	symbol: string
	name: string
	current_price: number
	market_cap: number
	market_cap_rank: number
	total_volume: number
	high_24h: number | null
	low_24h: number | null
	price_change_24h: number | null
	price_change_percentage_24h: number | null
	circulating_supply: number | null
	ath: number | null
}

async function getTop(limit = 10): Promise<ProviderResult<CryptoQuote[]>> {
	const data = await request<MarketCoin[]>(
		`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&sparkline=false`,
	)

	const quotes: CryptoQuote[] = data.map((c) => ({
		symbol: c.symbol.toUpperCase(),
		name: c.name,
		price: c.current_price,
		change24h: c.price_change_24h ?? undefined,
		changePercent24h: c.price_change_percentage_24h ?? undefined,
		volume24h: c.total_volume,
		marketCap: c.market_cap,
		marketCapRank: c.market_cap_rank,
		high24h: c.high_24h ?? undefined,
		low24h: c.low_24h ?? undefined,
		circulatingSupply: c.circulating_supply ?? undefined,
		ath: c.ath ?? undefined,
		source: 'coingecko',
	}))

	return { data: quotes, source: 'coingecko', cached: false }
}

type OhlcEntry = [number, number, number, number, number]

interface MarketChartResponse {
	prices: [number, number][]
	total_volumes: [number, number][]
}

// CoinGecko OHLC endpoint only accepts specific day values
const VALID_OHLC_DAYS = [1, 7, 14, 30, 90, 180, 365]

function snapToValidDays(days: number): number | 'max' {
	if (days > 365) return 'max'
	// Find the smallest valid value >= requested days
	for (const valid of VALID_OHLC_DAYS) {
		if (valid >= days) return valid
	}
	return 365
}

async function getHistory(
	symbol: string,
	days = 30,
	_interval?: string,
): Promise<ProviderResult<CryptoCandle[]>> {
	const id = await resolveCoinId(symbol)

	// CoinGecko auto-selects granularity based on days:
	// 1-2 days → 30min, 3-30 → 4h, 31-365 → daily, 365+ → weekly
	// The --interval flag is only honored by Binance; CoinGecko uses days-based auto-interval.
	const ohlcDays = snapToValidDays(days)
	const [ohlcData, chartData] = await Promise.all([
		request<OhlcEntry[]>(`/coins/${id}/ohlc?vs_currency=usd&days=${ohlcDays}`),
		// Use same snapped days so volume data covers the full OHLC range
		request<MarketChartResponse>(`/coins/${id}/market_chart?vs_currency=usd&days=${ohlcDays}`),
	])

	// Build a volume lookup by timestamp (rounded to nearest hour)
	const volumeMap = new Map<number, number>()
	for (const [ts, vol] of chartData.total_volumes) {
		volumeMap.set(Math.round(ts / 3600000), vol)
	}

	const candles: CryptoCandle[] = ohlcData.map((entry) => {
		const tsHour = Math.round(entry[0] / 3600000)
		return {
			time: new Date(entry[0]).toISOString(),
			open: entry[1],
			high: entry[2],
			low: entry[3],
			close: entry[4],
			volume: volumeMap.get(tsHour) ?? 0,
		}
	})

	return { data: candles, source: 'coingecko', cached: false }
}

interface TrendingCoin {
	item: {
		id: string
		coin_id: number
		name: string
		symbol: string
		market_cap_rank: number | null
		price_btc: number
		data?: {
			price: number
			price_change_percentage_24h?: Record<string, number>
			market_cap?: string
			total_volume?: string
		}
	}
}

interface TrendingResponse {
	coins: TrendingCoin[]
}

async function getTrending(): Promise<ProviderResult<CryptoQuote[]>> {
	const data = await request<TrendingResponse>('/search/trending')

	const quotes: CryptoQuote[] = data.coins.map((c) => ({
		symbol: c.item.symbol.toUpperCase(),
		name: c.item.name,
		price: c.item.data?.price ?? 0,
		marketCapRank: c.item.market_cap_rank ?? undefined,
		changePercent24h: c.item.data?.price_change_percentage_24h?.usd,
		source: 'coingecko',
	}))

	return { data: quotes, source: 'coingecko', cached: false }
}

interface GlobalData {
	data: {
		active_cryptocurrencies: number
		markets: number
		total_market_cap: Record<string, number>
		total_volume: Record<string, number>
		market_cap_percentage: Record<string, number>
		market_cap_change_percentage_24h_usd: number
	}
}

async function getGlobal(): Promise<ProviderResult<GlobalData['data']>> {
	const data = await request<GlobalData>('/global')

	return { data: data.data, source: 'coingecko', cached: false }
}

async function search(query: string): Promise<ProviderResult<SearchResult[]>> {
	const data = await request<SearchResponse>(`/search?query=${encodeURIComponent(query)}`)

	const results: SearchResult[] = data.coins.map((c) => ({
		symbol: c.symbol.toUpperCase(),
		name: c.name,
		type: 'crypto',
		source: 'coingecko',
	}))

	return { data: results, source: 'coingecko', cached: false }
}

export const coingecko: Provider = {
	name: 'coingecko',
	requiresKey: true,
	keyEnvVar: 'COINGECKO_API_KEY',
	capabilities: ['crypto', 'search'] as DataCategory[],
	priority: { crypto: 2, search: 4 },
	rateLimits,

	isEnabled(): boolean {
		return !!loadConfig().coingeckoApiKey
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		if (category === 'search') {
			switch (action) {
				case 'search':
					return (await search(args.query as string)) as ProviderResult<T>
				default:
					throw new Error(`CoinGecko search does not support action: ${action}`)
			}
		}

		// category === 'crypto'
		switch (action) {
			case 'quote':
				return (await getQuote(args.symbol as string)) as ProviderResult<T>

			case 'top':
				return (await getTop(args.limit as number | undefined)) as ProviderResult<T>

			case 'history':
				return (await getHistory(
					args.symbol as string,
					(args.days as number) ?? 30,
					args.interval as string | undefined,
				)) as ProviderResult<T>

			case 'trending':
				return (await getTrending()) as ProviderResult<T>

			case 'global':
				return (await getGlobal()) as ProviderResult<T>

			default:
				throw new Error(`CoinGecko crypto does not support action: ${action}`)
		}
	},
}
