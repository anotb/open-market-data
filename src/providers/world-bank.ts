import { consumeToken } from '../core/rate-limiter.js'
import type { MacroDataPoint, MacroSeries } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const BASE_URL = 'https://api.worldbank.org/v2'

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
	if (!consumeToken('worldbank', worldBank.rateLimits)) {
		throw new Error('[worldbank] Rate limit exceeded. Try again shortly.')
	}

	const url = new URL(`${BASE_URL}${path}`)
	url.searchParams.set('format', 'json')

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, String(value))
		}
	}

	const response = await fetch(url.toString())

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`[worldbank] API error (${response.status}): ${text}`)
	}

	const json = await response.json()

	// World Bank returns a two-element array: [pagination, data]
	if (!Array.isArray(json) || json.length < 2) {
		throw new Error('[worldbank] Unexpected response format')
	}

	return json as WbResponse<T>
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

	if (limit != null) {
		params.mrv = limit
		params.per_page = limit
	} else {
		params.per_page = 50
	}

	if (start || end) {
		const currentYear = new Date().getFullYear()
		const startYear = start ? new Date(start).getFullYear() : currentYear - 20
		const endYear = end ? new Date(end).getFullYear() : currentYear
		params.date = `${startYear}:${endYear}`
	} else if (limit == null) {
		// Default: last 20 years
		const currentYear = new Date().getFullYear()
		params.date = `${currentYear - 20}:${currentYear}`
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

	const dataPoints: MacroDataPoint[] = entries
		.filter((entry) => entry.value !== null)
		.map((entry) => ({
			date: entry.date,
			value: entry.value as number,
		}))
		.sort((a, b) => a.date.localeCompare(b.date))

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
