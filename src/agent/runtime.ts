import { type ProviderHealthResult, checkProviderHealth } from '../core/health.js'
import { type RouteOptions, getProviders, route } from '../core/router.js'
import { registerAllProviders } from '../providers/registry.js'
import type { DataCategory, Provider, ProviderResult } from '../providers/types.js'
import type {
	CryptoCandle,
	CryptoQuote,
	DividendEvent,
	EarningsData,
	Filing,
	FinancialStatement,
	HistoricalQuote,
	InsiderTransaction,
	MacroSeries,
	OptionContract,
	QuoteResult,
	SearchResult,
} from '../types.js'
import {
	type AgentToolDefinition,
	type AgentToolInputMap,
	type AgentToolName,
	getAgentTool,
	listAgentTools,
	validateAgentToolInput,
} from './catalog.js'

export interface AgentToolErrorDetail {
	component: string
	message: string
}

export interface AgentResultMeta {
	tool: AgentToolName
	retrievedAt: string
	request: Record<string, unknown>
	source?: string
	sources?: string[]
	cached?: boolean
	partial?: boolean
	warnings?: string[]
	errors?: AgentToolErrorDetail[]
}

export interface AgentToolResponse<T = unknown> {
	data: T
	meta: AgentResultMeta
}

export interface SnapshotPerformance {
	startDate: string
	endDate: string
	startClose: number
	endClose: number
	absoluteChange: number
	percentChange: number
	observations: number
}

export interface CompanySnapshot {
	symbol: string
	quote: QuoteResult | null
	recentHistory: HistoricalQuote[] | null
	performance?: SnapshotPerformance
	financials: FinancialStatement[] | null
	earnings: EarningsData[] | null
	filings: Filing[] | null
}

export interface MacroSearchResult {
	id: string
	title: string
	units?: string
	frequency?: string
	seasonalAdjustment?: string
	popularity?: number
}

export interface ProviderStatus {
	name: string
	enabled: boolean
	requiresKey: boolean
	keyEnvVar?: string
	capabilities: DataCategory[]
	priority: Partial<Record<DataCategory, number>>
	rateLimit: {
		maxRequests: number
		windowMs: number
	}
}

export interface AgentToolOutputMap {
	market_search: SearchResult[]
	company_snapshot: CompanySnapshot
	stock_quotes: QuoteResult[]
	stock_financials: FinancialStatement[]
	stock_history: HistoricalQuote[]
	stock_options: OptionContract[]
	stock_earnings: EarningsData[]
	stock_dividends: DividendEvent[]
	sec_filings: Filing[]
	sec_insider_transactions: InsiderTransaction[]
	crypto_quote: CryptoQuote
	crypto_top: CryptoQuote[]
	crypto_history: CryptoCandle[]
	macro_series: MacroSeries
	macro_search: MacroSearchResult[]
	provider_status: ProviderStatus[]
	provider_health: ProviderHealthResult[]
}

export interface AgentRuntime {
	route<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
		options?: RouteOptions,
	): Promise<ProviderResult<T>>
	getProviders(): Provider[]
	ensureProviders(): void
	now(): Date
}

export interface AgentExecutor {
	listTools(): readonly AgentToolDefinition[]
	execute<Name extends AgentToolName>(
		name: Name,
		input: AgentToolInputMap[Name],
	): Promise<AgentToolResponse<AgentToolOutputMap[Name]>>
	execute(name: string, input?: unknown): Promise<AgentToolResponse>
}

let defaultProvidersRegistered = false

export function ensureProvidersRegistered(): void {
	if (!defaultProvidersRegistered || getProviders().length === 0) {
		registerAllProviders()
		defaultProvidersRegistered = true
	}
}

export const defaultAgentRuntime: AgentRuntime = {
	route,
	getProviders,
	ensureProviders: ensureProvidersRegistered,
	now: () => new Date(),
}

export function createAgentExecutor(runtime: AgentRuntime = defaultAgentRuntime): AgentExecutor {
	const execute = async (name: string, rawInput: unknown = {}): Promise<AgentToolResponse> => {
		const tool = getAgentTool(name)
		if (!tool) throw new Error(`Unknown agent tool "${name}"`)

		const input = validateAgentToolInput(name, rawInput)
		runtime.ensureProviders()
		return executeValidated(runtime, tool.name, input)
	}

	return {
		listTools: listAgentTools,
		execute: execute as AgentExecutor['execute'],
	}
}

