export type OutputFormat = 'markdown' | 'json' | 'plain'

export interface GlobalOptions {
	format: OutputFormat
	verbose: boolean
	source?: string
	noCache: boolean
}

export interface SearchResult {
	symbol: string
	name: string
	exchange?: string
	type?: string
	source: string
}

export interface QuoteResult {
	symbol: string
	price: number
	change: number
	changePercent: number
	volume?: number
	marketCap?: number
	high52w?: number
	low52w?: number
	open?: number
	previousClose?: number
	dayHigh?: number
	dayLow?: number
	source: string
}

export interface FinancialStatement {
	period: string
	date: string
	revenue?: number
	grossProfit?: number
	operatingIncome?: number
	netIncome?: number
	eps?: number
	epsDiluted?: number
	totalAssets?: number
	totalLiabilities?: number
	stockholdersEquity?: number
	operatingCashFlow?: number
	longTermDebt?: number
	sharesOutstanding?: number
	source: string
}

export interface Filing {
	accessionNumber: string
	form: string
	filingDate: string
	reportDate?: string
	primaryDocument?: string
	description?: string
	source: string
}

export interface InsiderTransaction {
	name: string
	title?: string
	transactionDate: string
	transactionType: string
	shares: number
	pricePerShare?: number
	totalValue?: number
	sharesOwned?: number
	description?: string
	accessionNumber?: string
	source: string
}

export interface HistoricalQuote {
	date: string
	open: number
	high: number
	low: number
	close: number
	adjClose?: number
	volume: number
}

export interface OptionContract {
	strike: number
	expiration: string
	type: 'call' | 'put'
	lastPrice?: number
	bid?: number
	ask?: number
	volume?: number
	openInterest?: number
	impliedVolatility?: number
}

export interface EarningsData {
	symbol: string
	earningsDate?: string
	epsEstimate?: number
	epsActual?: number
	revenueEstimate?: number
	revenueActual?: number
	source: string
}

export interface DividendEvent {
	date: string
	amount: number
	source: string
}

export interface MacroDataPoint {
	date: string
	value: number
}

export interface MacroSeries {
	id: string
	title: string
	units?: string
	frequency?: string
	seasonalAdjustment?: string
	data: MacroDataPoint[]
	source: string
}

export interface CryptoQuote {
	symbol: string
	name?: string
	price: number
	change24h?: number
	changePercent24h?: number
	volume24h?: number
	marketCap?: number
	marketCapRank?: number
	high24h?: number
	low24h?: number
	circulatingSupply?: number
	ath?: number
	source: string
}

export interface CryptoCandle {
	time: string
	open: number
	high: number
	low: number
	close: number
	volume: number
}

export interface SourceInfo {
	name: string
	enabled: boolean
	requiresKey: boolean
	keyConfigured: boolean
	categories: string[]
	rateLimit: string
	remaining?: string
}
