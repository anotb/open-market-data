import { consumeToken } from '../core/rate-limiter.js'
import type { FinancialStatement, HistoricalQuote, QuoteResult, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const SOURCE = 'alphavantage'
const BASE_URL = 'https://www.alphavantage.co/query'

function getApiKey(): string {
	const key = process.env.ALPHA_VANTAGE_API_KEY
	if (!key) {
		throw new Error(`[${SOURCE}] ALPHA_VANTAGE_API_KEY not set`)
	}
	return key
}

async function avFetch<T>(params: Record<string, string>): Promise<T> {
	if (!consumeToken(SOURCE, alphaVantage.rateLimits)) {
		throw new Error(`[${SOURCE}] Rate limit exceeded`)
	}

	const url = new URL(BASE_URL)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	url.searchParams.set('apikey', getApiKey())

	const response = await fetch(url.toString())

	if (!response.ok) {
		throw new Error(`[${SOURCE}] HTTP ${response.status}: ${response.statusText}`)
	}

	const data = (await response.json()) as Record<string, unknown>

	// Alpha Vantage returns 200 with error in the body
	if (data['Error Message']) {
		throw new Error(`[${SOURCE}] ${data['Error Message'] as string}`)
	}
	if (data['Note']) {
		throw new Error(`[${SOURCE}] ${data['Note'] as string}`)
	}
	if (data['Information']) {
		throw new Error(`[${SOURCE}] ${data['Information'] as string}`)
	}

	return data as T
}

function toNum(v: unknown): number | undefined {
	if (v == null || v === '' || v === 'None') return undefined
	const n = Number(v)
	return Number.isNaN(n) ? undefined : n
}

interface AVSearchMatch {
	'1. symbol': string
	'2. name': string
	'3. type': string
	'4. region': string
	'8. currency': string
}

interface AVGlobalQuote {
	'01. symbol': string
	'02. open': string
	'03. high': string
	'04. low': string
	'05. price': string
	'06. volume': string
	'07. latest trading day': string
	'08. previous close': string
	'09. change': string
	'10. change percent': string
}

interface AVIncomeReport {
	fiscalDateEnding: string
	totalRevenue: string
	grossProfit: string
	operatingIncome: string
	netIncome: string
	operatingCashflow?: string
}

interface AVBalanceReport {
	fiscalDateEnding: string
	totalAssets: string
	totalLiabilities: string
	totalShareholderEquity: string
	longTermDebt: string
	commonStockSharesOutstanding: string
}

interface AVTimeSeries {
	'1. open': string
	'2. high': string
	'3. low': string
	'4. close': string
	'5. volume': string
}

async function searchSymbols(args: Record<string, unknown>): Promise<ProviderResult<SearchResult[]>> {
	const query = args.query as string
	if (!query) throw new Error(`[${SOURCE}] search requires query`)

	const data = await avFetch<{ bestMatches: AVSearchMatch[] }>({
		function: 'SYMBOL_SEARCH',
		keywords: query,
	})

	const results: SearchResult[] = (data.bestMatches ?? []).map((m) => ({
		symbol: m['1. symbol'],
		name: m['2. name'],
		exchange: m['4. region'],
		type: m['3. type'],
		source: SOURCE,
	}))

	return { data: results, source: SOURCE, cached: false }
}

async function getQuote(args: Record<string, unknown>): Promise<ProviderResult<QuoteResult>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error(`[${SOURCE}] quote requires symbol`)

	const data = await avFetch<{ 'Global Quote': AVGlobalQuote }>({
		function: 'GLOBAL_QUOTE',
		symbol,
	})

	const q = data['Global Quote']
	if (!q || !q['01. symbol']) {
		throw new Error(`[${SOURCE}] No quote data returned for "${symbol}"`)
	}

	const changePercentRaw = q['10. change percent'] ?? '0'
	const changePercent = Number(changePercentRaw.replace('%', ''))

	const result: QuoteResult = {
		symbol: q['01. symbol'],
		price: toNum(q['05. price']) ?? 0,
		change: toNum(q['09. change']) ?? 0,
		changePercent: Number.isNaN(changePercent) ? 0 : changePercent,
		volume: toNum(q['06. volume']),
		open: toNum(q['02. open']),
		previousClose: toNum(q['08. previous close']),
		dayHigh: toNum(q['03. high']),
		dayLow: toNum(q['04. low']),
		source: SOURCE,
	}

	return { data: result, source: SOURCE, cached: false }
}

