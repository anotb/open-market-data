import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type { MacroSeries, SearchResult } from '../../src/types.js'
import {
	type FetchMock,
	type Responder,
	type Route,
	expectNoUnmatched,
	mockFetch,
} from '../helpers/mock-fetch.js'
import {
	type TempHome,
	clearConfigEnv,
	freshImport,
	freshImportAll,
	makeTempHome,
} from '../helpers/modules.js'

/**
 * src/providers/fred.ts reads its API key through `core/config.ts` (which
 * memoizes the resolved config) and spends `core/rate-limiter.ts` tokens from a
 * module-scope bucket. Both must be pristine per test, so every test pulls the
 * provider through `freshImport`/`freshImportAll` — that yields a fresh config
 * cache and a fresh token bucket inside one module generation.
 *
 * $HOME points at a throwaway directory and the cwd at an empty one, so the
 * config layer can never read the developer's real config or a repo `.env`.
 * Nothing here touches the network; the tests that care about the token bucket
 * pin the clock so no refill can sneak in.
 */

type FredModule = typeof import('../../src/providers/fred.js')
type LimiterModule = typeof import('../../src/core/rate-limiter.js')

const BASE_URL = 'https://api.stlouisfed.org/fred'

const OBS_MATCH = '/series/observations'
const SEARCH_MATCH = '/series/search'
const SERIES_MATCH = '/series?'
const CATEGORIES_MATCH = '/category/children'

const API_KEY = 'test-fred-key-123'

/** The exact url a default `macro/search` for "unemployment" must produce. */
const UNEMPLOYMENT_SEARCH_URL = `${BASE_URL}/series/search?api_key=${API_KEY}&file_type=json&search_text=unemployment&limit=20&order_by=popularity&sort_order=desc`

/** Result rows `macro/search` hands back (FRED's snake_case shape, verbatim). */
interface FredSearchRow {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
	popularity: number
}

/** Result rows `macro/categories` hands back. */
interface FredCategoryRow {
	id: number
	name: string
	parentId: number
}

// --- Fixtures (shaped like real FRED payloads, trimmed) ---------------------

type ObsRow = readonly [date: string, value: unknown]

/** The envelope FRED wraps around every /series/observations response. */
function observations(rows: readonly ObsRow[]): Record<string, unknown> {
	return {
		realtime_start: '2024-06-15',
		realtime_end: '2024-06-15',
		observation_start: '1600-01-01',
		observation_end: '9999-12-31',
		units: 'lin',
		output_type: 1,
		file_type: 'json',
		order_by: 'observation_date',
		sort_order: 'asc',
		count: rows.length,
		offset: 0,
		limit: 100000,
		observations: rows.map(([date, value]) => ({
			realtime_start: '2024-06-15',
			realtime_end: '2024-06-15',
			date,
			value,
		})),
	}
}

/** Five quarters of nominal GDP, oldest first — what FRED returns by default. */
const GDP_ROWS: readonly ObsRow[] = [
	['2023-01-01', '26813.601'],
	['2023-04-01', '27063.012'],
	['2023-07-01', '27610.128'],
	['2023-10-01', '27956.998'],
	['2024-01-01', '28269.176'],
]

/** The same five quarters newest first — what `sort_order=desc` returns. */
const GDP_ROWS_DESC: readonly ObsRow[] = [...GDP_ROWS].reverse()

/** GET /fred/series?series_id=GDP */
const GDP_SERIES = {
	realtime_start: '2024-06-15',
	realtime_end: '2024-06-15',
	seriess: [
		{
			id: 'GDP',
			realtime_start: '2024-06-15',
			realtime_end: '2024-06-15',
			title: 'Gross Domestic Product',
			observation_start: '1947-01-01',
			observation_end: '2024-01-01',
			frequency: 'Quarterly',
			frequency_short: 'Q',
			units: 'Billions of Dollars',
			units_short: 'Bil. of $',
			seasonal_adjustment: 'Seasonally Adjusted Annual Rate',
			seasonal_adjustment_short: 'SAAR',
			last_updated: '2024-05-30 07:56:04-05',
			popularity: 92,
			notes: 'BEA Account Code: A191RC. Gross domestic product, current dollars.',
		},
	],
}

/** GET /fred/series/search?search_text=unemployment */
const SERIES_SEARCH = {
	realtime_start: '2024-06-15',
	realtime_end: '2024-06-15',
	order_by: 'popularity',
	sort_order: 'desc',
	count: 2,
	offset: 0,
	limit: 20,
	seriess: [
		{
			id: 'UNRATE',
			realtime_start: '2024-06-15',
			realtime_end: '2024-06-15',
			title: 'Unemployment Rate',
			observation_start: '1948-01-01',
			observation_end: '2024-05-01',
			frequency: 'Monthly',
			frequency_short: 'M',
			units: 'Percent',
			units_short: '%',
			seasonal_adjustment: 'Seasonally Adjusted',
			seasonal_adjustment_short: 'SA',
			last_updated: '2024-06-07 07:44:02-05',
			popularity: 93,
			group_popularity: 93,
			notes: 'The unemployment rate represents the number of unemployed as a percentage.',
		},
		{
			id: 'UNRATENSA',
			realtime_start: '2024-06-15',
			realtime_end: '2024-06-15',
			title: 'Unemployment Rate (Not Seasonally Adjusted)',
			observation_start: '1948-01-01',
			observation_end: '2024-05-01',
			frequency: 'Monthly',
			frequency_short: 'M',
			units: 'Percent',
			units_short: '%',
			seasonal_adjustment: 'Not Seasonally Adjusted',
			seasonal_adjustment_short: 'NSA',
			last_updated: '2024-06-07 07:44:03-05',
			popularity: 64,
			group_popularity: 93,
		},
	],
}

