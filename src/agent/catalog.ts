export type JsonSchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'

export interface JsonSchema {
	readonly type?: JsonSchemaType
	readonly description?: string
	readonly properties?: Readonly<Record<string, JsonSchema>>
	readonly required?: readonly string[]
	readonly additionalProperties?: boolean
	readonly items?: JsonSchema
	readonly enum?: readonly (string | number | boolean)[]
	readonly default?: unknown
	readonly minLength?: number
	readonly maxLength?: number
	readonly pattern?: string
	readonly minimum?: number
	readonly maximum?: number
	readonly minItems?: number
	readonly maxItems?: number
	readonly uniqueItems?: boolean
	readonly format?: 'date'
}

export interface AgentToolAnnotations {
	readonly readOnlyHint: true
	readonly destructiveHint: false
	readonly idempotentHint: true
	readonly openWorldHint: true
}

export interface AgentToolDefinition {
	readonly name: AgentToolName
	readonly title: string
	readonly description: string
	readonly inputSchema: JsonSchema
	readonly annotations: AgentToolAnnotations
}

export type AgentToolName =
	| 'market_search'
	| 'company_snapshot'
	| 'stock_quotes'
	| 'stock_financials'
	| 'stock_history'
	| 'stock_options'
	| 'stock_earnings'
	| 'stock_dividends'
	| 'sec_filings'
	| 'sec_insider_transactions'
	| 'crypto_quote'
	| 'crypto_top'
	| 'crypto_history'
	| 'macro_series'
	| 'macro_search'
	| 'provider_status'
	| 'provider_health'

export interface CommonToolInput {
	source?: string
	noCache?: boolean
}

export interface AgentToolInputMap {
	market_search: CommonToolInput & { query: string; limit?: number }
	company_snapshot: {
		symbol: string
		historyDays?: number
		financialPeriods?: number
		filingLimit?: number
		noCache?: boolean
	}
	stock_quotes: CommonToolInput & { symbols: string[] }
	stock_financials: CommonToolInput & {
		symbol: string
		period?: 'annual' | 'quarterly'
		limit?: number
	}
	stock_history: CommonToolInput & { symbol: string; days?: number }
	stock_options: CommonToolInput & {
		symbol: string
		type?: 'call' | 'put'
		expiration?: string
		limit?: number
	}
	stock_earnings: CommonToolInput & { symbol: string; limit?: number }
	stock_dividends: CommonToolInput & { symbol: string; limit?: number }
	sec_filings: CommonToolInput & {
		symbol: string
		type?: string
		latest?: boolean
		limit?: number
	}
	sec_insider_transactions: CommonToolInput & { symbol: string; limit?: number }
	crypto_quote: CommonToolInput & { symbol: string }
	crypto_top: CommonToolInput & { limit?: number }
	crypto_history: CommonToolInput & {
		symbol: string
		days?: number
		interval?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'
	}
	macro_series: CommonToolInput & {
		seriesId: string
		start?: string
		end?: string
		limit?: number
		country?: string
	}
	macro_search: CommonToolInput & { query: string; limit?: number }
	provider_status: Record<string, never>
	provider_health: { sources?: string[]; timeoutMs?: number }
}

const READ_ONLY_ANNOTATIONS: AgentToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
}

const SYMBOL: JsonSchema = {
	type: 'string',
	description: 'Ticker or asset symbol, for example AAPL, BRK-B, ^GSPC, BTC, or ETH.',
	minLength: 1,
	maxLength: 32,
	pattern: '^\\s*\\S+\\s*$',
}

const SOURCE: JsonSchema = {
	type: 'string',
	description: 'Optional provider name to force, such as yahoo, sec-edgar, fred, or worldbank.',
	minLength: 1,
	maxLength: 64,
	pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9._-]*\\s*$',
}

const NO_CACHE: JsonSchema = {
	type: 'boolean',
	description: 'Bypass the in-memory cache when fresh upstream data is required.',
	default: false,
}

const DATE: JsonSchema = {
	type: 'string',
	description: 'ISO calendar date in YYYY-MM-DD format.',
	pattern: '^\\d{4}-\\d{2}-\\d{2}$',
	format: 'date',
}

