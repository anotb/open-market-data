import { consumeToken } from '../core/rate-limiter.js'
import type { CryptoCandle, CryptoQuote } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

const BASE_URL = 'https://api.binance.com'

const rateLimits: RateLimitConfig = {
	maxRequests: 1200,
	windowMs: 60_000,
}

async function request<T>(path: string): Promise<T> {
	if (!consumeToken('binance', rateLimits)) {
		throw new Error('Binance rate limit exceeded')
	}

	const res = await fetch(`${BASE_URL}${path}`)
	if (!res.ok) {
		const body = await res.text()
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

async function getQuote(symbol: string): Promise<ProviderResult<CryptoQuote>> {
	const pair = `${symbol.toUpperCase()}USDT`
	const data = await request<Ticker24hr>(`/api/v3/ticker/24hr?symbol=${pair}`)

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
	const data = await request<Kline[]>(
		`/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${days}`,
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
	const data = await request<TickerPrice>(`/api/v3/ticker/price?symbol=${pair}`)

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
		return true
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