/** GET /fred/category/children?category_id=0 */
const CATEGORY_CHILDREN = {
	categories: [
		{ id: 32991, name: 'Money, Banking, & Finance', parent_id: 0 },
		{ id: 10, name: 'Population, Employment, & Labor Markets', parent_id: 0 },
		{ id: 32992, name: 'National Accounts', parent_id: 0 },
	],
}

// --- Per-test environment ---------------------------------------------------

let home: TempHome
let cwdDir: string
let restoreEnv: () => void
const originalCwd = process.cwd()

beforeEach(() => {
	restoreEnv = clearConfigEnv()
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-fred-cwd-'))
	process.chdir(cwdDir)
	process.env.FRED_API_KEY = API_KEY
})

afterEach(() => {
	vi.useRealTimers()
	process.chdir(originalCwd)
	rmSync(cwdDir, { recursive: true, force: true })
	home.cleanup()
	restoreEnv()
})

/** A provider from a brand new module generation (fresh config + token bucket). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<FredModule>('../../src/providers/fred.js')
	return mod.fred
}

/** Same, but with the rate limiter from that generation so tokens are observable. */
async function importWithLimiter(): Promise<{ provider: Provider; remaining: () => number }> {
	const mods = await freshImportAll({
		fred: '../../src/providers/fred.js',
		limiter: '../../src/core/rate-limiter.js',
	})
	const provider = (mods.fred as unknown as FredModule).fred
	const limiter = mods.limiter as unknown as LimiterModule
	return { provider, remaining: () => limiter.getRemaining('fred', provider.rateLimits) }
}

interface MountOptions {
	obs?: Responder
	series?: Responder
	search?: Responder
	categories?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = []
	if (options.obs) routes.push({ match: OBS_MATCH, respond: options.obs })
	if (options.search) routes.push({ match: SEARCH_MATCH, respond: options.search })
	if (options.series) routes.push({ match: SERIES_MATCH, respond: options.series })
	if (options.categories) routes.push({ match: CATEGORIES_MATCH, respond: options.categories })
	return mockFetch(routes)
}

/** Shorthand for the two-request macro/get pair. */
function mountSeries(rows: readonly ObsRow[], meta: unknown = GDP_SERIES): FetchMock {
	return mount({ obs: { json: observations(rows) }, series: { json: meta } })
}

async function getSeries(
	provider: Provider,
	args: Record<string, unknown> = { seriesId: 'GDP' },
): Promise<MacroSeries> {
	const result = await provider.execute<MacroSeries>('macro', 'get', args)
	return result.data
}

async function searchSeries(
	provider: Provider,
	args: Record<string, unknown> = { query: 'unemployment' },
): Promise<FredSearchRow[]> {
	const result = await provider.execute<FredSearchRow[]>('macro', 'search', args)
	return result.data
}

async function getCategories(
	provider: Provider,
	args: Record<string, unknown> = {},
): Promise<FredCategoryRow[]> {
	const result = await provider.execute<FredCategoryRow[]>('macro', 'categories', args)
	return result.data
}

async function search(
	provider: Provider,
	args: Record<string, unknown> = { query: 'unemployment' },
): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', args)
	return result.data
}

/** Removes the key env var (biome forbids the `delete` operator). */
function unsetApiKey(): void {
	Reflect.deleteProperty(process.env, 'FRED_API_KEY')
}

function writeKeyConfig(key: string): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify({ fredApiKey: key }, null, 2))
}

/** True when every date is strictly later than the one before it. */
function isAscending(dates: readonly string[]): boolean {
	for (let i = 1; i < dates.length; i++) {
		if (dates[i - 1] >= dates[i]) return false
	}
	return true
}

function pinClock(): void {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
}

describe('provider metadata', () => {
	it('identifies itself as fred and demands a key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('fred')
		expect(provider.requiresKey).toBe(true)
		expect(provider.keyEnvVar).toBe('FRED_API_KEY')
	})

	it('advertises the macro and search categories with their priorities', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['macro', 'search'])
		expect(provider.priority).toEqual({ macro: 1, search: 5 })
	})

	it('advertises the documented limit of 120 requests per minute', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 120, windowMs: 60_000 })
	})
})

