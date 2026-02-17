import { loadConfig } from '../core/config.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { Filing, FinancialStatement, InsiderTransaction, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from './types.js'

const SEARCH_BASE = 'https://efts.sec.gov'
const DATA_BASE = 'https://data.sec.gov'
const DEFAULT_USER_AGENT = 'open-market-data/0.1.0 (dev@open-market-data.dev)'
let userAgentWarned = false

// --- Ticker map cache ---

interface TickerEntry {
	cik: number
	name: string
}

let tickerMap: Map<string, TickerEntry> | null = null

function getUserAgent(): string {
	const config = loadConfig()
	if (!config.edgarUserAgent && !userAgentWarned) {
		userAgentWarned = true
		console.error(
			'[sec-edgar] Warning: Using default User-Agent. Set EDGAR_USER_AGENT env var or run: omd config set edgarUserAgent "YourApp/1.0 (your@email.com)"',
		)
	}
	return config.edgarUserAgent ?? DEFAULT_USER_AGENT
}

function padCik(cik: number): string {
	return `CIK${String(cik).padStart(10, '0')}`
}

async function fetchWithAgent(url: string, rateLimits: RateLimitConfig): Promise<Response> {
	if (!consumeToken('sec-edgar', rateLimits)) {
		throw new Error('SEC EDGAR rate limit exceeded — max 10 requests/second')
	}
	return fetch(url, {
		headers: {
			'User-Agent': getUserAgent(),
			Accept: 'application/json',
		},
	})
}

async function loadTickerMap(rateLimits: RateLimitConfig): Promise<Map<string, TickerEntry>> {
	if (tickerMap) return tickerMap

	const res = await fetchWithAgent('https://www.sec.gov/files/company_tickers.json', rateLimits)
	if (!res.ok) {
		throw new Error(`Failed to load company tickers: ${res.status} ${res.statusText}`)
	}

	const data = (await res.json()) as Record<
		string,
		{ cik_str: number; ticker: string; title: string }
	>

	tickerMap = new Map<string, TickerEntry>()
	for (const entry of Object.values(data)) {
		tickerMap.set(entry.ticker.toUpperCase(), {
			cik: entry.cik_str,
			name: entry.title,
		})
	}

	return tickerMap
}

function lookupTicker(map: Map<string, TickerEntry>, symbol: string): TickerEntry {
	const entry = map.get(symbol.toUpperCase())
	if (!entry) {
		throw new Error(`Ticker "${symbol}" not found in SEC EDGAR database`)
	}
	return entry
}

// --- XBRL fact extraction helpers ---

interface XbrlUnit {
	end: string
	val: number
	form: string
	fp: string
	fy: number
	filed: string
}

interface XbrlConcept {
	units: Record<string, XbrlUnit[]>
}

interface XbrlFacts {
	'us-gaap'?: Record<string, XbrlConcept>
}

interface CompanyFactsResponse {
	facts: XbrlFacts
}

function groupFactsByPeriod(
	facts: Record<string, XbrlConcept> | undefined,
	formFilter: string,
): Map<string, Map<string, number>> {
	// Groups fact values by period key (fp + fy), e.g. "FY2023" or "Q1-2024"
	const periods = new Map<string, Map<string, number>>()
	if (!facts) return periods

	const tags = [
		'Revenues',
		'RevenueFromContractWithCustomerExcludingAssessedTax',
		'GrossProfit',
		'OperatingIncomeLoss',
		'NetIncomeLoss',
		'EarningsPerShareBasic',
		'EarningsPerShareDiluted',
		'Assets',
		'Liabilities',
		'LiabilitiesCurrent',
		'LiabilitiesNoncurrent',
		'StockholdersEquity',
		'NetCashProvidedByOperatingActivities',
		'LongTermDebt',
		'LongTermDebtNoncurrent',
		'CommonStockSharesOutstanding',
	]

	for (const tag of tags) {
		const concept = facts[tag]
		if (!concept) continue

		const unitEntries =
			concept.units.USD ??
			concept.units['USD/shares'] ??
			concept.units.shares ??
			Object.values(concept.units)[0]

		if (!unitEntries) continue

		for (const unit of unitEntries) {
			if (unit.form !== formFilter) continue
			const periodKey = `${unit.fp}-${unit.fy}`

			let periodFacts = periods.get(periodKey)
			if (!periodFacts) {
				periodFacts = new Map<string, number>()
				periods.set(periodKey, periodFacts)
			}

			// Store the value; later entries (by filing date) overwrite earlier (restated)
			periodFacts.set(tag, unit.val)
			// Also store the end date for sorting
			periodFacts.set('_date', new Date(unit.end).getTime())
		}
	}

	return periods
}