const defaultExecutor = createAgentExecutor()

export function executeAgentTool<Name extends AgentToolName>(
	name: Name,
	input: AgentToolInputMap[Name],
): Promise<AgentToolResponse<AgentToolOutputMap[Name]>>
export function executeAgentTool(name: string, input?: unknown): Promise<AgentToolResponse>
export function executeAgentTool(name: string, input?: unknown): Promise<AgentToolResponse> {
	return defaultExecutor.execute(name, input)
}

async function executeValidated(
	runtime: AgentRuntime,
	name: AgentToolName,
	input: Record<string, unknown>,
): Promise<AgentToolResponse> {
	switch (name) {
		case 'market_search':
			return executeMarketSearch(runtime, input)
		case 'company_snapshot':
			return executeCompanySnapshot(runtime, input)
		case 'stock_quotes':
			return executeStockQuotes(runtime, input)
		case 'stock_financials':
			return executeStockFinancials(runtime, input)
		case 'stock_history':
			return executeStockHistory(runtime, input)
		case 'stock_options':
			return executeStockOptions(runtime, input)
		case 'stock_earnings':
			return executeLimitedArray<EarningsData>(
				runtime,
				name,
				'earnings',
				'get',
				{ symbol: symbol(input) },
				input,
				optionalInteger(input, 'limit') ?? 8,
			)
		case 'stock_dividends':
			return executeLimitedArray<DividendEvent>(
				runtime,
				name,
				'dividends',
				'get',
				{ symbol: symbol(input) },
				input,
				optionalInteger(input, 'limit') ?? 20,
			)
		case 'sec_filings':
			return executeSecFilings(runtime, input)
		case 'sec_insider_transactions':
			return executeLimitedArray<InsiderTransaction>(
				runtime,
				name,
				'insiders',
				'list',
				{
					symbol: symbol(input),
					limit: optionalInteger(input, 'limit') ?? 20,
				},
				input,
				optionalInteger(input, 'limit') ?? 20,
			)
		case 'crypto_quote':
			return executeRouted<CryptoQuote>(
				runtime,
				name,
				'crypto',
				'quote',
				{
					symbol: symbol(input),
				},
				input,
			)
		case 'crypto_top':
			return executeCryptoTop(runtime, input)
		case 'crypto_history':
			return executeCryptoHistory(runtime, input)
		case 'macro_series':
			return executeMacroSeries(runtime, input)
		case 'macro_search':
			return executeMacroSearch(runtime, input)
		case 'provider_status':
			return executeProviderStatus(runtime, input)
		case 'provider_health':
			return executeProviderHealth(runtime, input)
	}
}