describe('isEnabled', () => {
	it('is enabled when FRED_API_KEY is set', async () => {
		const fx = mount()
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
		expect(fx.callCount()).toBe(0)
	})

	it('is disabled when no key is configured anywhere', async () => {
		unsetApiKey()
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('is enabled from the config file alone', async () => {
		unsetApiKey()
		writeKeyConfig('file-fred-key')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
	})

	it('is disabled when the env var is an empty string', async () => {
		process.env.FRED_API_KEY = ''
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('is disabled when the config file holds an empty key', async () => {
		unsetApiKey()
		writeKeyConfig('')
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})

	it('ignores another provider key entirely', async () => {
		unsetApiKey()
		process.env.COINGECKO_API_KEY = 'cg-key'
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(false)
	})
})

describe('authentication', () => {
	it('sends the configured key as the api_key query param', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.query(OBS_MATCH).api_key).toBe(API_KEY)
	})

	it('carries api_key and file_type on every request of a multi-call action', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.callCount()).toBe(2)
		for (const call of fx.calls) {
			expect(call.parsed.searchParams.get('api_key')).toBe(API_KEY)
			expect(call.parsed.searchParams.get('file_type')).toBe('json')
		}
	})

	it('prefers the environment key over the config file', async () => {
		writeKeyConfig('file-fred-key')
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider)

		expect(fx.query(SEARCH_MATCH).api_key).toBe(API_KEY)
	})

	it('falls back to the config file key', async () => {
		unsetApiKey()
		writeKeyConfig('file-fred-key')
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider)

		expect(fx.query(SEARCH_MATCH).api_key).toBe('file-fred-key')
	})

	it('throws a configuration hint when no key is available', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(
			'FRED API key not configured. Set FRED_API_KEY env var or run: omd config set fredApiKey <key>',
		)
	})

	it('never issues a request when the key is missing', async () => {
		unsetApiKey()
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow('FRED API key not configured')

		expect(fx.callCount()).toBe(0)
	})

	it('rejects macro/get without a key before either request goes out', async () => {
		unsetApiKey()
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('FRED API key not configured')

		expect(fx.callCount()).toBe(0)
	})

	it('rejects macro/categories without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(getCategories(provider)).rejects.toThrow('FRED API key not configured')
	})

	it('rejects search/search without a key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(search(provider)).rejects.toThrow('FRED API key not configured')
	})

	it('treats an empty-string key as missing', async () => {
		process.env.FRED_API_KEY = ''
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow('FRED API key not configured')
	})

	it('url-encodes a key containing reserved characters', async () => {
		process.env.FRED_API_KEY = 'a b&c'
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider)

		expect(fx.urls(SEARCH_MATCH)[0]).toContain('api_key=a+b%26c')
		expect(fx.query(SEARCH_MATCH).api_key).toBe('a b&c')
	})
})

describe('request plumbing', () => {
	it('builds both macro/get urls against the FRED base url', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.urls()).toEqual([
			`${BASE_URL}/series/observations?api_key=${API_KEY}&file_type=json&series_id=GDP`,
			`${BASE_URL}/series?api_key=${API_KEY}&file_type=json&series_id=GDP`,
		])
	})

	it('requests observations before series metadata', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.calls.map((c) => c.parsed.pathname)).toEqual([
			'/fred/series/observations',
			'/fred/series',
		])
	})

	it('asks for JSON rather than the default XML on every route', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider)

		expect(fx.query(CATEGORIES_MATCH).file_type).toBe('json')
	})

	it('omits parameters whose value is undefined', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: undefined, end: undefined })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
		})
	})

	it('omits parameters whose value is an empty string', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: '', end: '' })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
		})
	})

	it('keeps a supplied parameter while dropping its empty sibling', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', end: '' })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			observation_start: '2023-01-01',
		})
	})

	it('surfaces the status and body of a non-OK response', async () => {
		const body =
			'{"error_code":400,"error_message":"Bad Request. The value for variable series_id is not valid."}'
		mount({ search: { status: 400, text: body } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(`FRED API error (400): ${body}`)
	})

	it('reports a 429 with the upstream body verbatim', async () => {
		mount({ search: { status: 429, text: 'Too Many Requests' } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow('FRED API error (429): Too Many Requests')
	})

	it('reports a bad key as a 400 rather than a config error', async () => {
		mount({ search: { status: 400, text: 'api_key is not a valid 32 character alpha-numeric' } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(
			'FRED API error (400): api_key is not a valid 32 character alpha-numeric',
		)
	})

	it('reports an empty body as a trailing colon', async () => {
		mount({ search: { status: 503 } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow('FRED API error (503): ')
	})

	it('propagates an observations failure out of macro/get', async () => {
		mount({ obs: { status: 500, text: 'boom' }, series: { json: GDP_SERIES } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('FRED API error (500): boom')
	})

	it('propagates a metadata failure out of macro/get', async () => {
		mount({ obs: { json: observations(GDP_ROWS) }, series: { status: 404, text: 'not found' } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('FRED API error (404): not found')
	})

	it('propagates a network-level rejection untouched', async () => {
		mount({ search: { throw: new Error('ECONNREFUSED') } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow('ECONNREFUSED')
	})

	it('rejects malformed JSON from an OK response', async () => {
		mount({ search: { text: '<html>maintenance</html>' } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(SyntaxError)
	})

	it('treats a 204 as success rather than an error', async () => {
		// NOTE: suspected bug — `response.ok` is true for 204, so the empty body reaches
		// `response.json()` and surfaces as a raw SyntaxError instead of a provider error.
		mount({ search: { status: 204 } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(SyntaxError)
	})
})

describe('rate limiting', () => {
	it('allows exactly 120 requests before the bucket runs dry', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()
		pinClock()

		for (let i = 0; i < 120; i++) {
			await searchSeries(provider)
		}

		await expect(searchSeries(provider)).rejects.toThrow(
			'FRED rate limit exceeded. Try again shortly.',
		)
		expect(fx.callCount()).toBe(120)
	})

	it('spends two tokens on a macro/get because it also fetches metadata', async () => {
		mountSeries(GDP_ROWS)
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		expect(remaining()).toBe(120)
		await getSeries(provider)

		expect(remaining()).toBe(118)
	})

	it('spends one token on a macro/search', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await searchSeries(provider)

		expect(remaining()).toBe(119)
	})

	it('spends one token on a macro/categories', async () => {
		mount({ categories: { json: CATEGORY_CHILDREN } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await getCategories(provider)

		expect(remaining()).toBe(119)
	})

	it('checks the key before spending a token, so an unconfigured install keeps its budget', async () => {
		unsetApiKey()
		mount({ search: { json: SERIES_SEARCH } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		for (let i = 0; i < 5; i++) {
			await expect(searchSeries(provider)).rejects.toThrow('FRED API key not configured')
		}

		expect(remaining()).toBe(120)
	})

	it('still spends a token when the upstream call fails', async () => {
		mount({ search: { status: 500, text: 'boom' } })
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		await expect(searchSeries(provider)).rejects.toThrow('FRED API error (500)')

		expect(remaining()).toBe(119)
	})

	it('fails the metadata half of macro/get when only one token is left', async () => {
		const fx = mount({
			obs: { json: observations(GDP_ROWS) },
			series: { json: GDP_SERIES },
			search: { json: SERIES_SEARCH },
		})
		const { provider, remaining } = await importWithLimiter()
		pinClock()

		for (let i = 0; i < 119; i++) {
			await searchSeries(provider)
		}
		expect(remaining()).toBe(1)

		await expect(getSeries(provider)).rejects.toThrow('FRED rate limit exceeded')
		expect(fx.callCount(OBS_MATCH)).toBe(1)
		expect(fx.callCount(SERIES_MATCH)).toBe(0)
	})

	it('gives every module generation a fresh bucket', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const first = await importProvider()
		pinClock()

		for (let i = 0; i < 120; i++) {
			await searchSeries(first)
		}
		await expect(searchSeries(first)).rejects.toThrow('rate limit exceeded')

		const second = await importProvider()
		await expect(searchSeries(second)).resolves.toBeDefined()
	})
})

describe('macro/get validation', () => {
	it('rejects a missing seriesId', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', {})).rejects.toThrow('seriesId is required')
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an undefined seriesId', async () => {
		const provider = await importProvider()

		await expect(getSeries(provider, { seriesId: undefined })).rejects.toThrow(
			'seriesId is required',
		)
	})

	it('rejects an empty-string seriesId', async () => {
		const provider = await importProvider()

		await expect(getSeries(provider, { seriesId: '' })).rejects.toThrow('seriesId is required')
	})

	it('checks the seriesId before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', {})).rejects.toThrow('seriesId is required')
	})
})

describe('macro/get request shaping', () => {
	it('sends the seriesId exactly as given, without upper-casing it', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'gdp' })

		expect(fx.query(OBS_MATCH).series_id).toBe('gdp')
		expect(fx.query(SERIES_MATCH).series_id).toBe('gdp')
	})

	it('maps start and end onto observation_start and observation_end', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', end: '2024-01-01' })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			observation_start: '2023-01-01',
			observation_end: '2024-01-01',
		})
	})

	it('never forwards start, end or limit to the metadata request', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', end: '2024-01-01', limit: 2 })

		expect(fx.query(SERIES_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
		})
	})

	it('ignores arguments it does not understand, such as country', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', country: 'US', frequency: 'q' })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
		})
	})

	it('url-encodes a seriesId containing reserved characters', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'A&B C' })

		expect(fx.urls(OBS_MATCH)[0]).toContain('series_id=A%26B+C')
		expect(fx.query(OBS_MATCH).series_id).toBe('A&B C')
	})
})

