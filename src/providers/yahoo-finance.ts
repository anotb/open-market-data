import YahooFinance from 'yahoo-finance2'
import { consumeToken } from '../core/rate-limiter.js'
import type { FinancialStatement, QuoteResult, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const SOURCE = 'yahoo'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

// Yahoo Finance search quote shape (simplified from the full union)
interface YFSearchQuote {
	symbol: string
	isYahooFinance: boolean
	exchange: string
	exchDisp?: string
	shortname?: string
	longname?: string
	quoteType?: string
}

// Yahoo Finance quote shape (simplified from the full Quote union)
interface YFQuote {
	symbol: string
	regularMarketPrice?: number
	regularMarketChange?: number
	regularMarketChangePercent?: number
	regularMarketVolume?: number
	regularMarketOpen?: number
	regularMarketPreviousClose?: number
	regularMarketDayHigh?: number
	regularMarketDayLow?: number
	marketCap?: number
	fiftyTwoWeekHigh?: number
	fiftyTwoWeekLow?: number
}

// Yahoo Finance fundamentalsTimeSeries result shape
interface YFFundamentalsResult {
	date: Date
	periodType: string
	[key: string]: unknown
}

function mapSearchResults(quotes: YFSearchQuote[]): SearchResult[] {
	return quotes
		.filter((q) => q.isYahooFinance)
		.map((q) => ({
			symbol: q.symbol,
			name: q.longname ?? q.shortname ?? q.symbol,
			exchange: q.exchDisp ?? q.exchange,
			type: q.quoteType,
			source: SOURCE,
		}))
}

function mapQuote(q: YFQuote): QuoteResult {
	return {
		symbol: q.symbol,
		price: q.regularMarketPrice ?? 0,
		change: q.regularMarketChange ?? 0,
		changePercent: q.regularMarketChangePercent ?? 0,
		volume: q.regularMarketVolume,
		marketCap: q.marketCap,
		high52w: q.fiftyTwoWeekHigh,
		low52w: q.fiftyTwoWeekLow,
		open: q.regularMarketOpen,
		previousClose: q.regularMarketPreviousClose,
		dayHigh: q.regularMarketDayHigh,
		dayLow: q.regularMarketDayLow,
		source: SOURCE,
	}
}

function mapFinancials(
	results: YFFundamentalsResult[],
	period: 'annual' | 'quarterly',
): FinancialStatement[] {
	const periodType = period === 'annual' ? '12M' : '3M'
	return results
		.filter((r) => r.periodType === periodType)
		.map((r) => ({
			period: period === 'annual' ? 'annual' : 'quarterly',
			date: toDateString(r.date),
			revenue: toNum(r.totalRevenue),
			grossProfit: toNum(r.grossProfit),
			operatingIncome: toNum(r.operatingIncome),
			netIncome: toNum(r.netIncome),
			eps: toNum(r.basicEPS),
			epsDiluted: toNum(r.dilutedEPS),
			totalAssets: toNum(r.totalAssets),
			totalLiabilities: toNum(r.totalLiabilitiesNetMinorityInterest),
			stockholdersEquity: toNum(r.stockholdersEquity),
			operatingCashFlow: toNum(r.operatingCashFlow),
			longTermDebt: toNum(r.longTermDebt),
			sharesOutstanding: toNum(r.ordinarySharesNumber),
			source: SOURCE,
		}))
		.sort((a, b) => b.date.localeCompare(a.date))
}

function toDateString(v: unknown): string {
	if (v instanceof Date) return v.toISOString().split('T')[0]
	if (typeof v === 'number') return new Date(v * 1000).toISOString().split('T')[0]
	if (typeof v === 'string' && v.includes('T')) return v.split('T')[0]
	return String(v)
}

function toNum(v: unknown): number | undefined {
	if (typeof v === 'number' && !Number.isNaN(v)) return v
	return undefined
}

export const yahoo: Provider = {
	name: SOURCE,
	requiresKey: false,
	capabilities: ['search', 'quote', 'financials'] as DataCategory[],
	priority: { search: 3, quote: 1, financials: 2 },
	rateLimits: { maxRequests: 60, windowMs: 60_000 },

	isEnabled(): boolean {
		return true
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		if (!consumeToken(SOURCE, this.rateLimits)) {
			throw new Error(`[${SOURCE}] Rate limit exceeded`)
		}

		const key = `${category}/${action}`

		switch (key) {
			case 'search/search': {
				const query = args.query as string
				if (!query) throw new Error(`[${SOURCE}] search requires query`)

				try {
					const result = await yf.search(query)
					const data = mapSearchResults(result.quotes as unknown as YFSearchQuote[])
					return {
						data: data as T,
						source: SOURCE,
						cached: false,
					}
				} catch (err) {
					if (args.verbose) {
						console.error(`[${SOURCE}] search error:`, (err as Error).message)
					}
					throw err
				}
			}

			case 'quote/get': {
				const symbols = args.symbols as string[] | undefined
				const symbol = args.symbol as string | undefined

				if (!symbols && !symbol) {
					throw new Error(`[${SOURCE}] quote requires symbol or symbols`)
				}

				try {
					if (symbols && symbols.length > 0) {
						const results = await yf.quote(symbols)
						const data = (results as unknown as YFQuote[]).map(mapQuote)
						return {
							data: data as T,
							source: SOURCE,
							cached: false,
						}
					}

					// symbol is guaranteed non-null here (checked above)
					const sym = symbol as string
					const result = await yf.quote(sym)
					const data = mapQuote(result as unknown as YFQuote)
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) {
						console.error(`[${SOURCE}] quote error:`, (err as Error).message)
					}
					throw err
				}
			}

			case 'financials/get': {
				const symbol = args.symbol as string
				if (!symbol) {
					throw new Error(`[${SOURCE}] financials requires symbol`)
				}

				const period = (args.period as 'annual' | 'quarterly') ?? 'annual'
				const tsType = period === 'annual' ? 'annual' : 'quarterly'

				try {
					const fiveYearsAgo = new Date()
					fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5)

					const results = await yf.fundamentalsTimeSeries(
						symbol,
						{
							period1: fiveYearsAgo,
							type: tsType,
							module: 'all',
						},
						{ validateResult: false },
					)

					const data = mapFinancials(results as unknown as YFFundamentalsResult[], period)
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) {
						console.error(`[${SOURCE}] financials error:`, (err as Error).message)
					}
					throw err
				}
			}

			default:
				throw new Error(`[${SOURCE}] Unsupported operation: ${key}`)
		}
	},
}
