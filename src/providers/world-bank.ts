import { consumeToken } from '../core/rate-limiter.js'
import type { MacroDataPoint, MacroSeries } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const BASE_URL = 'https://api.worldbank.org/v2'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_ERROR_LENGTH = 500

interface WbPagination {
	page: number
	pages: number
	per_page: number
	total: number
}

interface WbIndicator {
	id: string
	name: string
	unit: string
	source: { id: string; value: string }
	sourceNote: string
	sourceOrganization: string
	topics: { id: string; value: string }[]
}

interface WbDataEntry {
	indicator: { id: string; value: string }
	country: { id: string; value: string }
	countryiso3code: string
	date: string
	value: number | null
	unit: string
	decimal: number
}

interface WbSearchResult {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
	popularity: number
}

type WbResponse<T> = [WbPagination, T[] | null]

async function wbFetch<T>(
	path: string,
	params: Record<string, string | number | undefined> = {},
): Promise<WbResponse<T>> {
	const url = new URL(`${BASE_URL}${path}`)
	url.searchParams.set('format', 'json')

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, String(value))
		}
	}

	let response: Response | undefined
	let lastError: unknown
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!consumeToken('worldbank', worldBank.rateLimits)) {
			throw new Error('[worldbank] Rate limit exceeded. Try again shortly.')
		}
		try {
			response = await fetch(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
			if (response.ok || !isRetryableStatus(response.status) || attempt === 1) break
		} catch (error) {
			lastError = error
			if (attempt === 1) {
				throw new Error(`[worldbank] Request failed after two attempts: ${compactError(error)}`)
			}
		}
	}

	if (!response) {
		throw new Error(`[worldbank] Request failed: ${compactError(lastError)}`)
	}
	if (!response.ok) {
		const body = compactText(await response.text())
		throw new Error(`[worldbank] API error (${response.status}): ${body}`)
	}

	const json = await response.json()
	const apiError = worldBankApiError(json)
	if (apiError) throw new Error(`[worldbank] API error: ${apiError}`)

	// World Bank returns a two-element array: [pagination, data]
	if (!Array.isArray(json) || json.length < 2) {
		throw new Error('[worldbank] Unexpected response format')
	}

	return json as WbResponse<T>
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500
}

function compactError(error: unknown): string {
	return compactText(error instanceof Error ? error.message : String(error))
}

function compactText(value: string): string {
	const compact = value.replace(/\s+/g, ' ').trim() || 'Unknown upstream error'
	return compact.length <= MAX_ERROR_LENGTH
		? compact
		: `${compact.slice(0, MAX_ERROR_LENGTH - 3)}...`
}

function worldBankApiError(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return undefined
	const messages = value[0].message
	if (!Array.isArray(messages)) return undefined
	const details = messages
		.filter(isRecord)
		.map((message) =>
			[message.key, message.value].filter((part) => typeof part === 'string').join(': '),
		)
		.filter(Boolean)
	return details.length > 0 ? details.join('; ') : 'The provider rejected the request.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function searchIndicators(
	args: Record<string, unknown>,
): Promise<ProviderResult<WbSearchResult[]>> {
	const query = args.query as string
	if (!query) {
		throw new Error('[worldbank] query is required')
	}

	const limit = (args.limit as number | undefined) ?? 20
	const lowerQuery = query.toLowerCase()

	// Fetch WDI indicators (source=2) — the core ~1500 indicators
	// The full indicator list has 29K+ entries; WDI is the most useful subset
	const [, indicators] = await wbFetch<WbIndicator>('/indicator', {
		per_page: 2000,
		source: 2,
	})

	if (!indicators) {
		return { data: [], source: 'worldbank', cached: false }
	}

	const matched = indicators
		.filter((ind) => ind.name.toLowerCase().includes(lowerQuery))
		.slice(0, limit)

	const results: WbSearchResult[] = matched.map((ind) => ({
		id: ind.id,
		title: ind.name,
		units: ind.unit || '',
		frequency: '',
		seasonal_adjustment: '',
		popularity: 0,
	}))

	return { data: results, source: 'worldbank', cached: false }
}

async function getIndicatorData(
	args: Record<string, unknown>,
): Promise<ProviderResult<MacroSeries>> {
	const seriesId = args.seriesId as string
	if (!seriesId) {
		throw new Error('[worldbank] seriesId is required')
	}

	const start = args.start as string | undefined
	const end = args.end as string | undefined
	const limit = args.limit as number | undefined

	const params: Record<string, string | number | undefined> = {}

	if (start || end) {
		// The World Bank date query has periodically stalled at the edge. Fetch a
		// bounded recent window and filter locally for predictable behavior.
		params.mrv = 250
		params.per_page = 250
	} else if (limit != null) {
		params.mrv = limit
		params.per_page = limit
	} else {
		params.mrv = 20
		params.per_page = 20
	}

	const country = (args.country as string | undefined) ?? 'US'
	if (!/^[A-Za-z]{2,3}$/.test(country)) {
		throw new Error(
			`[worldbank] Invalid country code "${country}". Use ISO 3166-1 alpha-2 (e.g., US, GB, JP)`,
		)
	}

	const [, entries] = await wbFetch<WbDataEntry>(
		`/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(seriesId)}`,
		params,
	)

	if (!entries || entries.length === 0) {
		const series: MacroSeries = {
			id: seriesId,
			title: seriesId,
			units: '',
			frequency: 'Annual',
			data: [],
			source: 'worldbank',
		}
		return { data: series, source: 'worldbank', cached: false }
	}

	const title = entries[0].indicator.value || seriesId

	let dataPoints: MacroDataPoint[] = entries
		.filter((entry) => entry.value !== null)
		.map((entry) => ({
			date: entry.date,
			value: entry.value as number,
		}))
		.sort((a, b) => a.date.localeCompare(b.date))

	if (start || end) {
		const startYear = start?.slice(0, 4)
		const endYear = end?.slice(0, 4)
		dataPoints = dataPoints.filter(
			(point) => (!startYear || point.date >= startYear) && (!endYear || point.date <= endYear),
		)
	}
	if (limit != null) dataPoints = dataPoints.slice(-limit)

	const series: MacroSeries = {
		id: seriesId,
		title,
		units: '',
		frequency: 'Annual',
		data: dataPoints,
		source: 'worldbank',
	}

	return { data: series, source: 'worldbank', cached: false }
}

export const worldBank: Provider = {
	name: 'worldbank',
	requiresKey: false,
	capabilities: ['macro'] as DataCategory[],
	priority: { macro: 3 },
	rateLimits: { maxRequests: 30, windowMs: 60_000 },

	isEnabled(): boolean {
		return true
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		const route = `${category}/${action}`

		switch (route) {
			case 'macro/search':
				return searchIndicators(args) as Promise<ProviderResult<T>>

			case 'macro/get':
				return getIndicatorData(args) as Promise<ProviderResult<T>>

			default:
				throw new Error(`[worldbank] Provider does not support ${route}`)
		}
	},
}