describe('macro/get limit and sort: (a) limit without start', () => {
	it('asks FRED for the newest rows via sort_order=desc plus limit', async () => {
		const fx = mountSeries(GDP_ROWS_DESC.slice(0, 3))
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', limit: 3 })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			limit: '3',
			sort_order: 'desc',
		})
	})

	it('reverses the descending page back into chronological order', async () => {
		mountSeries(GDP_ROWS_DESC.slice(0, 3))
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 3 })

		expect(series.data).toEqual([
			{ date: '2023-07-01', value: 27610.128 },
			{ date: '2023-10-01', value: 27956.998 },
			{ date: '2024-01-01', value: 28269.176 },
		])
	})

	it('returns dates in ascending order', async () => {
		mountSeries(GDP_ROWS_DESC)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 5 })

		expect(isAscending(series.data.map((d) => d.date))).toBe(true)
	})

	it('filters placeholders before reversing, keeping the rest chronological', async () => {
		mountSeries([
			['2024-01-01', '28269.176'],
			['2023-10-01', '.'],
			['2023-07-01', '27610.128'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 3 })

		expect(series.data).toEqual([
			{ date: '2023-07-01', value: 27610.128 },
			{ date: '2024-01-01', value: 28269.176 },
		])
	})

	it('does not truncate locally — it trusts FRED to honour the limit', async () => {
		mountSeries(GDP_ROWS_DESC)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 2 })

		expect(series.data).toHaveLength(5)
		expect(series.data[0].date).toBe('2023-01-01')
	})

	it('treats an empty start as absent and still sorts descending', async () => {
		const fx = mountSeries(GDP_ROWS_DESC.slice(0, 2))
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '', limit: 2 })

		expect(fx.query(OBS_MATCH).sort_order).toBe('desc')
		expect(fx.query(OBS_MATCH).observation_start).toBeUndefined()
		expect(series.data.map((d) => d.date)).toEqual(['2023-10-01', '2024-01-01'])
	})

	it('still sorts descending when only an end date is supplied', async () => {
		const fx = mountSeries(GDP_ROWS_DESC.slice(0, 2))
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', end: '2024-01-01', limit: 2 })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			observation_end: '2024-01-01',
			limit: '2',
			sort_order: 'desc',
		})
	})

	it('handles a limit of one', async () => {
		mountSeries([['2024-01-01', '28269.176']])
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 1 })

		expect(series.data).toEqual([{ date: '2024-01-01', value: 28269.176 }])
	})

	it('sends limit=0 upstream and reverses the whole payload', async () => {
		// NOTE: suspected bug — `limit != null` treats 0 as a real limit, so `--limit 0`
		// asks FRED for `limit=0` (outside its documented 1..100000 range) and no
		// truncation happens locally either.
		const fx = mountSeries(GDP_ROWS_DESC)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: 0 })

		expect(fx.query(OBS_MATCH).limit).toBe('0')
		expect(fx.query(OBS_MATCH).sort_order).toBe('desc')
		expect(series.data).toHaveLength(5)
	})

	it('sends limit=NaN upstream when the CLI could not parse --limit', async () => {
		// NOTE: suspected bug — commands/macro.ts does `Number.parseInt(cmdOpts.limit, 10)`,
		// and `NaN != null` is true, so a typo like `--limit abc` reaches FRED as the
		// literal string "NaN" instead of being rejected locally.
		const fx = mountSeries(GDP_ROWS_DESC)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', limit: Number.NaN })

		expect(fx.query(OBS_MATCH).limit).toBe('NaN')
		expect(fx.query(OBS_MATCH).sort_order).toBe('desc')
	})
})

