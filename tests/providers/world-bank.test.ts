import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type { MacroSeries } from '../../src/types.js'
import {
	type FetchMock,
	type Responder,
	type Route,
	expectNoUnmatched,
	mockFetch,
} from '../helpers/mock-fetch.js'
import { freshImport } from '../helpers/modules.js'

/**
 * src/providers/world-bank.ts needs no API key, but it spends
 * `core/rate-limiter.ts` tokens from a module-scope bucket, so every test pulls
 * the provider through `freshImport` — that yields a fresh token bucket in the
 * same module generation.
 *
 * The provider derives year ranges from `new Date()`, and `new Date(s)
 * .getFullYear()` reads the year in the *local* zone. So every test freezes the
 * clock at 2024-06-15T12:00:00Z and pins $TZ to UTC; the one test that cares
 * about the zone sets it explicitly. Nothing here touches the network.
 */

type WorldBankModule = typeof import('../../src/providers/world-bank.js')

const BASE_URL = 'https://api.worldbank.org/v2'

/** GET /v2/country/<iso>/indicator/<series> */
const COUNTRY_MATCH = '/v2/country/'
/** GET /v2/indicator (the WDI catalogue used by macro/search) */
const INDICATOR_MATCH = '/v2/indicator'

const SERIES_ID = 'NY.GDP.MKTP.CD'

/** Frozen "now". Mid-June, so the year is 2024 at every UTC offset. */
const NOW = new Date('2024-06-15T12:00:00Z')

// --- Fixtures (shaped like real World Bank v2 payloads, trimmed) ------------

/** Element 0 of every World Bank response. */
const PAGINATION = {
	page: 1,
	pages: 1,
	per_page: 50,
	total: 3,
	sourceid: '2',
	lastupdated: '2024-05-30',
}

interface WbEntry {
	indicator: { id: string; value: string }
	country: { id: string; value: string }
	countryiso3code: string
	date: string
	value: number | null
	unit: string
	obs_status: string
	decimal: number
}

function entry(date: string, value: number | null, indicatorName = 'GDP (current US$)'): WbEntry {
	return {
		indicator: { id: SERIES_ID, value: indicatorName },
		country: { id: 'US', value: 'United States' },
		countryiso3code: 'USA',
		date,
		value,
		unit: '',
		obs_status: '',
		decimal: 0,
	}
}

/** The API returns observations newest-first. */
const GDP_ENTRIES: WbEntry[] = [
	entry('2023', 27_720_709_000_000),
	entry('2022', 26_006_893_000_000),
	entry('2021', 23_594_031_000_000),
]

const GDP_RESPONSE = [PAGINATION, GDP_ENTRIES]

interface WbIndicator {
	id: string
	name: string
	unit: string
	source: { id: string; value: string }
	sourceNote: string
	sourceOrganization: string
	topics: { id: string; value: string }[]
}

function indicator(id: string, name: string, unit = ''): WbIndicator {
	return {
		id,
		name,
		unit,
		source: { id: '2', value: 'World Development Indicators' },
		sourceNote: `Reference note for ${id}.`,
		sourceOrganization: 'World Bank national accounts data.',
		topics: [{ id: '3', value: 'Economy & Growth' }],
	}
}

/** GET /v2/indicator?format=json&per_page=2000&source=2 */
const INDICATORS: WbIndicator[] = [
	indicator('NY.GDP.MKTP.CD', 'GDP (current US$)'),
	indicator('NY.GDP.MKTP.KD.ZG', 'GDP growth (annual %)'),
	indicator('FP.CPI.TOTL.ZG', 'Inflation, consumer prices (annual %)'),
	indicator('SL.UEM.TOTL.ZS', 'Unemployment, total (% of total labor force)'),
	indicator('SP.POP.TOTL', 'Population, total'),
]

const INDICATOR_PAGINATION = { page: 1, pages: 1, per_page: 2000, total: INDICATORS.length }

const INDICATOR_RESPONSE = [INDICATOR_PAGINATION, INDICATORS]

/** `count` indicators that all match the query "trade", in a stable order. */
function tradeIndicators(count: number): WbIndicator[] {
	return Array.from({ length: count }, (_, i) => indicator(`TR.MRC.${i}`, `Trade metric ${i}`))
}

