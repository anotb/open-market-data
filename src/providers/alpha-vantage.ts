import { loadConfig } from '../core/config.js'
import { fetchWithTimeout } from '../core/http.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { FinancialStatement, HistoricalQuote, QuoteResult, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const SOURCE = 'alphavantage'
const BASE_URL = 'https://www.alphavantage.co/query'

function getApiKey(): string {
	const key = loadConfig().alphaVantageApiKey
	if (!key) {
		throw new Error(
			`[${SOURCE}] ALPHA_VANTAGE_API_KEY not set. Run: omd config set alphaVantageApiKey <key>`,
		)
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

	const response = await fetchWithTimeout(url)

	if (!response.ok) {
		throw new Error(`[${SOURCE}] HTTP ${response.status}: ${response.statusText}`)
	}

	const data = (await response.json()) as Record<string, unknown>

	// Alpha Vantage returns HTTP 200 with errors in the response body.
	if (data['Error Message']) {
		throw new Error(`[${SOURCE}] ${boundedMessage(data['Error Message'])}`)
	}
	if (data.Note) {
		throw new Error(`[${SOURCE}] ${boundedMessage(data.Note)}`)
	}
	if (data.Information) {
		throw new Error(`[${SOURCE}] ${boundedMessage(data.Information)}`)
	}

	return data as T
}

function boundedMessage(value: unknown): string {
	const compact = String(value).replace(/\s+/g, ' ').trim() || 'Unknown provider error'
	return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}

function toNum(value: unknown): number | undefined {
	if (value == null || value === '' || value === 'None') return undefined
	const number = Number(value)
	return Number.isNaN(number) ? undefined : number
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

async function searchSymbols(
	args: Record<string, unknown>,
): Promise<ProviderResult<SearchResult[]>> {
	const query = args.query as string
	if (!query) throw new Error(`[${SOURCE}] search requires query`)

	const data = await avFetch<{ bestMatches: AVSearchMatch[] }>({
		function: 'SYMBOL_SEARCH',
		keywords: query,
	})

	const results: SearchResult[] = (data.bestMatches ?? []).map((match) => ({
		symbol: match['1. symbol'],
		name: match['2. name'],
		exchange: match['4. region'],
		type: match['3. type'],
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

	const quote = data['Global Quote']
	if (!quote || !quote['01. symbol']) {
		throw new Error(`[${SOURCE}] No quote data returned for "${symbol}"`)
	}

	const changePercentRaw = quote['10. change percent'] ?? '0'
	const changePercent = Number(changePercentRaw.replace('%', ''))

	const result: QuoteResult = {
		symbol: quote['01. symbol'],
		price: toNum(quote['05. price']) ?? 0,
		change: toNum(quote['09. change']) ?? 0,
		changePercent: Number.isNaN(changePercent) ? 0 : changePercent,
		volume: toNum(quote['06. volume']),
		open: toNum(quote['02. open']),
		previousClose: toNum(quote['08. previous close']),
		dayHigh: toNum(quote['03. high']),
		dayLow: toNum(quote['04. low']),
		source: SOURCE,
	}

	return { data: result, source: SOURCE, cached: false }
}

async function getFinancials(
	args: Record<string, unknown>,
): Promise<ProviderResult<FinancialStatement[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error(`[${SOURCE}] financials requires symbol`)

	const period = (args.period as 'annual' | 'quarterly') ?? 'annual'
	const reportKey = period === 'annual' ? 'annualReports' : 'quarterlyReports'
	const requestedLimit = Number(args.limit ?? 5)
	const limit = Number.isFinite(requestedLimit)
		? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
		: 5

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

	const balanceByDate = new Map<string, AVBalanceReport>()
	for (const balance of balanceReports) {
		balanceByDate.set(balance.fiscalDateEnding, balance)
	}

	const statements: FinancialStatement[] = incomeReports.slice(0, limit).map((income) => {
		const balance = balanceByDate.get(income.fiscalDateEnding)
		return {
			period,
			date: income.fiscalDateEnding,
			revenue: toNum(income.totalRevenue),
			grossProfit: toNum(income.grossProfit),
			operatingIncome: toNum(income.operatingIncome),
			netIncome: toNum(income.netIncome),
			operatingCashFlow: toNum(income.operatingCashflow),
			totalAssets: toNum(balance?.totalAssets),
			totalLiabilities: toNum(balance?.totalLiabilities),
			stockholdersEquity: toNum(balance?.totalShareholderEquity),
			longTermDebt: toNum(balance?.longTermDebt),
			sharesOutstanding: toNum(balance?.commonStockSharesOutstanding),
			source: SOURCE,
		}
	})

	return { data: statements, source: SOURCE, cached: false }
}

async function getHistory(
	args: Record<string, unknown>,
): Promise<ProviderResult<HistoricalQuote[]>> {
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
		return !!loadConfig().alphaVantageApiKey
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