async function executeMarketSearch(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<SearchResult[]>> {
	const query = requiredString(input, 'query')
	const limit = optionalInteger(input, 'limit') ?? 20
	const normalizedInput = { ...input, query, limit }
	const result = await runtime.route<SearchResult[]>(
		'search',
		'search',
		{ query, limit },
		routeOptions(input),
	)
	return routedResponse(
		runtime,
		'market_search',
		normalizedInput,
		result,
		result.data.slice(0, limit),
	)
}

async function executeStockQuotes(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<QuoteResult[]>> {
	const symbols = requiredStringArray(input, 'symbols').map(normalizeSymbol)
	const normalizedInput = { ...input, symbols }
	if (new Set(symbols).size !== symbols.length) {
		throw new Error('symbols must remain unique after normalization')
	}
	const options = routeOptions(input)

	if (symbols.length === 1) {
		const ticker = symbols[0] as string
		const result = await runtime.route<QuoteResult>('quote', 'get', { symbol: ticker }, options)
		return routedResponse(runtime, 'stock_quotes', normalizedInput, result, [
			{ ...result.data, symbol: ticker },
		])
	}

	const requested = new Set(symbols)
	const quotes = new Map<string, QuoteResult>()
	const sources = new Set<string>()
	const errors: AgentToolErrorDetail[] = []
	const warnings: string[] = []
	let allCached = true

	try {
		const result = await runtime.route<QuoteResult[]>('quote', 'get', { symbols }, options)
		if (Array.isArray(result.data)) {
			for (const item of result.data) {
				const ticker = normalizeSymbol(item.symbol)
				if (requested.has(ticker) && !quotes.has(ticker)) {
					quotes.set(ticker, { ...item, symbol: ticker })
				}
			}
			if (quotes.size > 0) {
				sources.add(result.source)
				allCached = allCached && result.cached
			}
		}

		const missing = symbols.filter((ticker) => !quotes.has(ticker))
		if (missing.length === 0) {
			return routedResponse(
				runtime,
				'stock_quotes',
				normalizedInput,
				result,
				symbols.map((ticker) => quotes.get(ticker) as QuoteResult),
			)
		}
		warnings.push(
			quotes.size === 0
				? 'The selected provider returned no batch quotes; individual requests were used.'
				: `The batch response omitted ${missing.join(', ')}; individual requests were used for those symbols.`,
		)
	} catch (error) {
		warnings.push(
			`Batch quote request was unavailable; individual requests were used (${errorMessage(error)}).`,
		)
	}

	const missing = symbols.filter((ticker) => !quotes.has(ticker))
	const settled = await Promise.allSettled(
		missing.map((ticker) =>
			runtime.route<QuoteResult>('quote', 'get', { symbol: ticker }, options),
		),
	)

	settled.forEach((entry, index) => {
		const ticker = missing[index] as string
		if (entry.status === 'fulfilled') {
			quotes.set(ticker, { ...entry.value.data, symbol: ticker })
			sources.add(entry.value.source)
			allCached = allCached && entry.value.cached
		} else {
			errors.push({ component: ticker, message: errorMessage(entry.reason) })
		}
	})

	const data = symbols.flatMap((ticker) => {
		const item = quotes.get(ticker)
		return item ? [item] : []
	})
	if (data.length === 0) {
		throw new Error(
			`No quotes could be retrieved: ${errors.map((error) => error.message).join('; ')}`,
		)
	}

	return {
		data,
		meta: {
			tool: 'stock_quotes',
			retrievedAt: runtime.now().toISOString(),
			request: normalizedInput,
			sources: [...sources].sort(),
			cached: allCached,
			partial: errors.length > 0,
			warnings,
			errors: errors.length > 0 ? errors : undefined,
		},
	}
}

async function executeCompanySnapshot(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<CompanySnapshot>> {
	const ticker = symbol(input)
	const historyDays = optionalInteger(input, 'historyDays') ?? 30
	const financialPeriods = optionalInteger(input, 'financialPeriods') ?? 4
	const filingLimit = optionalInteger(input, 'filingLimit') ?? 5
	const options: RouteOptions = { noCache: optionalBoolean(input, 'noCache') ?? false }

	const tasks: Array<{
		key: 'quote' | 'history' | 'financials' | 'earnings' | 'filings'
		promise: Promise<ProviderResult<unknown>>
	}> = [
		{
			key: 'quote',
			promise: runtime.route<QuoteResult>('quote', 'get', { symbol: ticker }, options),
		},
		{
			key: 'history',
			promise: runtime.route<HistoricalQuote[]>(
				'history',
				'get',
				{ symbol: ticker, days: historyDays },
				options,
			),
		},
		{
			key: 'financials',
			promise: runtime.route<FinancialStatement[]>(
				'financials',
				'get',
				{ symbol: ticker, period: 'quarterly', limit: financialPeriods },
				options,
			),
		},
		{
			key: 'earnings',
			promise: runtime.route<EarningsData[]>('earnings', 'get', { symbol: ticker }, options),
		},
		{
			key: 'filings',
			promise: runtime.route<Filing[]>(
				'filing',
				'list',
				{ symbol: ticker, limit: filingLimit },
				options,
			),
		},
	]

	const settled = await Promise.allSettled(tasks.map((task) => task.promise))
	const data: CompanySnapshot = {
		symbol: ticker,
		quote: null,
		recentHistory: null,
		financials: null,
		earnings: null,
		filings: null,
	}
	const sources = new Set<string>()
	const errors: AgentToolErrorDetail[] = []
	let successful = 0
	let allCached = true

	settled.forEach((entry, index) => {
		const key = tasks[index]?.key ?? 'unknown'
		if (entry.status === 'rejected') {
			errors.push({ component: key, message: errorMessage(entry.reason) })
			return
		}

		successful += 1
		sources.add(entry.value.source)
		allCached = allCached && entry.value.cached

		switch (key) {
			case 'quote':
				data.quote = entry.value.data as QuoteResult
				break
			case 'history': {
				const history = [...(entry.value.data as HistoricalQuote[])].sort((a, b) =>
					a.date.localeCompare(b.date),
				)
				data.recentHistory = history.slice(-5)
				data.performance = calculatePerformance(history)
				break
			}
			case 'financials':
				data.financials = (entry.value.data as FinancialStatement[]).slice(0, financialPeriods)
				break
			case 'earnings':
				data.earnings = (entry.value.data as EarningsData[]).slice(0, 8)
				break
			case 'filings':
				data.filings = (entry.value.data as Filing[]).slice(0, filingLimit)
				break
		}
	})

	if (successful === 0) {
		throw new Error(`Company snapshot failed: ${errors.map((error) => error.message).join('; ')}`)
	}

	return {
		data,
		meta: {
			tool: 'company_snapshot',
			retrievedAt: runtime.now().toISOString(),
			request: {
				symbol: ticker,
				historyDays,
				financialPeriods,
				filingLimit,
				noCache: options.noCache ?? false,
			},
			sources: [...sources].sort(),
			cached: allCached,
			partial: errors.length > 0,
			errors: errors.length > 0 ? errors : undefined,
		},
	}
}

async function executeStockFinancials(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<FinancialStatement[]>> {
	const ticker = symbol(input)
	const period = optionalString(input, 'period') ?? 'annual'
	const limit = optionalInteger(input, 'limit') ?? 5
	const normalizedInput = { ...input, symbol: ticker, period, limit }
	const result = await runtime.route<FinancialStatement[]>(
		'financials',
		'get',
		{ symbol: ticker, period, limit },
		routeOptions(input),
	)
	const data = [...result.data].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
	return routedResponse(runtime, 'stock_financials', normalizedInput, result, data)
}

async function executeStockHistory(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<HistoricalQuote[]>> {
	const ticker = symbol(input)
	const days = optionalInteger(input, 'days') ?? 30
	const normalizedInput = { ...input, symbol: ticker, days }
	const result = await runtime.route<HistoricalQuote[]>(
		'history',
		'get',
		{ symbol: ticker, days },
		routeOptions(input),
	)
	const data = [...result.data].sort((a, b) => a.date.localeCompare(b.date)).slice(-days)
	return routedResponse(runtime, 'stock_history', normalizedInput, result, data)
}

async function executeStockOptions(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<OptionContract[]>> {
	const ticker = symbol(input)
	const result = await runtime.route<OptionContract[]>(
		'options',
		'get',
		{ symbol: ticker },
		routeOptions(input),
	)
	const type = optionalString(input, 'type')
	const expiration = optionalString(input, 'expiration')
	const limit = optionalInteger(input, 'limit') ?? 100
	const contracts = result.data
		.filter((contract) => !type || contract.type === type)
		.filter((contract) => !expiration || contract.expiration === expiration)
		.slice(0, limit)
	const normalizedInput = { ...input, symbol: ticker, limit }
	return routedResponse(runtime, 'stock_options', normalizedInput, result, contracts)
}

async function executeSecFilings(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<Filing[]>> {
	const latest = optionalBoolean(input, 'latest') ?? false
	const limit = optionalInteger(input, 'limit') ?? 20
	const ticker = symbol(input)
	const type = optionalString(input, 'type')
	const normalizedInput = { ...input, symbol: ticker, type, latest, limit }
	const result = await runtime.route<Filing[]>(
		'filing',
		'list',
		{
			symbol: ticker,
			type,
			latest,
			limit,
		},
		routeOptions(input),
	)
	return routedResponse(
		runtime,
		'sec_filings',
		normalizedInput,
		result,
		(latest ? result.data.slice(0, 1) : result.data).slice(0, limit),
	)
}

async function executeCryptoTop(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<CryptoQuote[]>> {
	const limit = optionalInteger(input, 'limit') ?? 10
	const normalizedInput = { ...input, limit }
	const result = await runtime.route<CryptoQuote[]>('crypto', 'top', { limit }, routeOptions(input))
	return routedResponse(runtime, 'crypto_top', normalizedInput, result, result.data.slice(0, limit))
}

async function executeCryptoHistory(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<CryptoCandle[]>> {
	const ticker = symbol(input)
	const days = optionalInteger(input, 'days') ?? 30
	const interval = optionalString(input, 'interval')
	const normalizedInput = { ...input, symbol: ticker, days, interval }
	const result = await runtime.route<CryptoCandle[]>(
		'crypto',
		'history',
		{ symbol: ticker, days, interval },
		routeOptions(input),
	)
	const data = [...result.data].sort((a, b) => a.time.localeCompare(b.time)).slice(-1000)
	return routedResponse(runtime, 'crypto_history', normalizedInput, result, data)
}

async function executeMacroSeries(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<MacroSeries>> {
	const country = (optionalString(input, 'country') ?? 'US').toUpperCase()
	const requestedSource = normalizedSource(input)
	if (country !== 'US' && requestedSource && requestedSource !== 'worldbank') {
		throw new Error('country is only supported when source is worldbank')
	}
	const source = country !== 'US' ? 'worldbank' : requestedSource
	const limit = optionalInteger(input, 'limit') ?? 120
	const start = optionalString(input, 'start')
	const end = optionalString(input, 'end')
	if (start && end && start > end) throw new Error('start must be on or before end')
	const seriesId = requiredString(input, 'seriesId').toUpperCase()
	const normalizedInput = {
		...input,
		seriesId,
		country,
		limit,
		...(source ? { source } : {}),
	}
	const result = await runtime.route<MacroSeries>(
		'macro',
		'get',
		{
			seriesId,
			start,
			end,
			limit,
			country,
		},
		{
			source,
			noCache: optionalBoolean(input, 'noCache') ?? false,
		},
	)
	const data: MacroSeries = {
		...result.data,
		data: [...result.data.data].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit),
	}
	return routedResponse(runtime, 'macro_series', normalizedInput, result, data)
}

async function executeMacroSearch(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<MacroSearchResult[]>> {
	const query = requiredString(input, 'query')
	const limit = optionalInteger(input, 'limit') ?? 20
	const normalizedInput = { ...input, query, limit }
	const result = await runtime.route<unknown[]>(
		'macro',
		'search',
		{ query, limit },
		routeOptions(input),
	)
	const data = result.data
		.map(normalizeMacroSearchResult)
		.filter((entry): entry is MacroSearchResult => entry !== undefined)
		.slice(0, limit)
	return routedResponse(runtime, 'macro_search', normalizedInput, result, data)
}

function executeProviderStatus(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): AgentToolResponse<ProviderStatus[]> {
	const providers = runtime
		.getProviders()
		.map((provider) => ({
			name: provider.name,
			enabled: provider.isEnabled(),
			requiresKey: provider.requiresKey,
			keyEnvVar: provider.keyEnvVar,
			capabilities: [...provider.capabilities],
			priority: { ...provider.priority },
			rateLimit: {
				maxRequests: provider.rateLimits.maxRequests,
				windowMs: provider.rateLimits.windowMs,
			},
		}))
		.sort((a, b) => a.name.localeCompare(b.name))
	return {
		data: providers,
		meta: {
			tool: 'provider_status',
			retrievedAt: runtime.now().toISOString(),
			request: input,
		},
	}
}

async function executeProviderHealth(
	runtime: AgentRuntime,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<ProviderHealthResult[]>> {
	const requested = Array.isArray(input.sources)
		? input.sources.map((value) => String(value).trim().toLowerCase())
		: undefined
	if (requested && new Set(requested).size !== requested.length) {
		throw new Error('sources must remain unique after normalization')
	}

	const allProviders = runtime.getProviders()
	const knownNames = new Set(allProviders.map((provider) => provider.name))
	const unknown = requested?.filter((name) => !knownNames.has(name)) ?? []
	if (unknown.length > 0) {
		throw new Error(`Unknown provider(s): ${unknown.join(', ')}`)
	}

	const providers = requested
		? allProviders.filter((provider) => requested.includes(provider.name))
		: allProviders
	const timeoutMs = optionalInteger(input, 'timeoutMs') ?? 15_000
	const normalizedInput = {
		...(requested ? { sources: requested } : {}),
		timeoutMs,
	}
	const data = await checkProviderHealth(providers, { timeoutMs, now: runtime.now })
	const unhealthy = data.filter((result) => result.status !== 'ok')

	return {
		data,
		meta: {
			tool: 'provider_health',
			retrievedAt: runtime.now().toISOString(),
			request: normalizedInput,
			sources: data.map((result) => result.name),
			...(unhealthy.length > 0
				? {
						partial: true,
						warnings: unhealthy.map(
							(result) =>
								`${result.name}: ${result.status}${result.message ? ` (${result.message})` : ''}`,
						),
					}
				: {}),
		},
	}
}

async function executeLimitedArray<T>(
	runtime: AgentRuntime,
	name: AgentToolName,
	category: DataCategory,
	action: string,
	args: Record<string, unknown>,
	input: Record<string, unknown>,
	limit: number,
): Promise<AgentToolResponse<T[]>> {
	const result = await runtime.route<T[]>(category, action, args, routeOptions(input))
	return routedResponse(runtime, name, input, result, result.data.slice(0, limit))
}

async function executeRouted<T>(
	runtime: AgentRuntime,
	name: AgentToolName,
	category: DataCategory,
	action: string,
	args: Record<string, unknown>,
	input: Record<string, unknown>,
): Promise<AgentToolResponse<T>> {
	const result = await runtime.route<T>(category, action, args, routeOptions(input))
	return routedResponse(runtime, name, input, result)
}

function routedResponse<T>(
	runtime: AgentRuntime,
	name: AgentToolName,
	input: Record<string, unknown>,
	result: ProviderResult<unknown>,
	data = result.data as T,
): AgentToolResponse<T> {
	return {
		data,
		meta: {
			tool: name,
			retrievedAt: runtime.now().toISOString(),
			request: input,
			source: result.source,
			cached: result.cached,
		},
	}
}

function routeOptions(input: Record<string, unknown>): RouteOptions {
	return {
		source: normalizedSource(input),
		noCache: optionalBoolean(input, 'noCache') ?? false,
	}
}

function normalizedSource(input: Record<string, unknown>): string | undefined {
	const source = optionalString(input, 'source')
	return source?.trim().toLowerCase()
}

function calculatePerformance(history: HistoricalQuote[]): SnapshotPerformance | undefined {
	const valid = history
		.filter((point) => typeof point.close === 'number' && Number.isFinite(point.close))
		.sort((a, b) => a.date.localeCompare(b.date))
	const first = valid[0]
	const last = valid[valid.length - 1]
	if (!first || !last || first.close === 0) return undefined
	const absoluteChange = last.close - first.close
	return {
		startDate: first.date,
		endDate: last.date,
		startClose: first.close,
		endClose: last.close,
		absoluteChange,
		percentChange: (absoluteChange / first.close) * 100,
		observations: valid.length,
	}
}

function symbol(input: Record<string, unknown>): string {
	return normalizeSymbol(requiredString(input, 'symbol'))
}

function normalizeSymbol(value: string): string {
	return value.trim().toUpperCase()
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key]
	if (typeof value !== 'string') throw new Error(`${key} must be a string`)
	const normalized = value.trim()
	if (!normalized) throw new Error(`${key} must not be blank`)
	return normalized
}

function requiredStringArray(input: Record<string, unknown>, key: string): string[] {
	const value = input[key]
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`${key} must be an array of strings`)
	}
	return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key]
	return typeof value === 'string' ? value.trim() : undefined
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key]
	return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key]
	return typeof value === 'boolean' ? value : undefined
}

function normalizeMacroSearchResult(value: unknown): MacroSearchResult | undefined {
	if (!isRecord(value)) return undefined
	const id = typeof value.id === 'string' ? value.id : undefined
	const title = typeof value.title === 'string' ? value.title : undefined
	if (!id || !title) return undefined
	return {
		id,
		title,
		units: stringValue(value.units),
		frequency: stringValue(value.frequency),
		seasonalAdjustment:
			stringValue(value.seasonalAdjustment) ?? stringValue(value.seasonal_adjustment),
		popularity: numberValue(value.popularity),
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error)
	const compact = raw.replace(/\s+/g, ' ').trim() || 'Unknown error'
	return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}
