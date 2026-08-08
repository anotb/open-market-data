import { loadConfig } from '../core/config.js'
import { fetchWithTimeout, readBoundedResponseText } from '../core/http.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { CryptoCandle, CryptoQuote, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

const BASE_URL = 'https://api.coingecko.com/api/v3'
const SOURCE = 'coingecko'

const rateLimits: RateLimitConfig = {
	maxRequests: 30,
	windowMs: 60_000,
}

const SYMBOL_TO_ID: Readonly<Record<string, string>> = {
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

async function request<T>(path: string): Promise<T> {
	if (!consumeToken(SOURCE, rateLimits)) {
		throw new Error('CoinGecko rate limit exceeded')
	}

	const key = loadConfig().coingeckoApiKey
	const options = key ? { headers: { 'x-cg-demo-api-key': key } } : undefined
	const response = await fetchWithTimeout(`${BASE_URL}${path}`, options)

	if (!response.ok) {
		const body = await readBoundedResponseText(response)
		const hint =
			response.status === 429 && !key
				? ' Configure a free CoinGecko Demo key for a dedicated quota.'
				: ''
		throw new Error(`CoinGecko API error ${response.status}: ${body}${hint}`)
	}
	return response.json() as Promise<T>
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
	const normalized = symbol.trim().toUpperCase()
	const mapped = SYMBOL_TO_ID[normalized]
	if (mapped) return mapped

	const data = await request<SearchResponse>(`/search?query=${encodeURIComponent(symbol)}`)
	const exact = data.coins.find((coin) => coin.symbol.toUpperCase() === normalized)
	const coin = exact ?? data.coins[0]
	if (!coin) {
		throw new Error(`CoinGecko: could not resolve coin ID for symbol "${symbol}"`)
	}
	return coin.id
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
	if (!entry || !Number.isFinite(entry.usd) || entry.usd <= 0) {
		throw new Error(`CoinGecko: no usable price data for "${id}"`)
	}

	const changePercent = entry.usd_24h_change
	const change24h = changePercent != null ? entry.usd * (changePercent / 100) : undefined
	return {
		data: {
			symbol: symbol.trim().toUpperCase(),
			price: entry.usd,
			change24h,
			changePercent24h: changePercent,
			volume24h: entry.usd_24h_vol,
			marketCap: entry.usd_market_cap,
			source: SOURCE,
		},
		source: SOURCE,
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
	const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limit)))
	const data = await request<MarketCoin[]>(
		`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${boundedLimit}&sparkline=false`,
	)
	const quotes: CryptoQuote[] = data.map((coin) => ({
		symbol: coin.symbol.toUpperCase(),
		name: coin.name,
		price: coin.current_price,
		change24h: coin.price_change_24h ?? undefined,
		changePercent24h: coin.price_change_percentage_24h ?? undefined,
		volume24h: coin.total_volume,
		marketCap: coin.market_cap,
		marketCapRank: coin.market_cap_rank,
		high24h: coin.high_24h ?? undefined,
		low24h: coin.low_24h ?? undefined,
		circulatingSupply: coin.circulating_supply ?? undefined,
		ath: coin.ath ?? undefined,
		source: SOURCE,
	}))
	return { data: quotes, source: SOURCE, cached: false }
}

type OhlcEntry = [number, number, number, number, number]

interface MarketChartResponse {
	total_volumes: [number, number][]
}

const VALID_OHLC_DAYS = [1, 7, 14, 30, 90, 180, 365] as const

function snapToValidDays(days: number): number | 'max' {
	if (days > 365) return 'max'
	return VALID_OHLC_DAYS.find((valid) => valid >= days) ?? 365
}

async function getHistory(
	symbol: string,
	days = 30,
	_interval?: string,
): Promise<ProviderResult<CryptoCandle[]>> {
	const id = await resolveCoinId(symbol)
	const ohlcDays = snapToValidDays(Math.max(1, Math.trunc(days)))
	const [ohlcData, chartData] = await Promise.all([
		request<OhlcEntry[]>(`/coins/${id}/ohlc?vs_currency=usd&days=${ohlcDays}`),
		request<MarketChartResponse>(`/coins/${id}/market_chart?vs_currency=usd&days=${ohlcDays}`),
	])

	const volumeMap = new Map<number, number>()
	for (const [timestamp, volume] of chartData.total_volumes) {
		volumeMap.set(Math.round(timestamp / 3_600_000), volume)
	}
	const candles: CryptoCandle[] = ohlcData.map((entry) => ({
		time: new Date(entry[0]).toISOString(),
		open: entry[1],
		high: entry[2],
		low: entry[3],
		close: entry[4],
		volume: volumeMap.get(Math.round(entry[0] / 3_600_000)) ?? 0,
	}))
	return { data: candles, source: SOURCE, cached: false }
}

interface TrendingResponse {
	coins: Array<{
		item: {
			name: string
			symbol: string
			market_cap_rank: number | null
			data?: {
				price: number
				price_change_percentage_24h?: Record<string, number>
			}
		}
	}>
}

async function getTrending(): Promise<ProviderResult<CryptoQuote[]>> {
	const data = await request<TrendingResponse>('/search/trending')
	const quotes: CryptoQuote[] = data.coins.map(({ item }) => ({
		symbol: item.symbol.toUpperCase(),
		name: item.name,
		price: item.data?.price ?? 0,
		marketCapRank: item.market_cap_rank ?? undefined,
		changePercent24h: item.data?.price_change_percentage_24h?.usd,
		source: SOURCE,
	}))
	return { data: quotes, source: SOURCE, cached: false }
}

interface GlobalMarketData {
	active_cryptocurrencies: number
	markets: number
	total_market_cap: Record<string, number>
	total_volume: Record<string, number>
	market_cap_percentage: Record<string, number>
	market_cap_change_percentage_24h_usd: number
}

async function getGlobal(): Promise<ProviderResult<GlobalMarketData>> {
	const response = await request<{ data: GlobalMarketData }>('/global')
	return { data: response.data, source: SOURCE, cached: false }
}

async function search(query: string): Promise<ProviderResult<SearchResult[]>> {
	const data = await request<SearchResponse>(`/search?query=${encodeURIComponent(query)}`)
	const results: SearchResult[] = data.coins.map((coin) => ({
		symbol: coin.symbol.toUpperCase(),
		name: coin.name,
		type: 'crypto',
		source: SOURCE,
	}))
	return { data: results, source: SOURCE, cached: false }
}

export const coingecko: Provider = {
	name: SOURCE,
	requiresKey: false,
	keyEnvVar: 'COINGECKO_API_KEY',
	capabilities: ['crypto', 'search'] as DataCategory[],
	priority: { crypto: 2, search: 4 },
	rateLimits,

	isEnabled(): boolean {
		return true
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		if (category === 'search') {
			if (action !== 'search') {
				throw new Error(`CoinGecko search does not support action: ${action}`)
			}
			return (await search(args.query as string)) as ProviderResult<T>
		}

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