interface IndicatorHit {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
	popularity: number
}

// --- Per-test environment ---------------------------------------------------

const ORIGINAL_TZ = process.env.TZ

function setTimeZone(zone: string | undefined): void {
	if (zone === undefined) Reflect.deleteProperty(process.env, 'TZ')
	else process.env.TZ = zone
}

beforeEach(() => {
	setTimeZone('UTC')
	vi.useFakeTimers()
	vi.setSystemTime(NOW)
})

afterEach(() => {
	vi.useRealTimers()
	setTimeZone(ORIGINAL_TZ)
})

/** A provider from a brand new module generation (fresh token bucket). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<WorldBankModule>('../../src/providers/world-bank.js')
	return mod.worldBank
}

interface MountOptions {
	country?: Responder
	indicator?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = []
	if (options.country) routes.push({ match: COUNTRY_MATCH, respond: options.country })
	if (options.indicator) routes.push({ match: INDICATOR_MATCH, respond: options.indicator })
	return mockFetch(routes)
}

async function getSeries(
	provider: Provider,
	args: Record<string, unknown> = { seriesId: SERIES_ID },
): Promise<MacroSeries> {
	const result = await provider.execute<MacroSeries>('macro', 'get', args)
	return result.data
}

async function searchIndicators(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<IndicatorHit[]> {
	const result = await provider.execute<IndicatorHit[]>('macro', 'search', args)
	return result.data
}

describe('provider metadata', () => {
	it('identifies itself as worldbank and needs no key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('worldbank')
		expect(provider.requiresKey).toBe(false)
		expect(provider.keyEnvVar).toBeUndefined()
	})

	it('advertises only the macro category with its priority', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['macro'])
		expect(provider.priority).toEqual({ macro: 3 })
	})

	it('advertises a limit of thirty requests per minute', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 30, windowMs: 60_000 })
	})

	it('is unconditionally enabled and issues no request to decide', async () => {
		const fx = mount()
		const provider = await importProvider()

		expect(provider.isEnabled()).toBe(true)
		expect(fx.callCount()).toBe(0)
	})
})

describe('request plumbing', () => {
	it('always asks for format=json on macro/get', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.query(COUNTRY_MATCH).format).toBe('json')
	})

	it('always asks for format=json on macro/search', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await searchIndicators(provider, { query: 'gdp' })

		expect(fx.query(INDICATOR_MATCH).format).toBe('json')
	})

	it('builds the macro/get url from the v2 base', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.urls()).toEqual([
			`${BASE_URL}/country/US/indicator/${SERIES_ID}?format=json&per_page=50&date=2004%3A2024`,
		])
	})

	it('builds the macro/search url from the v2 base', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await searchIndicators(provider, { query: 'gdp' })

		expect(fx.urls()).toEqual([`${BASE_URL}/indicator?format=json&per_page=2000&source=2`])
	})

	it('issues a plain unauthenticated GET', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.call()?.method).toBe('GET')
		expect(fx.call()?.headers).toEqual({})
		expect(fx.call()?.body).toBeUndefined()
	})

	it('reports the status and body of a 404', async () => {
		mount({ country: { status: 404, text: 'Not Found' } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] API error (404): Not Found')
	})

	it('reports the status and body of a 500', async () => {
		mount({ country: { status: 500, text: 'Internal Server Error' } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(
			'[worldbank] API error (500): Internal Server Error',
		)
	})

	it('reports a 429 from the upstream throttle', async () => {
		mount({ indicator: { status: 429, text: 'Too Many Requests' } })
		const provider = await importProvider()

		await expect(searchIndicators(provider, { query: 'gdp' })).rejects.toThrow(
			'[worldbank] API error (429): Too Many Requests',
		)
	})

	it('reports an empty error body as a trailing colon', async () => {
		mount({ country: { status: 503 } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] API error (503): ')
	})

	it('propagates a network-level rejection untouched', async () => {
		mount({ country: { throw: new Error('ECONNREFUSED') } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('ECONNREFUSED')
	})

	it('rejects malformed JSON from an OK response', async () => {
		mount({ country: { text: 'not json at all' } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(SyntaxError)
	})

	it('treats a 204 as success and blows up on the empty body', async () => {
		// NOTE: suspected bug — `response.ok` is true for 204, so the empty body reaches
		// `response.json()` and surfaces as a raw SyntaxError instead of a provider error.
		mount({ country: { status: 204 } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(SyntaxError)
	})

	it('rejects a bare object payload as an unexpected format', async () => {
		mount({ country: { json: { message: 'nope' } } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('rejects a null payload as an unexpected format', async () => {
		mount({ country: { json: null } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('rejects a JSON string payload as an unexpected format', async () => {
		mount({ country: { json: 'service unavailable' } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('rejects an empty array as an unexpected format', async () => {
		mount({ country: { json: [] } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('rejects a one-element array as an unexpected format', async () => {
		mount({ country: { json: [PAGINATION] } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('swallows the upstream error envelope behind the format error', async () => {
		// NOTE: suspected bug — the API reports bad parameters as a *one-element* array
		// `[{message:[{id,key,value}]}]` with HTTP 200. The length check turns that into a
		// generic "Unexpected response format", so the actual reason is never surfaced.
		mount({
			country: {
				json: [
					{
						message: [
							{
								id: '120',
								key: 'Invalid value',
								value: 'The provided parameter value is not valid',
							},
						],
					},
				],
			},
		})
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow('[worldbank] Unexpected response format')
	})

	it('accepts a payload with more than two elements', async () => {
		mount({ country: { json: [PAGINATION, GDP_ENTRIES, { extra: true }] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toHaveLength(3)
	})

	it('ignores the pagination element entirely', async () => {
		mount({
			country: { json: [{ page: 1, pages: 9, per_page: 50, total: 999 }, GDP_ENTRIES] },
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toHaveLength(3)
	})
})

describe('rate limiting', () => {
	it('allows exactly thirty requests before the bucket runs dry', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		for (let i = 0; i < 30; i++) {
			await getSeries(provider)
		}

		await expect(getSeries(provider)).rejects.toThrow(
			'[worldbank] Rate limit exceeded. Try again shortly.',
		)
		expect(fx.callCount()).toBe(30)
	})

	it('shares one bucket between macro/get and macro/search', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE }, indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		for (let i = 0; i < 15; i++) {
			await getSeries(provider)
			await searchIndicators(provider, { query: 'gdp' })
		}

		await expect(searchIndicators(provider, { query: 'gdp' })).rejects.toThrow(
			'[worldbank] Rate limit exceeded',
		)
		expect(fx.callCount()).toBe(30)
	})

	it('does not spend a token on a request rejected by argument validation', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		for (let i = 0; i < 10; i++) {
			await expect(getSeries(provider, { seriesId: SERIES_ID, country: 'nope' })).rejects.toThrow(
				'Invalid country code',
			)
		}
		for (let i = 0; i < 30; i++) {
			await getSeries(provider)
		}

		await expect(getSeries(provider)).rejects.toThrow('Rate limit exceeded')
		expect(fx.callCount()).toBe(30)
	})

	it('refills the bucket as the window elapses', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		for (let i = 0; i < 30; i++) {
			await getSeries(provider)
		}
		await expect(getSeries(provider)).rejects.toThrow('Rate limit exceeded')

		vi.setSystemTime(new Date(NOW.getTime() + 60_000))
		await expect(getSeries(provider)).resolves.toBeDefined()
		expect(fx.callCount()).toBe(31)
	})

	it('gives every module generation a fresh bucket', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const first = await importProvider()

		for (let i = 0; i < 30; i++) {
			await getSeries(first)
		}
		await expect(getSeries(first)).rejects.toThrow('Rate limit exceeded')

		const second = await importProvider()
		await expect(getSeries(second)).resolves.toBeDefined()
	})
})

describe('macro/get argument validation', () => {
	it('requires a seriesId', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', {})).rejects.toThrow(
			'[worldbank] seriesId is required',
		)
	})

	it('treats an empty seriesId as missing', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(getSeries(provider, { seriesId: '' })).rejects.toThrow(
			'[worldbank] seriesId is required',
		)
	})

	it('issues no request when the seriesId is missing', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(provider.execute('macro', 'get', { country: 'US' })).rejects.toThrow(
			'seriesId is required',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('defaults the country to US', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.call()?.parsed.pathname).toBe(`/v2/country/US/indicator/${SERIES_ID}`)
	})

	it('defaults the country to US when it is explicitly undefined', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, country: undefined })

		expect(fx.call()?.parsed.pathname).toBe(`/v2/country/US/indicator/${SERIES_ID}`)
	})

	it('defaults the country to US when it is null', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, country: null })

		expect(fx.call()?.parsed.pathname).toBe(`/v2/country/US/indicator/${SERIES_ID}`)
	})

	const VALID_COUNTRIES = ['GB', 'gb', 'Gb', 'USA', 'usa', 'UsA', 'JP', 'ZWE']

	it.each(VALID_COUNTRIES)('accepts %s and puts it in the path verbatim', async (code) => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, country: code })

		expect(fx.call()?.parsed.pathname).toBe(`/v2/country/${code}/indicator/${SERIES_ID}`)
	})

	const INVALID_COUNTRIES = ['', '1', 'U', 'USAX', 'U5', 'US1', 'U-S', 'US ', '12']

	it.each(INVALID_COUNTRIES)('rejects %j as a country code', async (code) => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(getSeries(provider, { seriesId: SERIES_ID, country: code })).rejects.toThrow(
			`[worldbank] Invalid country code "${code}". Use ISO 3166-1 alpha-2 (e.g., US, GB, JP)`,
		)
	})

	it('issues no request for an invalid country code', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(
			getSeries(provider, { seriesId: SERIES_ID, country: 'UNITED-STATES' }),
		).rejects.toThrow('Invalid country code')
		expect(fx.callCount()).toBe(0)
	})

	it('validates the seriesId before the country', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await expect(getSeries(provider, { country: 'nope' })).rejects.toThrow(
			'[worldbank] seriesId is required',
		)
	})

	it('url-encodes a seriesId carrying path and query characters', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'NY GDP/CD?x=1&y' })

		expect(fx.call()?.parsed.pathname).toBe('/v2/country/US/indicator/NY%20GDP%2FCD%3Fx%3D1%26y')
		expect(fx.query(COUNTRY_MATCH)).toEqual({ format: 'json', per_page: '50', date: '2004:2024' })
	})

	it('leaves dots in a normal seriesId unescaped', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: 'FP.CPI.TOTL.ZG' })

		expect(fx.call()?.parsed.pathname).toBe('/v2/country/US/indicator/FP.CPI.TOTL.ZG')
	})
})

describe('macro/get parameter construction', () => {
	it('turns a limit into mrv and per_page and sends no date range', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: 5 })

		expect(fx.query(COUNTRY_MATCH)).toEqual({ format: 'json', mrv: '5', per_page: '5' })
	})

	it('sends both the limit and the date range when start is also given', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: 5, start: '2015-06-01' })

		expect(fx.query(COUNTRY_MATCH)).toEqual({
			format: 'json',
			mrv: '5',
			per_page: '5',
			date: '2015:2024',
		})
	})

	it('defaults a missing end to the current year', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2005-06-01' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2005:2024')
	})

	it('defaults a missing start to twenty years before the current year', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, end: '2015-06-30' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2004:2015')
	})

	it('uses both years when start and end are given', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2005-06-01', end: '2015-06-30' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2005:2015')
	})

	it('keeps per_page at fifty when a date range is requested', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2005-06-01' })

		expect(fx.query(COUNTRY_MATCH).per_page).toBe('50')
		expect(fx.query(COUNTRY_MATCH).mrv).toBeUndefined()
	})

	it('spans the last twenty years when neither limit nor dates are given', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.query(COUNTRY_MATCH)).toEqual({
			format: 'json',
			per_page: '50',
			date: '2004:2024',
		})
	})

	it('does not let a start after the end reorder the range', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2020-06-01', end: '2010-06-01' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2020:2010')
	})

	it('accepts a full ISO timestamp as start', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2012-03-04T05:06:07Z' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2012:2024')
	})

	it('treats a null limit as no limit at all', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: null })

		expect(fx.query(COUNTRY_MATCH)).toEqual({
			format: 'json',
			per_page: '50',
			date: '2004:2024',
		})
	})

	it('treats an undefined limit as no limit at all', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: undefined })

		expect(fx.query(COUNTRY_MATCH).per_page).toBe('50')
	})

	it('asks for the most recent zero values when the limit is zero', async () => {
		// NOTE: suspected bug — the `limit != null` guard admits 0, so `--limit 0` sends
		// `mrv=0&per_page=0` *and* suppresses the default date range instead of falling
		// back to the 50-row default.
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: 0 })

		expect(fx.query(COUNTRY_MATCH)).toEqual({ format: 'json', mrv: '0', per_page: '0' })
	})

	it('forwards a negative limit straight to mrv', async () => {
		// NOTE: same missing validation — a negative limit is passed through unchecked.
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: -3 })

		expect(fx.query(COUNTRY_MATCH)).toEqual({ format: 'json', mrv: '-3', per_page: '-3' })
	})

	it('drops paging entirely for an empty-string limit', async () => {
		// NOTE: suspected bug — an empty string is neither null nor undefined, so it wins
		// the limit branch and is then dropped by the `value !== ''` filter. The request
		// carries no per_page and no date, so the API falls back to its own defaults.
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, limit: '' })

		expect(fx.query(COUNTRY_MATCH)).toEqual({ format: 'json' })
	})

	it('ignores an empty-string start and end', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '', end: '' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2004:2024')
	})

	it('falls back to the default start when only the end is given as a date', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '', end: '2015-06-30' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2004:2015')
	})

	it('emits NaN in the range for an unparseable start', async () => {
		// NOTE: suspected bug — `new Date('last tuesday')` is Invalid Date, and its NaN
		// year is interpolated into the query as `date=NaN:2024` rather than rejected.
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: 'last tuesday' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('NaN:2024')
	})

	it('emits NaN in the range for an unparseable end', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, end: 'someday' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2004:NaN')
	})

	it('tracks the clock, so the default window moves with the year', async () => {
		vi.setSystemTime(new Date('2031-02-01T00:00:00Z'))
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.query(COUNTRY_MATCH).date).toBe('2011:2031')
	})

	it('reads a date-only start in UTC when the machine runs on UTC', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2010-01-01' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2010:2024')
	})

	it('shifts a date-only start into the previous year west of UTC', async () => {
		// NOTE: suspected bug — `new Date(start).getFullYear()` parses a date-only string
		// as UTC midnight but reads the year locally, so `--start 2010-01-01` asks for
		// 2009 onwards on any machine with a negative UTC offset.
		setTimeZone('America/New_York')
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider, { seriesId: SERIES_ID, start: '2010-01-01' })

		expect(fx.query(COUNTRY_MATCH).date).toBe('2009:2024')
	})
})

describe('macro/get data mapping', () => {
	it('maps entries onto an ascending macro series', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series).toEqual({
			id: SERIES_ID,
			title: 'GDP (current US$)',
			units: '',
			frequency: 'Annual',
			data: [
				{ date: '2021', value: 23_594_031_000_000 },
				{ date: '2022', value: 26_006_893_000_000 },
				{ date: '2023', value: 27_720_709_000_000 },
			],
			source: 'worldbank',
		})
	})

	it('reverses the newest-first order the API returns', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data.map((p) => p.date)).toEqual(['2021', '2022', '2023'])
	})

	it('sorts an already-shuffled series ascending', async () => {
		mount({
			country: {
				json: [PAGINATION, [entry('2005', 3), entry('2019', 1), entry('2011', 2)]],
			},
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([
			{ date: '2005', value: 3 },
			{ date: '2011', value: 2 },
			{ date: '2019', value: 1 },
		])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		const result = await provider.execute<MacroSeries>('macro', 'get', { seriesId: SERIES_ID })

		expect(result.source).toBe('worldbank')
		expect(result.cached).toBe(false)
	})

	it('returns an empty annual series when the data element is null', async () => {
		mount({ country: { json: [{ page: 0, pages: 0, per_page: 0, total: 0 }, null] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series).toEqual({
			id: SERIES_ID,
			title: SERIES_ID,
			units: '',
			frequency: 'Annual',
			data: [],
			source: 'worldbank',
		})
	})

	it('returns an empty annual series when the data element is an empty array', async () => {
		mount({ country: { json: [PAGINATION, []] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series).toEqual({
			id: SERIES_ID,
			title: SERIES_ID,
			units: '',
			frequency: 'Annual',
			data: [],
			source: 'worldbank',
		})
	})

	it('echoes an odd seriesId as the id and title of an empty series', async () => {
		mount({ country: { json: [PAGINATION, null] } })
		const provider = await importProvider()

		const series = await getSeries(provider, { seriesId: 'MADE.UP.CODE' })

		expect(series.id).toBe('MADE.UP.CODE')
		expect(series.title).toBe('MADE.UP.CODE')
	})

	it('reports the source and cache flag for an empty series too', async () => {
		mount({ country: { json: [PAGINATION, null] } })
		const provider = await importProvider()

		const result = await provider.execute<MacroSeries>('macro', 'get', { seriesId: SERIES_ID })

		expect(result.source).toBe('worldbank')
		expect(result.cached).toBe(false)
	})

	it('drops observations whose value is null', async () => {
		mount({
			country: {
				json: [PAGINATION, [entry('2023', null), entry('2022', 26), entry('2021', null)]],
			},
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2022', value: 26 }])
	})

	it('keeps the real title when every value is null', async () => {
		mount({ country: { json: [PAGINATION, [entry('2023', null), entry('2022', null)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([])
		expect(series.title).toBe('GDP (current US$)')
	})

	it('keeps a zero observation', async () => {
		mount({ country: { json: [PAGINATION, [entry('2023', 0)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2023', value: 0 }])
	})

	it('keeps a negative observation', async () => {
		mount({ country: { json: [PAGINATION, [entry('2020', -3.4)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([{ date: '2020', value: -3.4 }])
	})

	it('takes the title from the first entry', async () => {
		mount({
			country: {
				json: [
					PAGINATION,
					[entry('2023', 1, 'GDP, PPP (current international $)'), entry('2022', 2)],
				],
			},
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.title).toBe('GDP, PPP (current international $)')
	})

	it('falls back to the seriesId when the first indicator label is empty', async () => {
		mount({ country: { json: [PAGINATION, [entry('2023', 1, ''), entry('2022', 2)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.title).toBe(SERIES_ID)
	})

	it('uses the first entry label even when a later entry disagrees', async () => {
		mount({
			country: {
				json: [PAGINATION, [entry('2023', 1, 'First label'), entry('2022', 2, 'Second')]],
			},
		})
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.title).toBe('First label')
	})

	it('always reports an empty units string, ignoring the upstream unit', async () => {
		// NOTE: suspected bug — `units` is hardcoded to '' even though each observation
		// carries a `unit` field, so any unit the API does supply is discarded.
		mount({ country: { json: [PAGINATION, [{ ...entry('2023', 1), unit: 'current US$' }]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.units).toBe('')
	})

	it('always labels the frequency Annual, even for a quarterly-looking date', async () => {
		mount({ country: { json: [PAGINATION, [entry('2023Q4', 1)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.frequency).toBe('Annual')
		expect(series.data).toEqual([{ date: '2023Q4', value: 1 }])
	})

	it('keeps an undefined value that slipped past the null filter', async () => {
		// NOTE: suspected bug — the filter only excludes `null`, so an observation whose
		// `value` key is absent yields `{ date, value: undefined }` behind a
		// `value: number` type and reaches the formatter as a hole.
		const missing = { ...entry('2023', 0) } as Partial<WbEntry>
		Reflect.deleteProperty(missing, 'value')
		mount({ country: { json: [PAGINATION, [missing]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toHaveLength(1)
		expect(series.data[0].date).toBe('2023')
		expect(Object.hasOwn(series.data[0], 'value')).toBe(true)
		expect(series.data[0].value).toBeUndefined()
	})

	it('throws a TypeError when the first entry carries no indicator object', async () => {
		// NOTE: suspected bug — `entries[0].indicator.value` is read without a guard, so a
		// truncated payload surfaces as a raw TypeError instead of a provider error.
		const broken = { ...entry('2023', 1) } as Partial<WbEntry>
		Reflect.deleteProperty(broken, 'indicator')
		mount({ country: { json: [PAGINATION, [broken]] } })
		const provider = await importProvider()

		await expect(getSeries(provider)).rejects.toThrow(TypeError)
	})

	it('sorts dates as strings, so a two-digit date sorts before a four-digit one', async () => {
		mount({ country: { json: [PAGINATION, [entry('2000', 1), entry('99', 2)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data.map((p) => p.date)).toEqual(['2000', '99'])
	})

	it('preserves duplicate dates rather than collapsing them', async () => {
		mount({ country: { json: [PAGINATION, [entry('2023', 1), entry('2023', 2)]] } })
		const provider = await importProvider()

		const series = await getSeries(provider)

		expect(series.data).toEqual([
			{ date: '2023', value: 1 },
			{ date: '2023', value: 2 },
		])
	})

	it('issues exactly one request', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		await getSeries(provider)

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})
})

describe('macro/search', () => {
	it('requires a query', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await expect(provider.execute('macro', 'search', {})).rejects.toThrow(
			'[worldbank] query is required',
		)
	})

	it('treats an empty query as missing', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await expect(searchIndicators(provider, { query: '' })).rejects.toThrow(
			'[worldbank] query is required',
		)
	})

	it('issues no request when the query is missing', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await expect(provider.execute('macro', 'search', { limit: 5 })).rejects.toThrow(
			'query is required',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('asks for the whole WDI catalogue in one page', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await searchIndicators(provider, { query: 'gdp' })

		expect(fx.query(INDICATOR_MATCH)).toEqual({
			format: 'json',
			per_page: '2000',
			source: '2',
		})
	})

	it('never sends the query upstream — matching is local', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await searchIndicators(provider, { query: 'gdp' })

		expect(fx.query(INDICATOR_MATCH).query).toBeUndefined()
		expect(fx.urls()[0]).not.toContain('gdp')
	})

	it('issues exactly one request regardless of the limit', async () => {
		const fx = mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		await searchIndicators(provider, { query: 'gdp', limit: 1 })

		expect(fx.callCount()).toBe(1)
		expectNoUnmatched(fx)
	})

	it('matches the indicator name case-insensitively', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'GDP' })

		expect(hits.map((h) => h.id)).toEqual(['NY.GDP.MKTP.CD', 'NY.GDP.MKTP.KD.ZG'])
	})

	it('matches a lowercase query against a mixed-case name', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'inflation' })

		expect(hits.map((h) => h.id)).toEqual(['FP.CPI.TOTL.ZG'])
	})

	it('matches a substring in the middle of the name', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: '(annual %)' })

		expect(hits.map((h) => h.id)).toEqual(['NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG'])
	})

	it('matches against the name only, never the indicator id', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'SP.POP' })

		expect(hits).toEqual([])
	})

	it('returns an empty list when nothing matches', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'zzzz' })

		expect(hits).toEqual([])
	})

	it('preserves the upstream catalogue order', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(4)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade' })

		expect(hits.map((h) => h.id)).toEqual(['TR.MRC.0', 'TR.MRC.1', 'TR.MRC.2', 'TR.MRC.3'])
	})

	it('caps the result list at the requested limit', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(10)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: 3 })

		expect(hits.map((h) => h.id)).toEqual(['TR.MRC.0', 'TR.MRC.1', 'TR.MRC.2'])
	})

	it('defaults the limit to twenty', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(25)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade' })

		expect(hits).toHaveLength(20)
		expect(hits[19].id).toBe('TR.MRC.19')
	})

	it('defaults the limit to twenty when it is explicitly undefined', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(25)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: undefined })

		expect(hits).toHaveLength(20)
	})

	it('defaults the limit to twenty when it is null', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(25)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: null })

		expect(hits).toHaveLength(20)
	})

	it('returns every match when the limit exceeds the match count', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(3)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: 500 })

		expect(hits).toHaveLength(3)
	})

	it('returns nothing for a zero limit', async () => {
		// NOTE: suspected bug — the `?? 20` default only fires for null/undefined, so
		// `--limit 0` silently yields an empty result set instead of the default page.
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(10)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: 0 })

		expect(hits).toEqual([])
	})

	it('drops the last match for a limit of minus one', async () => {
		// NOTE: suspected bug — the limit is handed straight to `Array.slice`, so a
		// negative limit counts back from the end instead of being rejected.
		mount({ indicator: { json: [INDICATOR_PAGINATION, tradeIndicators(4)] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'trade', limit: -1 })

		expect(hits.map((h) => h.id)).toEqual(['TR.MRC.0', 'TR.MRC.1', 'TR.MRC.2'])
	})

	it('returns an empty list when the indicator list is null', async () => {
		mount({ indicator: { json: [{ page: 0, pages: 0, per_page: 0, total: 0 }, null] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'gdp' })

		expect(hits).toEqual([])
	})

	it('returns an empty list when the catalogue is an empty array', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, []] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'gdp' })

		expect(hits).toEqual([])
	})

	it('maps a matched indicator onto the search-result shape', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'population' })

		expect(hits).toEqual([
			{
				id: 'SP.POP.TOTL',
				title: 'Population, total',
				units: '',
				frequency: '',
				seasonal_adjustment: '',
				popularity: 0,
			},
		])
	})

	it('carries a non-empty unit through as units', async () => {
		mount({
			indicator: {
				json: [INDICATOR_PAGINATION, [indicator('EN.ATM.CO2E.PC', 'CO2 emissions', 'metric tons')]],
			},
		})
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'co2' })

		expect(hits[0].units).toBe('metric tons')
	})

	it('maps an empty unit to an empty string', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'population' })

		expect(hits[0].units).toBe('')
	})

	it('maps a missing unit to an empty string rather than undefined', async () => {
		const noUnit = { ...indicator('SP.POP.TOTL', 'Population, total') } as Partial<WbIndicator>
		Reflect.deleteProperty(noUnit, 'unit')
		mount({ indicator: { json: [INDICATOR_PAGINATION, [noUnit]] } })
		const provider = await importProvider()

		const hits = await searchIndicators(provider, { query: 'population' })

		expect(hits[0].units).toBe('')
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ indicator: { json: INDICATOR_RESPONSE } })
		const provider = await importProvider()

		const result = await provider.execute<IndicatorHit[]>('macro', 'search', { query: 'gdp' })

		expect(result.source).toBe('worldbank')
		expect(result.cached).toBe(false)
	})

	it('reports the source and cache flag for the null-catalogue shortcut too', async () => {
		mount({ indicator: { json: [INDICATOR_PAGINATION, null] } })
		const provider = await importProvider()

		const result = await provider.execute<IndicatorHit[]>('macro', 'search', { query: 'gdp' })

		expect(result).toEqual({ data: [], source: 'worldbank', cached: false })
	})

	it('throws a TypeError when an indicator carries no name', async () => {
		// NOTE: suspected bug — `ind.name.toLowerCase()` is called without a guard, so one
		// malformed catalogue row aborts the whole search with a raw TypeError.
		const nameless = { ...indicator('X.Y.Z', 'placeholder') } as Partial<WbIndicator>
		Reflect.deleteProperty(nameless, 'name')
		mount({ indicator: { json: [INDICATOR_PAGINATION, [nameless]] } })
		const provider = await importProvider()

		await expect(searchIndicators(provider, { query: 'gdp' })).rejects.toThrow(TypeError)
	})
})

describe('route dispatch', () => {
	it('rejects an unsupported category', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'[worldbank] Provider does not support quote/get',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an unknown macro action', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('macro', 'history', { seriesId: SERIES_ID })).rejects.toThrow(
			'[worldbank] Provider does not support macro/history',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects an empty action', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('macro', '', {})).rejects.toThrow(
			'[worldbank] Provider does not support macro/',
		)
	})

	it('does not expose search under the search category', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('search', 'search', { query: 'gdp' })).rejects.toThrow(
			'[worldbank] Provider does not support search/search',
		)
	})

	it('does not expose get under the history category', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('history', 'get', { seriesId: SERIES_ID })).rejects.toThrow(
			'[worldbank] Provider does not support history/get',
		)
	})

	it('spends no rate-limit token on an unsupported route', async () => {
		const fx = mount({ country: { json: GDP_RESPONSE } })
		const provider = await importProvider()

		for (let i = 0; i < 10; i++) {
			await expect(provider.execute('macro', 'series', {})).rejects.toThrow('does not support')
		}
		for (let i = 0; i < 30; i++) {
			await getSeries(provider)
		}

		await expect(getSeries(provider)).rejects.toThrow('Rate limit exceeded')
		expect(fx.callCount()).toBe(30)
	})
})