describe('macro/get limit and sort: (b) limit with start', () => {
	it('sends neither limit nor sort_order to FRED', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 2 })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			observation_start: '2023-01-01',
		})
	})

	it('keeps the last `limit` observations', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 2 })

		expect(series.data).toEqual([
			{ date: '2023-10-01', value: 27956.998 },
			{ date: '2024-01-01', value: 28269.176 },
		])
	})

	it('returns dates in ascending order', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 3 })

		expect(isAscending(series.data.map((d) => d.date))).toBe(true)
	})

	it('slices after filtering, not before', async () => {
		mountSeries([
			['2023-01-01', '1'],
			['2023-04-01', '2'],
			['2023-07-01', '.'],
			['2023-10-01', '4'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 2 })

		expect(series.data).toEqual([
			{ date: '2023-04-01', value: 2 },
			{ date: '2023-10-01', value: 4 },
		])
	})

	it('keeps everything when the limit exceeds the number of observations', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 99 })

		expect(series.data).toHaveLength(5)
	})

	it('keeps everything when the limit equals the number of observations', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 5 })

		expect(series.data.map((d) => d.date)).toEqual([
			'2023-01-01',
			'2023-04-01',
			'2023-07-01',
			'2023-10-01',
			'2024-01-01',
		])
	})

	it('keeps only the newest observation for a limit of one', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 1 })

		expect(series.data).toEqual([{ date: '2024-01-01', value: 28269.176 }])
	})

	it('returns every observation for a limit of zero', async () => {
		// NOTE: suspected bug — `slice(-0)` is `slice(0)`, so a zero limit returns the whole
		// series instead of nothing (or instead of falling back to a default).
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: 0 })

		expect(series.data).toHaveLength(5)
	})

	it('drops the OLDEST observations for a negative limit', async () => {
		// NOTE: suspected bug — `slice(-limit)` with limit=-2 becomes `slice(2)`, which
		// silently throws away the leading points instead of rejecting the input.
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', start: '2023-01-01', limit: -2 })

		expect(series.data.map((d) => d.date)).toEqual(['2023-07-01', '2023-10-01', '2024-01-01'])
	})
})

describe('macro/get limit and sort: (c) no limit', () => {
	it('requests neither limit nor sort_order', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP' })

		expect(fx.query(OBS_MATCH).limit).toBeUndefined()
		expect(fx.query(OBS_MATCH).sort_order).toBeUndefined()
	})

	it('returns every observation the API sent', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP' })

		expect(series.data.map((d) => d.date)).toEqual([
			'2023-01-01',
			'2023-04-01',
			'2023-07-01',
			'2023-10-01',
			'2024-01-01',
		])
	})

	it('preserves the payload order rather than sorting locally', async () => {
		mountSeries(GDP_ROWS_DESC)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP' })

		expect(series.data.map((d) => d.date)).toEqual([
			'2024-01-01',
			'2023-10-01',
			'2023-07-01',
			'2023-04-01',
			'2023-01-01',
		])
	})

	it('treats a null limit as absent', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP', limit: null })

		expect(fx.query(OBS_MATCH).limit).toBeUndefined()
		expect(fx.query(OBS_MATCH).sort_order).toBeUndefined()
		expect(series.data).toHaveLength(5)
	})

	it('treats an explicitly undefined limit as absent', async () => {
		const fx = mountSeries(GDP_ROWS)
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'GDP', limit: undefined, start: '2023-01-01' })

		expect(fx.query(OBS_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			series_id: 'GDP',
			observation_start: '2023-01-01',
		})
	})
})

