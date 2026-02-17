import YahooFinance from 'yahoo-finance2'
import { consumeToken } from '../core/rate-limiter.js'
import type {
	DividendEvent,
	EarningsData,
	FinancialStatement,
	HistoricalQuote,
	OptionContract,
	QuoteResult,
	SearchResult,
} from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const SOURCE = 'yahoo'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] })

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
	if (v == null) return ''
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
	capabilities: [
		'search',
		'quote',
		'financials',
		'history',
		'options',
		'earnings',
		'dividends',
	] as DataCategory[],
	priority: {
		search: 3,
		quote: 1,
		financials: 2,
		history: 1,
		options: 1,
		earnings: 1,
		dividends: 1,
	},
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
						const arr = results as unknown as YFQuote[]
						if (!arr || arr.length === 0) {
							throw new Error(
								`[${SOURCE}] No quote data returned for symbols: ${symbols.join(', ')}`,
							)
						}
						const data = arr.map(mapQuote)
						return {
							data: data as T,
							source: SOURCE,
							cached: false,
						}
					}

					// symbol is guaranteed non-null here (checked above)
					const sym = symbol as string
					const result = await yf.quote(sym)
					if (!result || !(result as unknown as YFQuote).symbol) {
						throw new Error(`[${SOURCE}] Symbol "${sym}" not found`)
					}
					const data = mapQuote(result as unknown as YFQuote)
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					const msg = (err as Error).message
					// Provide clearer error for common failures
					if (msg.includes('Cannot read properties') || msg.includes('undefined')) {
						const s = symbols?.join(', ') ?? symbol
						throw new Error(`[${SOURCE}] Symbol "${s}" not found or returned no data`)
					}
					if (args.verbose) {
						console.error(`[${SOURCE}] quote error:`, msg)
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

					const limit = (args.limit as number | undefined) ?? 10
					const data = mapFinancials(results as unknown as YFFundamentalsResult[], period).slice(
						0,
						limit,
					)
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) {
						console.error(`[${SOURCE}] financials error:`, (err as Error).message)
					}
					throw err
				}
			}

			case 'history/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] history requires symbol`)

				const days = (args.days as number) ?? 30
				const period1 = new Date()
				period1.setDate(period1.getDate() - days)

				try {
					const result = await yf.chart(symbol, { period1 })
					const raw = result as unknown as {
						quotes?: Array<{
							date: Date
							open: number
							high: number
							low: number
							close: number
							adjclose?: number
							volume: number
						}>
					}
					const data: HistoricalQuote[] = (raw.quotes ?? []).map((r) => ({
						date: toDateString(r.date),
						open: r.open,
						high: r.high,
						low: r.low,
						close: r.close,
						adjClose: r.adjclose,
						volume: r.volume,
					}))
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) console.error(`[${SOURCE}] history error:`, (err as Error).message)
					throw new Error(`[${SOURCE}] Could not fetch history for "${symbol}"`)
				}
			}

			case 'options/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] options requires symbol`)

				try {
					const result = await yf.options(symbol)
					const raw = result as unknown as {
						expirationDates?: Date[]
						options?: Array<{
							calls?: Array<{
								strike: number
								expiration: Date
								lastPrice?: number
								bid?: number
								ask?: number
								volume?: number
								openInterest?: number
								impliedVolatility?: number
							}>
							puts?: Array<{
								strike: number
								expiration: Date
								lastPrice?: number
								bid?: number
								ask?: number
								volume?: number
								openInterest?: number
								impliedVolatility?: number
							}>
						}>
					}
					const contracts: OptionContract[] = []
					for (const chain of raw.options ?? []) {
						for (const c of chain.calls ?? []) {
							contracts.push({
								strike: c.strike,
								expiration: toDateString(c.expiration),
								type: 'call',
								lastPrice: c.lastPrice,
								bid: c.bid,
								ask: c.ask,
								volume: c.volume,
								openInterest: c.openInterest,
								impliedVolatility: c.impliedVolatility,
							})
						}
						for (const p of chain.puts ?? []) {
							contracts.push({
								strike: p.strike,
								expiration: toDateString(p.expiration),
								type: 'put',
								lastPrice: p.lastPrice,
								bid: p.bid,
								ask: p.ask,
								volume: p.volume,
								openInterest: p.openInterest,
								impliedVolatility: p.impliedVolatility,
							})
						}
					}
					return { data: contracts as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) console.error(`[${SOURCE}] options error:`, (err as Error).message)
					throw new Error(`[${SOURCE}] Could not fetch options for "${symbol}"`)
				}
			}

			case 'earnings/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] earnings requires symbol`)

				try {
					const result = await yf.quoteSummary(symbol, { modules: ['earnings', 'calendarEvents'] })
					const raw = result as unknown as {
						earnings?: {
							earningsChart?: {
								quarterly?: Array<{ date: string; actual?: number; estimate?: number }>
							}
						}
						calendarEvents?: {
							earnings?: {
								earningsDate?: Date[]
								earningsAverage?: number
								revenueAverage?: number
							}
						}
					}

					const quarterly = raw.earnings?.earningsChart?.quarterly ?? []
					const nextDate = raw.calendarEvents?.earnings?.earningsDate?.[0]
					const nextEstimate = raw.calendarEvents?.earnings?.earningsAverage

					const data: EarningsData[] = quarterly.map((q) => ({
						symbol,
						earningsDate: q.date,
						epsActual: q.actual,
						epsEstimate: q.estimate,
						source: SOURCE,
					}))

					if (nextDate) {
						data.unshift({
							symbol,
							earningsDate: toDateString(nextDate),
							epsEstimate: nextEstimate,
							source: SOURCE,
						})
					}

					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) console.error(`[${SOURCE}] earnings error:`, (err as Error).message)
					throw new Error(`[${SOURCE}] Could not fetch earnings for "${symbol}"`)
				}
			}

			case 'dividends/get': {
				const symbol = args.symbol as string
				if (!symbol) throw new Error(`[${SOURCE}] dividends requires symbol`)

				try {
					const result = await yf.chart(symbol, {
						period1: new Date(new Date().setFullYear(new Date().getFullYear() - 5)),
						events: 'dividends',
					})
					const raw = result as unknown as {
						events?: {
							dividends?: Record<string, { date: Date; amount: number }>
						}
					}
					const dividends = raw.events?.dividends ?? {}
					const data: DividendEvent[] = Object.values(dividends)
						.map((d) => ({
							date: toDateString(d.date),
							amount: d.amount,
							source: SOURCE,
						}))
						.sort((a, b) => b.date.localeCompare(a.date))
					return { data: data as T, source: SOURCE, cached: false }
				} catch (err) {
					if (args.verbose) console.error(`[${SOURCE}] dividends error:`, (err as Error).message)
					throw new Error(`[${SOURCE}] Could not fetch dividends for "${symbol}"`)
				}
			}

			default:
				throw new Error(`[${SOURCE}] Unsupported operation: ${key}`)
		}
	},
}