function buildFinancialStatement(
	periodKey: string,
	facts: Map<string, number>,
): FinancialStatement {
	const dateMs = facts.get('_date')
	const date = dateMs ? new Date(dateMs).toISOString().split('T')[0] : 'unknown'

	const revenue =
		facts.get('Revenues') ?? facts.get('RevenueFromContractWithCustomerExcludingAssessedTax')
	const totalLiabilities =
		facts.get('Liabilities') ??
		sumOptional(facts.get('LiabilitiesCurrent'), facts.get('LiabilitiesNoncurrent'))
	const longTermDebt = facts.get('LongTermDebt') ?? facts.get('LongTermDebtNoncurrent')

	return {
		period: periodKey,
		date,
		...(revenue != null && { revenue }),
		...(facts.has('GrossProfit') && { grossProfit: facts.get('GrossProfit') }),
		...(facts.has('OperatingIncomeLoss') && { operatingIncome: facts.get('OperatingIncomeLoss') }),
		...(facts.has('NetIncomeLoss') && { netIncome: facts.get('NetIncomeLoss') }),
		...(facts.has('EarningsPerShareBasic') && { eps: facts.get('EarningsPerShareBasic') }),
		...(facts.has('EarningsPerShareDiluted') && {
			epsDiluted: facts.get('EarningsPerShareDiluted'),
		}),
		...(facts.has('Assets') && { totalAssets: facts.get('Assets') }),
		...(totalLiabilities != null && { totalLiabilities }),
		...(facts.has('StockholdersEquity') && { stockholdersEquity: facts.get('StockholdersEquity') }),
		...(facts.has('NetCashProvidedByOperatingActivities') && {
			operatingCashFlow: facts.get('NetCashProvidedByOperatingActivities'),
		}),
		...(longTermDebt != null && { longTermDebt }),
		...(facts.has('CommonStockSharesOutstanding') && {
			sharesOutstanding: facts.get('CommonStockSharesOutstanding'),
		}),
		source: 'sec-edgar',
	}
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
	if (a == null && b == null) return undefined
	return (a ?? 0) + (b ?? 0)
}

// --- Search implementation ---

interface EdgarSearchHit {
	file_num?: string
	film_num?: string
	_id: string
	entity_name?: string
	file_date?: string
	period_of_report?: string
	form_type?: string
	display_names?: string[]
	file_description?: string
}

interface EdgarSearchResponse {
	hits?: {
		hits?: EdgarSearchHit[]
	}
}

async function executeSearch(
	args: Record<string, unknown>,
	rateLimits: RateLimitConfig,
): Promise<ProviderResult<SearchResult[]>> {
	const query = (args.query as string) ?? ''
	const map = await loadTickerMap(rateLimits)

	const results: SearchResult[] = []

	// Search ticker map first for matching tickers/names
	for (const [ticker, entry] of map) {
		if (
			ticker.includes(query.toUpperCase()) ||
			entry.name.toUpperCase().includes(query.toUpperCase())
		) {
			results.push({
				symbol: ticker,
				name: entry.name,
				type: 'equity',
				source: 'sec-edgar',
			})
			if (results.length >= 10) break
		}
	}

	// Also search EDGAR full-text
	const params = new URLSearchParams({ q: query })
	if (args.startDate) params.set('startdt', args.startDate as string)
	if (args.endDate) params.set('enddt', args.endDate as string)
	if (args.forms) params.set('forms', args.forms as string)

	const url = `${SEARCH_BASE}/LATEST/search-index?${params}`
	const res = await fetchWithAgent(url, rateLimits)

	if (res.ok) {
		const data = (await res.json()) as EdgarSearchResponse
		const hits = data.hits?.hits ?? []
		for (const hit of hits.slice(0, 10)) {
			const entityName = hit.entity_name ?? 'Unknown'
			// Avoid duplicates from ticker map
			if (!results.some((r) => r.name === entityName)) {
				results.push({
					symbol: hit.file_num ?? '',
					name: entityName,
					type: hit.form_type ?? 'filing',
					source: 'sec-edgar',
				})
			}
		}
	}

	return { data: results, source: 'sec-edgar', cached: false }
}

// --- Financials implementation ---

async function executeFinancials(
	args: Record<string, unknown>,
	rateLimits: RateLimitConfig,
): Promise<ProviderResult<FinancialStatement[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error('symbol is required for financials')

	const period = (args.period as string) ?? 'annual'
	const formFilter = period === 'quarterly' ? '10-Q' : '10-K'

	const map = await loadTickerMap(rateLimits)
	const { cik } = lookupTicker(map, symbol)
	const paddedCik = padCik(cik)

	const url = `${DATA_BASE}/api/xbrl/companyfacts/${paddedCik}.json`
	const res = await fetchWithAgent(url, rateLimits)

	if (!res.ok) {
		throw new Error(`Failed to fetch company facts: ${res.status} ${res.statusText}`)
	}

	const body = (await res.json()) as CompanyFactsResponse
	const usGaap = body.facts['us-gaap']
	const periodGroups = groupFactsByPeriod(usGaap, formFilter)

	const statements: FinancialStatement[] = []
	for (const [periodKey, facts] of periodGroups) {
		statements.push(buildFinancialStatement(periodKey, facts))
	}

	// Sort by date descending
	statements.sort((a, b) => (b.date > a.date ? 1 : a.date > b.date ? -1 : 0))

	return {
		data: statements.slice(0, 10),
		source: 'sec-edgar',
		cached: false,
	}
}

