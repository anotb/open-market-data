import { fetchWithTimeout, readBoundedResponseText } from '../core/http.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { CryptoCandle, CryptoQuote } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

// Binance recommends the market-data-only host for public endpoints. Besides
// avoiding unnecessary trading API exposure, it remains available in regions
// where the main api.binance.com host returns HTTP 451.
const BASE_URL = 'https://data-api.binance.vision'
const DAY_MS = 86_400_000
const MAX_KLINES = 1000
const INTERVAL_MS: Readonly<Record<string, number>> = {
	'1m': 60_000,
	'5m': 5 * 60_000,
	'15m': 15 * 60_000,
	'1h': 60 * 60_000,
	'4h': 4 * 60 * 60_000,
	'1d': DAY_MS,
	'1w': 7 * DAY_MS,
}

const rateLimits: RateLimitConfig = {
	maxRequests: 1200,
	windowMs: 60_000,
}

// Cache geo-restriction status to avoid repeated failed requests.
let geoRestricted = false

async function request<T>(path: string): Promise<T> {
	if (geoRestricted) {
		throw new Error('Binance is geo-restricted in your region (HTTP 451)')
	}

	if (!consumeToken('binance', rateLimits)) {
		throw new Error('Binance rate limit exceeded')
	}

	const res = await fetchWithTimeout(`${BASE_URL}${path}`)
	if (res.status === 451) {
		geoRestricted = true
		throw new Error('Binance is geo-restricted in your region (HTTP 451)')
	}
	if (!res.ok) {
		const body = await readBoundedResponseText(res)
		throw new Error(`Binance API error ${res.status}: ${body}`)
	}
	return res.json() as Promise<T>
}

interface Ticker24hr {
	symbol: string
	lastPrice: string
	priceChange: string
	priceChangePercent: string
	quoteVolume: string
	highPrice: string
	lowPrice: string
}

interface TickerPrice {
	symbol: string
	price: string
}

type Kline = [
	number, // openTime
	string, // open
	string, // high
	string, // low
	string, // close
	string, // volume
	...unknown[],
]

export function calculateKlineLimit(days: number, interval: string): number {
	if (!Number.isFinite(days) || days <= 0) {
		throw new Error('[binance] days must be a positive number')
	}
	const intervalMs = INTERVAL_MS[interval]
	if (!intervalMs) {
		throw new Error(`[binance] Unsupported interval "${interval}"`)
	}
	return Math.min(MAX_KLINES, Math.max(1, Math.ceil((days * DAY_MS) / intervalMs)))
}

async function getQuote(symbol: string): Promise<ProviderResult<CryptoQuote>> {
	const pair = `${symbol.toUpperCase()}USDT`
	const data = await request<Ticker24hr>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`)

	return {
		data: {
			symbol: symbol.toUpperCase(),
			price: Number(data.lastPrice),
			change24h: Number(data.priceChange),
			changePercent24h: Number(data.priceChangePercent),
			volume24h: Number(data.quoteVolume),
			high24h: Number(data.highPrice),
			low24h: Number(data.lowPrice),
			source: 'binance',
		},
		source: 'binance',
		cached: false,
	}
}

async function getHistory(
	symbol: string,
	days = 30,
	interval = '1d',
): Promise<ProviderResult<CryptoCandle[]>> {
	const pair = `${symbol.toUpperCase()}USDT`
	const limit = calculateKlineLimit(days, interval)
	const data = await request<Kline[]>(
		`/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
	)

	const candles: CryptoCandle[] = data.map((k) => ({
		time: new Date(k[0]).toISOString(),
		open: Number(k[1]),
		high: Number(k[2]),
		low: Number(k[3]),
		close: Number(k[4]),
		volume: Number(k[5]),
	}))

	return {
		data: candles,
		source: 'binance',
		cached: false,
	}
}

async function getPrice(
	symbol: string,
): Promise<ProviderResult<{ symbol: string; price: number }>> {
	const pair = `${symbol.toUpperCase()}USDT`
	const data = await request<TickerPrice>(`/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`)

	return {
		data: {
			symbol: symbol.toUpperCase(),
			price: Number(data.price),
		},
		source: 'binance',
		cached: false,
	}
}

export const binance: Provider = {
	name: 'binance',
	requiresKey: false,
	capabilities: ['crypto'] as DataCategory[],
	priority: { crypto: 1 },
	rateLimits,

	isEnabled(): boolean {
		return !geoRestricted
	},

	async execute<T = unknown>(
		_category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		switch (action) {
			case 'quote':
				return (await getQuote(args.symbol as string)) as ProviderResult<T>

			case 'history':
				return (await getHistory(
					args.symbol as string,
					(args.days as number) ?? 30,
					(args.interval as string) ?? '1d',
				)) as ProviderResult<T>

			case 'price':
				return (await getPrice(args.symbol as string)) as ProviderResult<T>

			default:
				throw new Error(`Binance does not support action: ${action}`)
		}
	},
}