describe('macro/get observation parsing', () => {
	const PARSED: [string, number][] = [
		['26813.601', 26813.601],
		['0', 0],
		['0.0', 0],
		['-1.5', -1.5],
		['3', 3],
		['1e3', 1000],
		['  4.25  ', 4.25],
	]

	it.each(PARSED)('parses the value %s into the number %d', async (raw, expected) => {
		mountSeries([['2024-01-01', raw]])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2024-01-01', value: expected }])
	})

	const DROPPED: string[] = ['.', 'N/A', 'n.a.', 'abc', '1,234.5', '--', '1.2.3']

	it.each(DROPPED)('drops the unparseable value %s', async (raw) => {
		mountSeries([
			['2023-10-01', raw],
			['2024-01-01', '28269.176'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2024-01-01', value: 28269.176 }])
	})

	it('drops every "." placeholder in a sparse series', async () => {
		mountSeries([
			['2023-01-01', '.'],
			['2023-04-01', '27063.012'],
			['2023-07-01', '.'],
			['2023-10-01', '27956.998'],
			['2024-01-01', '.'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([
			{ date: '2023-04-01', value: 27063.012 },
			{ date: '2023-10-01', value: 27956.998 },
		])
	})

	it('returns an empty data array when every value is a placeholder', async () => {
		mountSeries([
			['2023-01-01', '.'],
			['2023-04-01', '.'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([])
	})

	it('returns an empty data array for an empty observations list', async () => {
		mountSeries([])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([])
	})

	it('keeps a genuine zero observation', async () => {
		mountSeries([
			['2023-10-01', '0'],
			['2024-01-01', '1.5'],
		])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data.map((d) => d.value)).toEqual([0, 1.5])
	})

	it('keeps negative observations such as a trade deficit', async () => {
		mountSeries([['2024-01-01', '-68.9']])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data[0].value).toBe(-68.9)
	})

	it('turns a blank value into zero instead of dropping it', async () => {
		// NOTE: suspected bug — `Number('')` is 0, not NaN, so a blank value survives both
		// the "." check and the NaN check and becomes a real-looking data point at 0.
		mountSeries([['2024-01-01', '']])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2024-01-01', value: 0 }])
	})

	it('turns a null value into zero instead of dropping it', async () => {
		// NOTE: same root cause — `Number(null)` is 0.
		mountSeries([['2024-01-01', null]])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2024-01-01', value: 0 }])
	})

	it('passes the observation date straight through', async () => {
		mountSeries([['1947-01-01', '243.164']])
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data[0].date).toBe('1947-01-01')
	})

	it('throws a TypeError when the payload has no observations array', async () => {
		// NOTE: suspected bug — `obsData.observations` is dereferenced without a guard, so a
		// truncated payload surfaces as a raw TypeError instead of a provider error.
		mount({ obs: { json: { realtime_start: '2024-06-15' } }, series: { json: GDP_SERIES } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(TypeError)
	})
})

describe('macro/get series metadata', () => {
	it('populates id, title, units, frequency and seasonal adjustment', async () => {
		mountSeries(GDP_ROWS.slice(-1))
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series).toEqual({
			id: 'GDP',
			title: 'Gross Domestic Product',
			units: 'Billions of Dollars',
			frequency: 'Quarterly',
			seasonalAdjustment: 'Seasonally Adjusted Annual Rate',
			data: [{ date: '2024-01-01', value: 28269.176 }],
			source: 'fred',
		})
	})

	it('reports the source and cache flag on the envelope', async () => {
		mountSeries(GDP_ROWS)
		const provider = await importProvider()

		const result = await provider.execute<MacroSeries>('macro', 'get', { seriesId: 'GDP' })

		expect(result.source).toBe('fred')
		expect(result.cached).toBe(false)
	})

	it('takes the first entry when FRED returns several', async () => {
		mountSeries(GDP_ROWS.slice(-1), {
			seriess: [
				{ ...GDP_SERIES.seriess[0], id: 'FIRST', title: 'First Series' },
				{ ...GDP_SERIES.seriess[0], id: 'SECOND', title: 'Second Series' },
			],
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.id).toBe('FIRST')
		expect(series.title).toBe('First Series')
	})

	it('prefers the canonical id from the metadata over the requested one', async () => {
		mountSeries(GDP_ROWS.slice(-1))
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'gdp' })

		expect(series.id).toBe('GDP')
	})

	it('falls back to the requested seriesId when seriess is empty', async () => {
		mountSeries(GDP_ROWS.slice(-1), { realtime_start: '2024-06-15', seriess: [] })
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'MADEUPSERIES' })

		expect(series.id).toBe('MADEUPSERIES')
		expect(series.title).toBe('MADEUPSERIES')
	})

	it('leaves units, frequency and seasonal adjustment undefined when seriess is empty', async () => {
		mountSeries(GDP_ROWS.slice(-1), { seriess: [] })
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'MADEUPSERIES' })

		expect(series.units).toBeUndefined()
		expect(series.frequency).toBeUndefined()
		expect(series.seasonalAdjustment).toBeUndefined()
	})

	it('still returns the observations when seriess is empty', async () => {
		mountSeries(GDP_ROWS, { seriess: [] })
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'GDP' })

		expect(series.data).toHaveLength(5)
		expect(series.source).toBe('fred')
	})

	it('falls back to the seriesId when the metadata entry has no id', async () => {
		mountSeries(GDP_ROWS.slice(-1), {
			seriess: [{ title: 'Untitled but present', units: 'Percent' }],
		})
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'UNRATE' })

		expect(series.id).toBe('UNRATE')
		expect(series.title).toBe('Untitled but present')
		expect(series.units).toBe('Percent')
	})

	it('falls back to the seriesId when the metadata entry has no title', async () => {
		mountSeries(GDP_ROWS.slice(-1), { seriess: [{ id: 'UNRATE', units: 'Percent' }] })
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'UNRATE' })

		expect(series.title).toBe('UNRATE')
	})

	it('throws a TypeError when the metadata payload has no seriess key', async () => {
		// NOTE: suspected bug — `metaData.seriess[0]` is dereferenced without a guard, so a
		// truncated payload surfaces as a raw TypeError instead of a provider error.
		mount({ obs: { json: observations(GDP_ROWS) }, series: { json: { count: 0 } } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(TypeError)
	})
})

