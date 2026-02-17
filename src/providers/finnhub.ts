import { loadConfig } from '../core/config.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { EarningsData, HistoricalQuote, QuoteResult, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

const SOURCE = 'finnhub'
const BASE_URL = 'https://finnhub.io/api/v1'

const rateLimits: RateLimitConfig = {
	maxRequests: 60,
	windowMs: 60_000,
}

function getKey(): string {
	const key = loadConfig().finnhubApiKey
	if (!key)
		throw new Error(`[${SOURCE}] FINNHUB_API_KEY not set. Run: omd config set finnhubApiKey <key>`)
	return key
}

async function request<T>(path: string): Promise<T> {
	if (!consumeToken(SOURCE, rateLimits)) {
		throw new Error(`[${SOURCE}] Rate limit exceeded`)
	}

	const separator = path.includes('?') ? '&' : '?'
	const url = `${BASE_URL}${path}${separator}token=${getKey()}`

	const res = await fetch(url)
	if (!res.ok) {
		const body = await res.text()
		throw new Error(`[${SOURCE}] API error ${res.status}: ${body}`)
	}
	return res.json() as Promise<T>
}

// --- Search ---

interface FinnhubSearchResult {
	count: number
	result: Array<{
		description: string
		displaySymbol: string
		symbol: string
		type: string
	}>
}

async function search(query: string): Promise<ProviderResult<SearchResult[]>> {
	const data = await request<FinnhubSearchResult>(`/search?q=${encodeURIComponent(query)}`)

	const results: SearchResult[] = (data.result ?? []).map((r) => ({
		symbol: r.symbol,
		name: r.description,
		type: r.type,
		source: SOURCE,
	}))

	return { data: results, source: SOURCE, cached: false }
}

// --- Quote ---

interface FinnhubQuote {
	c: number
	d: number | null
	dp: number | null
	h: number
	l: number
	o: number
	pc: number
	t: number
}

async function getQuote(symbol: string): Promise<ProviderResult<QuoteResult>> {
	const data = await request<FinnhubQuote>(
		`/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
	)

	if (data.c === 0 && data.h === 0 && data.l === 0 && data.o === 0 && data.pc === 0) {
		throw new Error(`[${SOURCE}] No quote data for "${symbol}" — ticker may be invalid`)
	}

	return {
		data: {
			symbol: symbol.toUpperCase(),
			price: data.c,
			change: data.d ?? 0,
			changePercent: data.dp ?? 0,
			open: data.o,
			previousClose: data.pc,
			dayHigh: data.h,
			dayLow: data.l,
			source: SOURCE,
		},
		source: SOURCE,
		cached: false,
	}
}

// --- Earnings ---

interface FinnhubEarning {
	actual: number | null
	estimate: number | null
	period: string
	surprisePercent: number | null
	symbol: string
}

async function getEarnings(symbol: string): Promise<ProviderResult<EarningsData[]>> {
	const data = await request<FinnhubEarning[]>(
		`/stock/earnings?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
	)

	const results: EarningsData[] = (data ?? []).map((e) => ({
		symbol: symbol.toUpperCase(),
		earningsDate: e.period,
		epsActual: e.actual ?? undefined,
		epsEstimate: e.estimate ?? undefined,
		source: SOURCE,
	}))

	return { data: results, source: SOURCE, cached: false }
}

// --- History (candles) ---

interface FinnhubCandles {
	c: number[]
	h: number[]
	l: number[]
	o: number[]
	s: string
	t: number[]
	v: number[]
}

async function getHistory(symbol: string, days = 30): Promise<ProviderResult<HistoricalQuote[]>> {
	const now = Math.floor(Date.now() / 1000)
	const from = now - days * 86_400

	const data = await request<FinnhubCandles>(
		`/stock/candle?symbol=${encodeURIComponent(symbol.toUpperCase())}&resolution=D&from=${from}&to=${now}`,
	)

	if (data.s !== 'ok') {
		throw new Error(
			`[${SOURCE}] Candle data not available for "${symbol}" (status: ${data.s}). This endpoint may require a paid plan.`,
		)
	}

	const quotes: HistoricalQuote[] = data.t.map((t, i) => ({
		date: new Date(t * 1000).toISOString().split('T')[0],
		open: data.o[i],
		high: data.h[i],
		low: data.l[i],
		close: data.c[i],
		volume: data.v[i],
	}))

	return { data: quotes, source: SOURCE, cached: false }
}

// --- Provider export ---

export const finnhub: Provider = {
	name: SOURCE,
	requiresKey: true,
	keyEnvVar: 'FINNHUB_API_KEY',
	capabilities: ['search', 'quote', 'earnings'] as DataCategory[],
	priority: { search: 5, quote: 3, earnings: 2 },
	rateLimits,

	isEnabled(): boolean {
		return !!loadConfig().finnhubApiKey
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		const key = `${category}/${action}`

		switch (key) {
			case 'search/search': {
				const query = args.query as string
				if (!query) throw new Error(`[${SOURCE}] search requires query`)
				return (await search(query)) as ProviderResult<T>
			}

			case 'quote/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] quote requires symbol`)
				return (await getQuote(symbol)) as ProviderResult<T>
			}

			case 'earnings/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] earnings requires symbol`)
				return (await getEarnings(symbol)) as ProviderResult<T>
			}

			case 'history/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] history requires symbol`)
				const days = (args.days as number) ?? 30
				return (await getHistory(symbol, days)) as ProviderResult<T>
			}

			default:
				throw new Error(`[${SOURCE}] Unsupported operation: ${key}`)
		}
	},
}
