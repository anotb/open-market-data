import { loadConfig } from '../core/config.js'
import { consumeToken } from '../core/rate-limiter.js'
import type { MacroDataPoint, MacroSeries, SearchResult } from '../types.js'
import type { DataCategory, Provider, ProviderResult } from './types.js'

const BASE_URL = 'https://api.stlouisfed.org/fred'

interface FredObservation {
	date: string
	value: string
}

interface FredSeriesInfo {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
}

interface FredSeriesSearchResult {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
	popularity: number
}

interface FredCategory {
	id: number
	name: string
	parent_id: number
}

function getApiKey(): string | undefined {
	return loadConfig().fredApiKey
}

async function fredFetch<T>(
	path: string,
	params: Record<string, string | number | undefined>,
): Promise<T> {
	const apiKey = getApiKey()
	if (!apiKey) {
		throw new Error(
			'FRED API key not configured. Set FRED_API_KEY env var or run: omd config set fredApiKey <key>',
		)
	}

	if (!consumeToken('fred', fred.rateLimits)) {
		throw new Error('FRED rate limit exceeded. Try again shortly.')
	}

	const url = new URL(`${BASE_URL}${path}`)
	url.searchParams.set('api_key', apiKey)
	url.searchParams.set('file_type', 'json')

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, String(value))
		}
	}

	const response = await fetch(url.toString())

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`FRED API error (${response.status}): ${text}`)
	}

	return response.json() as Promise<T>
}

async function getSeriesObservations(
	args: Record<string, unknown>,
): Promise<ProviderResult<MacroSeries>> {
	const seriesId = args.seriesId as string
	if (!seriesId) {
		throw new Error('seriesId is required')
	}

	const start = args.start as string | undefined
	const end = args.end as string | undefined
	const limit = args.limit as number | undefined

	const [obsData, metaData] = await Promise.all([
		fredFetch<{ observations: FredObservation[] }>('/series/observations', {
			series_id: seriesId,
			observation_start: start,
			observation_end: end,
			limit,
		}),
		fredFetch<{ seriess: FredSeriesInfo[] }>('/series', {
			series_id: seriesId,
		}),
	])

	const meta = metaData.seriess[0]
	const dataPoints: MacroDataPoint[] = obsData.observations
		.filter((obs) => obs.value !== '.')
		.map((obs) => ({
			date: obs.date,
			value: Number(obs.value),
		}))
		.filter((dp) => !Number.isNaN(dp.value))

	const series: MacroSeries = {
		id: meta?.id ?? seriesId,
		title: meta?.title ?? seriesId,
		units: meta?.units,
		frequency: meta?.frequency,
		seasonalAdjustment: meta?.seasonal_adjustment,
		data: dataPoints,
		source: 'fred',
	}

	return { data: series, source: 'fred', cached: false }
}

async function searchSeries(
	args: Record<string, unknown>,
): Promise<ProviderResult<FredSeriesSearchResult[]>> {
	const query = args.query as string
	if (!query) {
		throw new Error('query is required')
	}

	const limit = (args.limit as number | undefined) ?? 20

	const data = await fredFetch<{ seriess: FredSeriesSearchResult[] }>('/series/search', {
		search_text: query,
		limit,
		order_by: 'popularity',
		sort_order: 'desc',
	})

	const results = data.seriess.map((s) => ({
		id: s.id,
		title: s.title,
		units: s.units,
		frequency: s.frequency,
		seasonal_adjustment: s.seasonal_adjustment,
		popularity: s.popularity,
	}))

	return { data: results, source: 'fred', cached: false }
}

async function getCategories(
	args: Record<string, unknown>,
): Promise<ProviderResult<{ id: number; name: string; parentId: number }[]>> {
	const categoryId = (args.categoryId as number | undefined) ?? 0

	const data = await fredFetch<{ categories: FredCategory[] }>('/category/children', {
		category_id: categoryId,
	})

	const categories = data.categories.map((c) => ({
		id: c.id,
		name: c.name,
		parentId: c.parent_id,
	}))

	return { data: categories, source: 'fred', cached: false }
}

async function searchForSearchCategory(
	args: Record<string, unknown>,
): Promise<ProviderResult<SearchResult[]>> {
	// Reuse searchSeries and map to SearchResult format
	const result = await searchSeries(args)
	const results: SearchResult[] = result.data.map((s) => ({
		symbol: s.id,
		name: s.title,
		type: 'macro-series',
		source: 'fred',
	}))

	return { data: results, source: 'fred', cached: false }
}

export const fred: Provider = {
	name: 'fred',
	requiresKey: true,
	keyEnvVar: 'FRED_API_KEY',
	capabilities: ['macro', 'search'] as DataCategory[],
	priority: { macro: 1, search: 5 },
	rateLimits: { maxRequests: 120, windowMs: 60_000 },

	isEnabled(): boolean {
		return !!loadConfig().fredApiKey
	},

	async execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>> {
		const route = `${category}/${action}`

		switch (route) {
			case 'macro/get':
				return getSeriesObservations(args) as Promise<ProviderResult<T>>

			case 'macro/search':
				return searchSeries(args) as Promise<ProviderResult<T>>

			case 'macro/categories':
				return getCategories(args) as Promise<ProviderResult<T>>

			case 'search/search':
				return searchForSearchCategory(args) as Promise<ProviderResult<T>>

			default:
				throw new Error(`FRED provider does not support ${route}`)
		}
	},
}