async function getFinancials(args: Record<string, unknown>): Promise<ProviderResult<FinancialStatement[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error(`[${SOURCE}] financials requires symbol`)

	const period = (args.period as 'annual' | 'quarterly') ?? 'annual'
	const reportKey = period === 'annual' ? 'annualReports' : 'quarterlyReports'

	const [incomeData, balanceData] = await Promise.all([
		avFetch<Record<string, AVIncomeReport[]>>({
			function: 'INCOME_STATEMENT',
			symbol,
		}),
		avFetch<Record<string, AVBalanceReport[]>>({
			function: 'BALANCE_SHEET',
			symbol,
		}),
	])

	const incomeReports: AVIncomeReport[] = incomeData[reportKey] ?? []
	const balanceReports: AVBalanceReport[] = balanceData[reportKey] ?? []

	// Index balance sheet by date for quick lookup
	const balanceByDate = new Map<string, AVBalanceReport>()
	for (const b of balanceReports) {
		balanceByDate.set(b.fiscalDateEnding, b)
	}

	const statements: FinancialStatement[] = incomeReports.slice(0, 5).map((inc) => {
		const bal = balanceByDate.get(inc.fiscalDateEnding)
		return {
			period,
			date: inc.fiscalDateEnding,
			revenue: toNum(inc.totalRevenue),
			grossProfit: toNum(inc.grossProfit),
			operatingIncome: toNum(inc.operatingIncome),
			netIncome: toNum(inc.netIncome),
			operatingCashFlow: toNum(inc.operatingCashflow),
			totalAssets: toNum(bal?.totalAssets),
			totalLiabilities: toNum(bal?.totalLiabilities),
			stockholdersEquity: toNum(bal?.totalShareholderEquity),
			longTermDebt: toNum(bal?.longTermDebt),
			sharesOutstanding: toNum(bal?.commonStockSharesOutstanding),
			source: SOURCE,
		}
	})

	return { data: statements, source: SOURCE, cached: false }
}

async function getHistory(args: Record<string, unknown>): Promise<ProviderResult<HistoricalQuote[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error(`[${SOURCE}] history requires symbol`)

	const days = (args.days as number) ?? 30
	const outputsize = days > 100 ? 'full' : 'compact'

	const data = await avFetch<{ 'Time Series (Daily)': Record<string, AVTimeSeries> }>({
		function: 'TIME_SERIES_DAILY',
		symbol,
		outputsize,
	})

	const timeSeries = data['Time Series (Daily)']
	if (!timeSeries) {
		throw new Error(`[${SOURCE}] No history data returned for "${symbol}"`)
	}

	const quotes: HistoricalQuote[] = Object.entries(timeSeries)
		.map(([date, bar]) => ({
			date,
			open: toNum(bar['1. open']) ?? 0,
			high: toNum(bar['2. high']) ?? 0,
			low: toNum(bar['3. low']) ?? 0,
			close: toNum(bar['4. close']) ?? 0,
			volume: toNum(bar['5. volume']) ?? 0,
		}))
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, days)

	return { data: quotes, source: SOURCE, cached: false }
}

export const alphaVantage: Provider = {
	name: SOURCE,
	requiresKey: true,
	keyEnvVar: 'ALPHA_VANTAGE_API_KEY',
	capabilities: ['search', 'quote', 'financials', 'history'] as DataCategory[],
	priority: { search: 6, quote: 5, financials: 4, history: 4 },
	rateLimits: { maxRequests: 25, windowMs: 86_400_000 },

	isEnabled(): boolean {
		return !!process.env.ALPHA_VANTAGE_API_KEY
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		const key = `${category}/${action}`

		switch (key) {
			case 'search/search':
				return searchSymbols(args) as Promise<ProviderResult<T>>

			case 'quote/get':
				return getQuote(args) as Promise<ProviderResult<T>>

			case 'financials/get':
				return getFinancials(args) as Promise<ProviderResult<T>>

			case 'history/get':
				return getHistory(args) as Promise<ProviderResult<T>>

			default:
				throw new Error(`[${SOURCE}] Unsupported operation: ${key}`)
		}
	},
}