describe('macro/search', () => {
	it('maps every field FRED returns for a series', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await searchSeries(provider)

		expect(results[0]).toEqual({
			id: 'UNRATE',
			title: 'Unemployment Rate',
			units: 'Percent',
			frequency: 'Monthly',
			seasonal_adjustment: 'Seasonally Adjusted',
			popularity: 93,
		})
	})

	it('drops the fields the CLI does not display', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await searchSeries(provider)

		expect(Object.keys(results[1]).sort()).toEqual([
			'frequency',
			'id',
			'popularity',
			'seasonal_adjustment',
			'title',
			'units',
		])
	})

	it('returns every hit in the order FRED ranked them', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await searchSeries(provider)

		expect(results.map((r) => r.id)).toEqual(['UNRATE', 'UNRATENSA'])
		expect(results.map((r) => r.popularity)).toEqual([93, 64])
	})

	it('builds the search url with popularity ordering and a default limit of 20', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'unemployment' })

		expect(fx.urls()).toEqual([UNEMPLOYMENT_SEARCH_URL])
	})

	it('passes an explicit limit through', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'gdp', limit: 5 })

		expect(fx.query(SEARCH_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			search_text: 'gdp',
			limit: '5',
			order_by: 'popularity',
			sort_order: 'desc',
		})
	})

	it('defaults the limit to 20 when it is undefined', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'gdp', limit: undefined })

		expect(fx.query(SEARCH_MATCH).limit).toBe('20')
	})

	it('defaults the limit to 20 when it is null', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'gdp', limit: null })

		expect(fx.query(SEARCH_MATCH).limit).toBe('20')
	})

	it('sends limit=0 rather than defaulting for a zero limit', async () => {
		// NOTE: suspected bug — `?? 20` only fires for null/undefined, so `--limit 0` asks
		// FRED for zero rows (outside its documented 1..1000 range) instead of defaulting.
		const fx = mount({ search: { json: { seriess: [] } } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'gdp', limit: 0 })

		expect(fx.query(SEARCH_MATCH).limit).toBe('0')
	})

	it('sends the query verbatim as search_text', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'Real GDP' })

		expect(fx.query(SEARCH_MATCH).search_text).toBe('Real GDP')
	})

	it('url-encodes a query with spaces and reserved characters', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider, { query: 'real gdp & cpi' })

		expect(fx.urls(SEARCH_MATCH)[0]).toContain('search_text=real+gdp+%26+cpi')
		expect(fx.query(SEARCH_MATCH).search_text).toBe('real gdp & cpi')
	})

	it('rejects a missing query', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'search', {})).rejects.toThrow('query is required')
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string query', async () => {
		const provider = await importProvider()

		await expect(searchSeries(provider, { query: '' })).rejects.toThrow('query is required')
	})

	it('checks the query before the API key', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'search', {})).rejects.toThrow('query is required')
	})

	it('returns an empty list when nothing matches', async () => {
		mount({ search: { json: { count: 0, seriess: [] } } })
		const provider = await importProvider()

		const results = await searchSeries(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const result = await provider.execute<FredSearchRow[]>('macro', 'search', { query: 'gdp' })

		expect(result.source).toBe('fred')
		expect(result.cached).toBe(false)
	})

	it('issues exactly one request', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await searchSeries(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('leaves fields undefined when FRED omits them', async () => {
		mount({ search: { json: { seriess: [{ id: 'SPARSE', title: 'Sparse Series' }] } } })
		const provider = await importProvider()

		const results = await searchSeries(provider, { query: 'sparse' })

		expect(results[0]).toEqual({
			id: 'SPARSE',
			title: 'Sparse Series',
			units: undefined,
			frequency: undefined,
			seasonal_adjustment: undefined,
			popularity: undefined,
		})
	})

	it('throws a TypeError when the payload has no seriess array', async () => {
		// NOTE: suspected bug — `data.seriess.map` is called without a guard, so a truncated
		// payload surfaces as a raw TypeError instead of a provider error.
		mount({ search: { json: { count: 0 } } })
		const provider = await importProvider()

		await expect(searchSeries(provider)).rejects.toThrow(TypeError)
	})
})

describe('macro/categories', () => {
	it('defaults the categoryId to the root category', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider)

		expect(fx.urls()).toEqual([
			`${BASE_URL}/category/children?api_key=${API_KEY}&file_type=json&category_id=0`,
		])
	})

	it('passes an explicit categoryId through', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider, { categoryId: 32991 })

		expect(fx.query(CATEGORIES_MATCH)).toEqual({
			api_key: API_KEY,
			file_type: 'json',
			category_id: '32991',
		})
	})

	it('defaults to the root category when categoryId is null', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider, { categoryId: null })

		expect(fx.query(CATEGORIES_MATCH).category_id).toBe('0')
	})

	it('keeps an explicit zero categoryId', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider, { categoryId: 0 })

		expect(fx.query(CATEGORIES_MATCH).category_id).toBe('0')
	})

	it('stringifies a categoryId that arrived as a string', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider, { categoryId: '125' })

		expect(fx.query(CATEGORIES_MATCH).category_id).toBe('125')
	})

	it('renames parent_id to parentId', async () => {
		mount({
			categories: { json: { categories: [{ id: 33060, name: 'Debt', parent_id: 32991 }] } },
		})
		const provider = await importProvider()

		const categories = await getCategories(provider, { categoryId: 32991 })

		expect(categories).toEqual([{ id: 33060, name: 'Debt', parentId: 32991 }])
	})

	it('maps every child category', async () => {
		mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		const categories = await getCategories(provider)

		expect(categories).toEqual([
			{ id: 32991, name: 'Money, Banking, & Finance', parentId: 0 },
			{ id: 10, name: 'Population, Employment, & Labor Markets', parentId: 0 },
			{ id: 32992, name: 'National Accounts', parentId: 0 },
		])
	})

	it('returns an empty list for a leaf category', async () => {
		mount({ categories: { json: { categories: [] } } })
		const provider = await importProvider()

		const categories = await getCategories(provider, { categoryId: 33060 })

		expect(categories).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		const result = await provider.execute<FredCategoryRow[]>('macro', 'categories', {})

		expect(result.source).toBe('fred')
		expect(result.cached).toBe(false)
	})

	it('issues exactly one request', async () => {
		const fx = mount({ categories: { json: CATEGORY_CHILDREN } })
		const provider = await importProvider()

		await getCategories(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('throws a TypeError when the payload has no categories array', async () => {
		// NOTE: suspected bug — `data.categories.map` is called without a guard, so a
		// truncated payload surfaces as a raw TypeError instead of a provider error.
		mount({ categories: { json: {} } })
		const provider = await importProvider()

		await expect(getCategories(provider)).rejects.toThrow(TypeError)
	})
})

describe('search/search', () => {
	it('maps series hits onto SearchResult rows', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results).toEqual([
			{ symbol: 'UNRATE', name: 'Unemployment Rate', type: 'macro-series', source: 'fred' },
			{
				symbol: 'UNRATENSA',
				name: 'Unemployment Rate (Not Seasonally Adjusted)',
				type: 'macro-series',
				source: 'fred',
			},
		])
	})

	it('reuses the series search endpoint', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await search(provider, { query: 'unemployment' })

		expect(fx.urls()).toEqual([UNEMPLOYMENT_SEARCH_URL])
	})

	it('honours an explicit limit', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await search(provider, { query: 'gdp', limit: 3 })

		expect(fx.query(SEARCH_MATCH).limit).toBe('3')
	})

	it('drops the units, frequency and popularity metadata', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(Object.keys(results[0]).sort()).toEqual(['name', 'source', 'symbol', 'type'])
	})

	it('rejects a missing query', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('search', 'search', {})).rejects.toThrow('query is required')
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty-string query', async () => {
		const provider = await importProvider()

		await expect(search(provider, { query: '' })).rejects.toThrow('query is required')
	})

	it('returns an empty list when nothing matches', async () => {
		mount({ search: { json: { seriess: [] } } })
		const provider = await importProvider()

		const results = await search(provider, { query: 'zzzzzz' })

		expect(results).toEqual([])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'gdp' })

		expect(result.source).toBe('fred')
		expect(result.cached).toBe(false)
	})

	it('leaves the exchange field off every result', async () => {
		mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		const results = await search(provider)

		expect(results.every((r) => r.exchange === undefined)).toBe(true)
	})
})