// --- Filing list implementation ---

interface SubmissionsRecent {
	accessionNumber: string[]
	filingDate: string[]
	reportDate: string[]
	form: string[]
	primaryDocument: string[]
	primaryDocDescription: string[]
}

interface SubmissionsResponse {
	filings?: {
		recent?: SubmissionsRecent
	}
}

async function executeFilingList(
	args: Record<string, unknown>,
	rateLimits: RateLimitConfig,
): Promise<ProviderResult<Filing[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error('symbol is required for filing/list')

	const formType = args.type as string | undefined
	const latest = args.latest as boolean | undefined

	const map = await loadTickerMap(rateLimits)
	const { cik } = lookupTicker(map, symbol)
	const paddedCik = padCik(cik)

	const url = `${DATA_BASE}/submissions/${paddedCik}.json`
	const res = await fetchWithAgent(url, rateLimits)

	if (!res.ok) {
		throw new Error(`Failed to fetch submissions: ${res.status} ${res.statusText}`)
	}

	const body = (await res.json()) as SubmissionsResponse
	const recent = body.filings?.recent

	if (!recent) {
		return { data: [], source: 'sec-edgar', cached: false }
	}

	const filings: Filing[] = []
	const count = recent.accessionNumber.length

	for (let i = 0; i < count; i++) {
		const form = recent.form[i]

		if (formType && form !== formType) continue

		filings.push({
			accessionNumber: recent.accessionNumber[i],
			form,
			filingDate: recent.filingDate[i],
			reportDate: recent.reportDate[i] || undefined,
			primaryDocument: recent.primaryDocument[i] || undefined,
			description: recent.primaryDocDescription[i] || undefined,
			source: 'sec-edgar',
		})

		if (latest && filings.length >= 1) break
		const maxResults = (args.limit as number | undefined) ?? 20
		if (filings.length >= maxResults) break
	}

	return { data: filings, source: 'sec-edgar', cached: false }
}

// --- Insiders implementation ---

async function executeInsiders(
	args: Record<string, unknown>,
	rateLimits: RateLimitConfig,
): Promise<ProviderResult<InsiderTransaction[]>> {
	const symbol = args.symbol as string
	if (!symbol) throw new Error('symbol is required for insiders/list')

	const map = await loadTickerMap(rateLimits)
	const { name: companyName } = lookupTicker(map, symbol)

	// Search for Form 4 filings via EDGAR full-text search
	const params = new URLSearchParams({
		q: '',
		forms: '4',
		entityName: companyName,
	})

	const url = `${SEARCH_BASE}/LATEST/search-index?${params}`
	const res = await fetchWithAgent(url, rateLimits)

	const transactions: InsiderTransaction[] = []

	if (res.ok) {
		const data = (await res.json()) as EdgarSearchResponse
		const hits = data.hits?.hits ?? []

		for (const hit of hits.slice(0, 20)) {
			const displayName = hit.display_names?.[0] ?? hit.entity_name ?? 'Unknown'
			transactions.push({
				name: displayName,
				transactionDate: hit.file_date ?? 'unknown',
				transactionType: 'Form 4',
				shares: 0, // Not available from search results
				source: 'sec-edgar',
			})
		}
	}

	return { data: transactions, source: 'sec-edgar', cached: false }
}

// --- Provider definition ---

export const secEdgar: Provider = {
	name: 'sec-edgar',
	requiresKey: false,
	capabilities: ['search', 'financials', 'filing', 'insiders'],
	priority: { search: 2, financials: 1, filing: 1, insiders: 1 },
	rateLimits: { maxRequests: 10, windowMs: 1000 },

	isEnabled(): boolean {
		return true
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		const key = `${category}/${action}`

		switch (key) {
			case 'search/search':
				return (await executeSearch(args, this.rateLimits)) as ProviderResult<T>
			case 'financials/get':
				return (await executeFinancials(args, this.rateLimits)) as ProviderResult<T>
			case 'filing/list':
				return (await executeFilingList(args, this.rateLimits)) as ProviderResult<T>
			case 'insiders/list':
				return (await executeInsiders(args, this.rateLimits)) as ProviderResult<T>
			default:
				throw new Error(`SEC EDGAR does not support ${key}`)
		}
	},
}