function objectSchema(
	properties: Readonly<Record<string, JsonSchema>>,
	required: readonly string[] = [],
): JsonSchema {
	return {
		type: 'object',
		properties,
		required,
		additionalProperties: false,
	}
}

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
	{
		name: 'market_search',
		title: 'Search markets',
		description:
			'Resolve a company, ticker, security, or crypto name to symbols. Use this before quote tools when the exact symbol is uncertain.',
		inputSchema: objectSchema(
			{
				query: {
					type: 'string',
					description: 'Company, asset, or ticker search text.',
					minLength: 1,
					maxLength: 200,
				},
				limit: {
					type: 'integer',
					description: 'Maximum number of matches to return.',
					minimum: 1,
					maximum: 50,
					default: 20,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['query'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'company_snapshot',
		title: 'Get company snapshot',
		description:
			'Get an agent-sized company brief in one call: quote, recent price performance, quarterly financials, earnings, and recent SEC filings. Returns partial results when one source is unavailable.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				historyDays: {
					type: 'integer',
					description: 'Number of calendar days of price history used for recent performance.',
					minimum: 2,
					maximum: 365,
					default: 30,
				},
				financialPeriods: {
					type: 'integer',
					description: 'Number of recent quarterly financial periods to include.',
					minimum: 1,
					maximum: 12,
					default: 4,
				},
				filingLimit: {
					type: 'integer',
					description: 'Maximum number of recent SEC filings to include.',
					minimum: 1,
					maximum: 20,
					default: 5,
				},
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_quotes',
		title: 'Get stock quotes',
		description:
			'Get quote fields for one to twenty symbols in one bounded call. Prefer this over repeated single-symbol calls.',
		inputSchema: objectSchema(
			{
				symbols: {
					type: 'array',
					description: 'One to twenty ticker or asset symbols.',
					items: SYMBOL,
					minItems: 1,
					maxItems: 20,
					uniqueItems: true,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbols'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_financials',
		title: 'Get company financials',
		description:
			'Get normalized annual or quarterly financial statement fields with source provenance.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				period: {
					type: 'string',
					description: 'Statement period.',
					enum: ['annual', 'quarterly'],
					default: 'annual',
				},
				limit: {
					type: 'integer',
					description: 'Maximum number of periods.',
					minimum: 1,
					maximum: 40,
					default: 5,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_history',
		title: 'Get stock price history',
		description: 'Get bounded historical OHLCV price data for a symbol.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				days: {
					type: 'integer',
					description: 'Number of calendar days of history.',
					minimum: 1,
					maximum: 730,
					default: 30,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_options',
		title: 'Get stock options',
		description:
			'Get a bounded options chain. Filter by contract type or expiration to reduce token usage.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				type: {
					type: 'string',
					description: 'Optional contract type filter.',
					enum: ['call', 'put'],
				},
				expiration: DATE,
				limit: {
					type: 'integer',
					description: 'Maximum number of contracts returned after filtering.',
					minimum: 1,
					maximum: 250,
					default: 100,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_earnings',
		title: 'Get company earnings',
		description: 'Get recent earnings dates, estimates, actual results, and surprises.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				limit: {
					type: 'integer',
					description: 'Maximum number of earnings events.',
					minimum: 1,
					maximum: 40,
					default: 8,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'stock_dividends',
		title: 'Get dividend history',
		description: 'Get recent dividend events for a symbol.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				limit: {
					type: 'integer',
					description: 'Maximum number of dividend events.',
					minimum: 1,
					maximum: 100,
					default: 20,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'sec_filings',
		title: 'Get SEC filings',
		description: 'List recent SEC filings for a public company, optionally filtered by form type.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				type: {
					type: 'string',
					description: 'Optional SEC form type such as 10-K, 10-Q, 8-K, or DEF 14A.',
					minLength: 1,
					maxLength: 32,
				},
				latest: {
					type: 'boolean',
					description: 'Return only the newest matching filing.',
					default: false,
				},
				limit: {
					type: 'integer',
					description: 'Maximum number of filings.',
					minimum: 1,
					maximum: 100,
					default: 20,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'sec_insider_transactions',
		title: 'Get SEC insider filings',
		description: 'Get recent Form 4 insider filing records for a public company.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				limit: {
					type: 'integer',
					description: 'Maximum number of insider filing records.',
					minimum: 1,
					maximum: 100,
					default: 20,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'crypto_quote',
		title: 'Get crypto quote',
		description: 'Get a cryptocurrency quote and 24-hour market fields.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'crypto_top',
		title: 'Get top cryptocurrencies',
		description: 'Get a bounded ranking of cryptocurrencies by market capitalization.',
		inputSchema: objectSchema({
			limit: {
				type: 'integer',
				description: 'Maximum number of ranked assets.',
				minimum: 1,
				maximum: 100,
				default: 10,
			},
			source: SOURCE,
			noCache: NO_CACHE,
		}),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'crypto_history',
		title: 'Get crypto price history',
		description:
			'Get cryptocurrency OHLCV candles for a bounded lookback. The response includes at most the 1,000 most recent candles.',
		inputSchema: objectSchema(
			{
				symbol: SYMBOL,
				days: {
					type: 'integer',
					description:
						'Requested calendar-day lookback. Providers may coarsen intervals or cap candle count.',
					minimum: 1,
					maximum: 3650,
					default: 30,
				},
				interval: {
					type: 'string',
					description: 'Optional candle interval.',
					enum: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['symbol'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'macro_series',
		title: 'Get macroeconomic series',
		description:
			'Get an economic time series from FRED or the World Bank. Use a World Bank indicator ID with a country code for non-US data.',
		inputSchema: objectSchema(
			{
				seriesId: {
					type: 'string',
					description: 'FRED series ID or World Bank indicator ID.',
					minLength: 1,
					maxLength: 128,
					pattern: '^\\S+$',
				},
				start: DATE,
				end: DATE,
				limit: {
					type: 'integer',
					description: 'Maximum number of observations.',
					minimum: 1,
					maximum: 1000,
					default: 120,
				},
				country: {
					type: 'string',
					description: 'ISO 3166-1 alpha-2 or alpha-3 country code. Defaults to US.',
					pattern: '^[A-Za-z]{2,3}$',
					default: 'US',
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['seriesId'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'macro_search',
		title: 'Search macroeconomic series',
		description: 'Search available macroeconomic series by natural-language topic.',
		inputSchema: objectSchema(
			{
				query: {
					type: 'string',
					description: 'Economic topic or series name.',
					minLength: 1,
					maxLength: 200,
				},
				limit: {
					type: 'integer',
					description: 'Maximum number of matches.',
					minimum: 1,
					maximum: 100,
					default: 20,
				},
				source: SOURCE,
				noCache: NO_CACHE,
			},
			['query'],
		),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'provider_status',
		title: 'Inspect provider status',
		description:
			'Inspect configured providers, capabilities, priorities, and rate limits without making network requests.',
		inputSchema: objectSchema({}),
		annotations: READ_ONLY_ANNOTATIONS,
	},
	{
		name: 'provider_health',
		title: 'Check provider health',
		description:
			'Probe selected data providers with small representative requests. Distinguishes healthy, missing-key, disabled, regionally unavailable, and failing sources.',
		inputSchema: objectSchema({
			sources: {
				type: 'array',
				description: 'Optional provider names to probe. Omit to check every configured provider.',
				items: SOURCE,
				minItems: 1,
				maxItems: 8,
				uniqueItems: true,
			},
			timeoutMs: {
				type: 'integer',
				description: 'Maximum time for each provider probe in milliseconds.',
				minimum: 1000,
				maximum: 60000,
				default: 15000,
			},
		}),
		annotations: READ_ONLY_ANNOTATIONS,
	},
]

const TOOL_BY_NAME = new Map<AgentToolName, AgentToolDefinition>(
	AGENT_TOOLS.map((tool) => [tool.name, tool]),
)

export class AgentInputError extends Error {
	readonly path: string

	constructor(path: string, message: string) {
		super(`${path}: ${message}`)
		this.name = 'AgentInputError'
		this.path = path
	}
}

export function listAgentTools(): readonly AgentToolDefinition[] {
	return AGENT_TOOLS
}

export function getAgentTool(name: string): AgentToolDefinition | undefined {
	return TOOL_BY_NAME.get(name as AgentToolName)
}

export function validateAgentToolInput(name: string, input: unknown = {}): Record<string, unknown> {
	const tool = getAgentTool(name)
	if (!tool) throw new AgentInputError('tool', `unknown tool "${name}"`)
	return validateValue(tool.inputSchema, input, 'input') as Record<string, unknown>
}

function validateValue(schema: JsonSchema, value: unknown, path: string): unknown {
	if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
		throw new AgentInputError(path, `must be one of ${schema.enum.join(', ')}`)
	}

	switch (schema.type) {
		case 'object':
			return validateObject(schema, value, path)
		case 'array':
			return validateArray(schema, value, path)
		case 'string':
			return validateString(schema, value, path)
		case 'integer':
			return validateNumber(schema, value, path, true)
		case 'number':
			return validateNumber(schema, value, path, false)
		case 'boolean':
			if (typeof value !== 'boolean') throw new AgentInputError(path, 'must be a boolean')
			return value
		default:
			return value
	}
}

function validateObject(schema: JsonSchema, value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new AgentInputError(path, 'must be an object')

	const properties = schema.properties ?? {}
	for (const required of schema.required ?? []) {
		if (!(required in value) || value[required] === undefined) {
			throw new AgentInputError(`${path}.${required}`, 'is required')
		}
	}

	if (schema.additionalProperties === false) {
		for (const key of Object.keys(value)) {
			if (!(key in properties)) throw new AgentInputError(`${path}.${key}`, 'is not allowed')
		}
	}

	const output: Record<string, unknown> = {}
	for (const [key, propertySchema] of Object.entries(properties)) {
		if (value[key] !== undefined) {
			output[key] = validateValue(propertySchema, value[key], `${path}.${key}`)
		}
	}
	return output
}

function validateArray(schema: JsonSchema, value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new AgentInputError(path, 'must be an array')
	if (schema.minItems !== undefined && value.length < schema.minItems) {
		throw new AgentInputError(path, `must contain at least ${schema.minItems} item(s)`)
	}
	if (schema.maxItems !== undefined && value.length > schema.maxItems) {
		throw new AgentInputError(path, `must contain at most ${schema.maxItems} item(s)`)
	}
	if (schema.uniqueItems) {
		const seen = new Set(value.map((item) => JSON.stringify(item)))
		if (seen.size !== value.length) throw new AgentInputError(path, 'must contain unique items')
	}
	return schema.items
		? value.map((item, index) =>
				validateValue(schema.items as JsonSchema, item, `${path}[${index}]`),
			)
		: [...value]
}

function validateString(schema: JsonSchema, value: unknown, path: string): string {
	if (typeof value !== 'string') throw new AgentInputError(path, 'must be a string')
	if (schema.minLength !== undefined && value.length < schema.minLength) {
		throw new AgentInputError(path, `must be at least ${schema.minLength} character(s)`)
	}
	if (schema.minLength !== undefined && schema.minLength > 0 && value.trim().length === 0) {
		throw new AgentInputError(path, 'must contain a non-whitespace character')
	}
	if (schema.maxLength !== undefined && value.length > schema.maxLength) {
		throw new AgentInputError(path, `must be at most ${schema.maxLength} character(s)`)
	}
	if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
		throw new AgentInputError(path, `must match ${schema.pattern}`)
	}
	if (schema.format === 'date' && !isIsoCalendarDate(value)) {
		throw new AgentInputError(path, 'must be a valid calendar date in YYYY-MM-DD format')
	}
	return value
}

function validateNumber(
	schema: JsonSchema,
	value: unknown,
	path: string,
	integer: boolean,
): number {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		(integer && !Number.isInteger(value))
	) {
		throw new AgentInputError(path, integer ? 'must be an integer' : 'must be a finite number')
	}
	if (schema.minimum !== undefined && value < schema.minimum) {
		throw new AgentInputError(path, `must be at least ${schema.minimum}`)
	}
	if (schema.maximum !== undefined && value > schema.maximum) {
		throw new AgentInputError(path, `must be at most ${schema.maximum}`)
	}
	return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return false
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const date = new Date(Date.UTC(year, month - 1, day))
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	)
}