describe('action dispatch', () => {
	it('rejects a category it does not serve', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'FRED provider does not support quote/get',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an unknown macro action', async () => {
		const provider = await importProvider()

		await expect(provider.execute('macro', 'observations', { seriesId: 'GDP' })).rejects.toThrow(
			'FRED provider does not support macro/observations',
		)
	})

	it('rejects an unknown search action', async () => {
		const provider = await importProvider()

		await expect(provider.execute('search', 'lookup', { query: 'gdp' })).rejects.toThrow(
			'FRED provider does not support search/lookup',
		)
	})

	it('rejects an empty action', async () => {
		const provider = await importProvider()

		await expect(provider.execute('macro', '', {})).rejects.toThrow(
			'FRED provider does not support macro/',
		)
	})

	it('matches actions case-sensitively', async () => {
		const provider = await importProvider()

		await expect(provider.execute('macro', 'GET', { seriesId: 'GDP' })).rejects.toThrow(
			'FRED provider does not support macro/GET',
		)
	})

	it('does not expose the macro actions under the search category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('search', 'categories', {})).rejects.toThrow(
			'FRED provider does not support search/categories',
		)
	})

	it('does not expose search/search under another category', async () => {
		const provider = await importProvider()

		await expect(provider.execute('crypto', 'search', { query: 'gdp' })).rejects.toThrow(
			'FRED provider does not support crypto/search',
		)
	})

	it('reports the unsupported route even when no key is configured', async () => {
		unsetApiKey()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'FRED provider does not support quote/get',
		)
	})

	it('never issues a request for an unsupported route', async () => {
		const fx = mount({ search: { json: SERIES_SEARCH } })
		const provider = await importProvider()

		await expect(provider.execute('macro', 'series', {})).rejects.toThrow('does not support')

		expect(fx.callCount()).toBe(0)
		expectNoUnmatched(fx)
	})
})
