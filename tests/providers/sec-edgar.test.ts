import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../../src/providers/types.js'
import type {
	Filing,
	FinancialStatement,
	InsiderTransaction,
	SearchResult,
} from '../../src/types.js'
import {
	type FetchMock,
	type Responder,
	type Route,
	expectNoUnmatched,
	mockFetch,
} from '../helpers/mock-fetch.js'
import { type TempHome, clearConfigEnv, freshImport, makeTempHome } from '../helpers/modules.js'

/**
 * src/providers/sec-edgar.ts keeps two pieces of module-scope state: the parsed
 * company_tickers.json map and a "already warned about the default User-Agent"
 * flag. Both must be pristine per test, so every test pulls the provider through
 * `freshImport`. That also gives each test a fresh `core/config.ts` (which
 * memoizes) and a fresh `core/rate-limiter.ts` bucket.
 *
 * $HOME points at a throwaway directory and the cwd at an empty one, so the
 * config layer can never read the developer's real config or a repo `.env`.
 * Nothing here touches the network or the wall clock.
 */

type SecEdgarModule = typeof import('../../src/providers/sec-edgar.js')

const TICKER_URL = 'https://www.sec.gov/files/company_tickers.json'
const TICKER_MATCH = 'company_tickers.json'
const FACTS_MATCH = '/api/xbrl/companyfacts/'
const SUBMISSIONS_MATCH = 'data.sec.gov/submissions/'
const SEARCH_MATCH = 'efts.sec.gov/LATEST/search-index'

const DEFAULT_USER_AGENT = 'open-market-data (dev@example.com)'

/** Shaped like https://www.sec.gov/files/company_tickers.json (trimmed). */
const COMPANY_TICKERS = {
	'0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
	'1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
	'2': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
	'3': { cik_str: 18230, ticker: 'CAT', title: 'CATERPILLAR INC' },
}

// --- XBRL fixture builders -------------------------------------------------

interface UnitRow {
	end: string
	val: number
	form?: string
	fp?: string
	fy?: number
	filed?: string
}

function unitRows(entries: UnitRow[]): Required<UnitRow>[] {
	return entries.map((entry) => ({
		form: '10-K',
		fp: 'FY',
		fy: 2023,
		filed: '2023-11-03',
		...entry,
	}))
}

function usd(entries: UnitRow[]): { units: Record<string, Required<UnitRow>[]> } {
	return { units: { USD: unitRows(entries) } }
}

function perShare(entries: UnitRow[]): { units: Record<string, Required<UnitRow>[]> } {
	return { units: { 'USD/shares': unitRows(entries) } }
}

function sharesUnit(entries: UnitRow[]): { units: Record<string, Required<UnitRow>[]> } {
	return { units: { shares: unitRows(entries) } }
}

function companyFacts(usGaap: Record<string, unknown>): Record<string, unknown> {
	return {
		cik: 320193,
		entityName: 'Apple Inc.',
		facts: { 'us-gaap': usGaap },
	}
}

/** Every tag the provider knows about, in one 10-K period. */
const FULL_FACTS = companyFacts({
	Revenues: usd([{ end: '2023-09-30', val: 383285000000 }]),
	GrossProfit: usd([{ end: '2023-09-30', val: 169148000000 }]),
	OperatingIncomeLoss: usd([{ end: '2023-09-30', val: 114301000000 }]),
	NetIncomeLoss: usd([{ end: '2023-09-30', val: 96995000000 }]),
	EarningsPerShareBasic: perShare([{ end: '2023-09-30', val: 6.16 }]),
	EarningsPerShareDiluted: perShare([{ end: '2023-09-30', val: 6.13 }]),
	Assets: usd([{ end: '2023-09-30', val: 352583000000 }]),
	Liabilities: usd([{ end: '2023-09-30', val: 290437000000 }]),
	StockholdersEquity: usd([{ end: '2023-09-30', val: 62146000000 }]),
	NetCashProvidedByOperatingActivities: usd([{ end: '2023-09-30', val: 110543000000 }]),
	LongTermDebt: usd([{ end: '2023-09-30', val: 95281000000 }]),
	CommonStockSharesOutstanding: sharesUnit([{ end: '2023-09-30', val: 15552752000 }]),
})

/** Shaped like https://data.sec.gov/submissions/CIK0000320193.json (trimmed). */
const SUBMISSIONS = {
	cik: '320193',
	name: 'Apple Inc.',
	filings: {
		recent: {
			accessionNumber: ['0000320193-24-000081', '0000320193-24-000069', '0000320193-23-000106'],
			filingDate: ['2024-05-03', '2024-02-02', '2023-11-03'],
			reportDate: ['2024-03-30', '2023-12-30', '2023-09-30'],
			form: ['10-Q', '10-Q', '10-K'],
			primaryDocument: ['aapl-20240330.htm', 'aapl-20231230.htm', 'aapl-20230930.htm'],
			primaryDocDescription: ['10-Q', '10-Q', '10-K'],
		},
	},
}

function submissionsWith(count: number, form = '8-K'): Record<string, unknown> {
	const index = Array.from({ length: count }, (_, i) => i)
	const day = (i: number) => String(i + 1).padStart(2, '0')
	return {
		cik: '320193',
		filings: {
			recent: {
				accessionNumber: index.map((i) => `0000320193-24-0000${String(i).padStart(2, '0')}`),
				filingDate: index.map((i) => `2024-06-${day(i)}`),
				reportDate: index.map((i) => `2024-05-${day(i)}`),
				form: index.map(() => form),
				primaryDocument: index.map((i) => `doc-${i}.htm`),
				primaryDocDescription: index.map(() => form),
			},
		},
	}
}

// --- EDGAR full-text search fixtures ---------------------------------------

interface SearchHit {
	_id: string
	_source: {
		display_names?: string[]
		file_date?: string
		form?: string
		file_description?: string
		adsh?: string
		ciks?: string[]
	}
}

function searchResponse(hits: SearchHit[]): Record<string, unknown> {
	return { took: 12, hits: { total: { value: hits.length }, hits } }
}

function form4Hit(overrides: Partial<SearchHit['_source']> & { adsh?: string }): SearchHit {
	return {
		_id: `${overrides.adsh ?? '0000320193-24-000078'}:xslF345X05/wf-form4.xml`,
		_source: {
			display_names: ['Cook Timothy D  (CIK 0001214128)', 'Apple Inc.  (CIK 0000320193)'],
			file_date: '2024-04-03',
			form: '4',
			file_description: 'FORM 4 SUBMISSION',
			adsh: '0000320193-24-000078',
			ciks: ['0001214128', '0000320193'],
			...overrides,
		},
	}
}

// --- Per-test environment ---------------------------------------------------

let home: TempHome
let cwdDir: string
let restoreEnv: () => void
let errorSpy: ReturnType<typeof vi.spyOn>
const originalCwd = process.cwd()

beforeEach(() => {
	restoreEnv = clearConfigEnv()
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-edgar-cwd-'))
	process.chdir(cwdDir)
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	vi.useRealTimers()
	process.chdir(originalCwd)
	rmSync(cwdDir, { recursive: true, force: true })
	home.cleanup()
	restoreEnv()
})

/** A provider from a brand new module generation (empty ticker cache). */
async function importProvider(): Promise<Provider> {
	const mod = await freshImport<SecEdgarModule>('../../src/providers/sec-edgar.js')
	return mod.secEdgar
}

interface MountOptions {
	tickers?: Responder
	facts?: Responder
	submissions?: Responder
	search?: Responder
}

/** Installs only the routes a test needs; anything else throws. */
function mount(options: MountOptions = {}): FetchMock {
	const routes: Route[] = [
		{ match: TICKER_MATCH, respond: options.tickers ?? { json: COMPANY_TICKERS } },
	]
	if (options.facts) routes.push({ match: FACTS_MATCH, respond: options.facts })
	if (options.submissions) routes.push({ match: SUBMISSIONS_MATCH, respond: options.submissions })
	if (options.search) routes.push({ match: SEARCH_MATCH, respond: options.search })
	return mockFetch(routes)
}

function writeUserAgentConfig(agent: string): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify({ edgarUserAgent: agent }, null, 2))
}

async function getFinancials(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<FinancialStatement[]> {
	const result = await provider.execute<FinancialStatement[]>('financials', 'get', args)
	return result.data
}

async function getFilings(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<Filing[]> {
	const result = await provider.execute<Filing[]>('filing', 'list', args)
	return result.data
}

async function getInsiders(
	provider: Provider,
	args: Record<string, unknown> = { symbol: 'AAPL' },
): Promise<InsiderTransaction[]> {
	const result = await provider.execute<InsiderTransaction[]>('insiders', 'list', args)
	return result.data
}

async function getSearch(
	provider: Provider,
	args: Record<string, unknown>,
): Promise<SearchResult[]> {
	const result = await provider.execute<SearchResult[]>('search', 'search', args)
	return result.data
}

describe('provider metadata', () => {
	it('identifies itself as sec-edgar and needs no api key', async () => {
		const provider = await importProvider()

		expect(provider.name).toBe('sec-edgar')
		expect(provider.requiresKey).toBe(false)
		expect(provider.isEnabled()).toBe(true)
	})

	it('advertises the four EDGAR categories with their priorities', async () => {
		const provider = await importProvider()

		expect(provider.capabilities).toEqual(['search', 'financials', 'filing', 'insiders'])
		expect(provider.priority).toEqual({ search: 2, financials: 1, filing: 1, insiders: 1 })
	})

	it('advertises the SEC fair-access limit of 10 requests per second', async () => {
		const provider = await importProvider()

		expect(provider.rateLimits).toEqual({ maxRequests: 10, windowMs: 1000 })
	})
})

describe('ticker map', () => {
	it('fetches company_tickers.json once and reuses it for later calls', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)
		await getFinancials(provider)
		await getFinancials(provider)

		expect(fx.urls(TICKER_MATCH)).toEqual([TICKER_URL])
		expect(fx.callCount(TICKER_MATCH)).toBe(1)
		expect(fx.callCount(FACTS_MATCH)).toBe(3)
		expectNoUnmatched(fx)
	})

	it('reuses the cached map across different categories', async () => {
		const fx = mount({ facts: { json: FULL_FACTS }, submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		await getFinancials(provider)
		await getFilings(provider)

		expect(fx.callCount(TICKER_MATCH)).toBe(1)
	})

	it('starts with an empty cache in every fresh module generation', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })

		const first = await importProvider()
		await getFinancials(first)
		const second = await importProvider()
		await getFinancials(second)

		expect(fx.callCount(TICKER_MATCH)).toBe(2)
	})

	it('throws a descriptive error when the ticker file is unavailable', async () => {
		mount({ tickers: { status: 503, statusText: 'Service Unavailable', text: 'busy' } })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow(
			'Failed to load company tickers: 503 Service Unavailable',
		)
	})

	it('reports the status even when the response carries no status text', async () => {
		mount({ tickers: { status: 403 } })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('Failed to load company tickers: 403 ')
	})

	it('retries the ticker file after a failed load', async () => {
		const fx = mockFetch([
			{ match: TICKER_MATCH, respond: { status: 500, statusText: 'Server Error' }, times: 1 },
			{ match: TICKER_MATCH, respond: { json: COMPANY_TICKERS } },
			{ match: FACTS_MATCH, respond: { json: FULL_FACTS } },
		])
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow('Failed to load company tickers')
		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(fx.callCount(TICKER_MATCH)).toBe(2)
	})

	it('throws for a ticker that is not in the map', async () => {
		mount()
		const provider = await importProvider()

		await expect(getFinancials(provider, { symbol: 'NOPE' })).rejects.toThrow(
			'Ticker "NOPE" not found in SEC EDGAR database',
		)
	})

	it('resolves tickers case-insensitively', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider, { symbol: 'aapl' })

		expect(fx.urls(FACTS_MATCH)).toEqual([
			'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
		])
	})

	it('uppercases tickers coming from the payload when building the map', async () => {
		const fx = mount({
			tickers: { json: { '0': { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' } } },
			facts: { json: FULL_FACTS },
		})
		const provider = await importProvider()

		await getFinancials(provider, { symbol: 'AAPL' })

		expect(fx.callCount(FACTS_MATCH)).toBe(1)
	})

	it('throws for any symbol when the ticker file is empty', async () => {
		mount({ tickers: { json: {} } })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow(
			'Ticker "AAPL" not found in SEC EDGAR database',
		)
	})

	it('propagates a malformed ticker payload instead of caching it', async () => {
		const fx = mockFetch([
			{ match: TICKER_MATCH, respond: { text: 'not json at all' }, times: 1 },
			{ match: TICKER_MATCH, respond: { json: COMPANY_TICKERS } },
			{ match: FACTS_MATCH, respond: { json: FULL_FACTS } },
		])
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow(SyntaxError)

		// The failed parse must leave the module-scope cache untouched: a second
		// call re-downloads company_tickers.json and succeeds on the good payload.
		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(fx.callCount(TICKER_MATCH)).toBe(2)
		expectNoUnmatched(fx)
	})

	it('does not de-duplicate concurrent loads of the ticker map', async () => {
		// NOTE: suspected bug — loadTickerMap caches only after the response lands,
		// so parallel calls each pay for a full company_tickers.json download.
		const fx = mount({ facts: { json: FULL_FACTS }, submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		await Promise.all([getFinancials(provider), getFilings(provider)])

		expect(fx.callCount(TICKER_MATCH)).toBe(2)
	})
})

describe('user agent', () => {
	it('sends the default user agent and asks for json', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.call(TICKER_MATCH)?.headers['user-agent']).toBe(DEFAULT_USER_AGENT)
		expect(fx.call(FACTS_MATCH)?.headers['user-agent']).toBe(DEFAULT_USER_AGENT)
		expect(fx.call(FACTS_MATCH)?.headers.accept).toBe('application/json')
	})

	it('warns exactly once even though a single call issues two requests', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		// Both requests go out with the default agent, but only the first one warns.
		expect(fx.callCount(TICKER_MATCH)).toBe(1)
		expect(fx.callCount(FACTS_MATCH)).toBe(1)
		expect(errorSpy).toHaveBeenCalledTimes(1)
		expect(errorSpy.mock.calls[0]).toHaveLength(1)
		expect(String(errorSpy.mock.calls[0][0])).toBe(
			'[sec-edgar] Warning: Using default User-Agent. Set EDGAR_USER_AGENT env var or run: omd config set edgarUserAgent "YourApp/1.0 (your@email.com)"',
		)
	})

	it('never repeats the warning for later calls in the same process', async () => {
		mount({ facts: { json: FULL_FACTS }, submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		await getFinancials(provider)
		await getFilings(provider)
		await getFinancials(provider)

		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it('warns again in a new module generation', async () => {
		mount({ facts: { json: FULL_FACTS } })

		const first = await importProvider()
		await getFinancials(first)
		const second = await importProvider()
		await getFinancials(second)

		expect(errorSpy).toHaveBeenCalledTimes(2)
	})

	it('uses EDGAR_USER_AGENT and stays silent', async () => {
		process.env.EDGAR_USER_AGENT = 'Acme Research (research@acme.test)'
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.call(TICKER_MATCH)?.headers['user-agent']).toBe('Acme Research (research@acme.test)')
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it('uses edgarUserAgent from the config file', async () => {
		writeUserAgentConfig('Filed Agent (filed@example.test)')
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.call(FACTS_MATCH)?.headers['user-agent']).toBe('Filed Agent (filed@example.test)')
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it('lets the environment variable beat the config file', async () => {
		writeUserAgentConfig('Filed Agent (filed@example.test)')
		process.env.EDGAR_USER_AGENT = 'Env Agent (env@example.test)'
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.call(TICKER_MATCH)?.headers['user-agent']).toBe('Env Agent (env@example.test)')
	})

	it('sends an empty user agent when the configured agent is an empty string', async () => {
		// NOTE: suspected bug — the warning is guarded by truthiness but the value is
		// picked with `??`, so a blank edgarUserAgent both warns about the default
		// AND sends `User-Agent: ` — a header the SEC answers with 403.
		writeUserAgentConfig('')
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider)

		expect(fx.call(TICKER_MATCH)?.headers['user-agent']).toBe('')
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})
})

describe('financials/get', () => {
	it('requires a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(getFinancials(provider, {})).rejects.toThrow('symbol is required for financials')
		expect(fx.callCount()).toBe(0)
	})

	it('zero-pads the CIK to ten digits in the companyfacts url', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await getFinancials(provider, { symbol: 'CAT' })

		expect(fx.urls(FACTS_MATCH)).toEqual([
			'https://data.sec.gov/api/xbrl/companyfacts/CIK0000018230.json',
		])
	})

	it('reports the source and cache flag on the envelope', async () => {
		mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		const result = await provider.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'AAPL',
		})

		expect(result.source).toBe('sec-edgar')
		expect(result.cached).toBe(false)
	})

	it('keeps only 10-K facts by default', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2023-09-30', val: 383285000000, form: '10-K', fp: 'FY', fy: 2023 },
						{ end: '2023-12-30', val: 119575000000, form: '10-Q', fp: 'Q1', fy: 2024 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements.map((s) => s.period)).toEqual(['FY-2023'])
		expect(statements[0].revenue).toBe(383285000000)
	})

	it('keeps only 10-Q facts when period is quarterly', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2023-09-30', val: 383285000000, form: '10-K', fp: 'FY', fy: 2023 },
						{ end: '2023-12-30', val: 119575000000, form: '10-Q', fp: 'Q1', fy: 2024 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'AAPL', period: 'quarterly' })

		expect(statements.map((s) => s.period)).toEqual(['Q1-2024'])
		expect(statements[0].revenue).toBe(119575000000)
	})

	it('treats an unrecognised period as annual', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2023-09-30', val: 383285000000, form: '10-K', fp: 'FY', fy: 2023 },
						{ end: '2023-12-30', val: 119575000000, form: '10-Q', fp: 'Q1', fy: 2024 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'AAPL', period: 'ttm' })

		expect(statements.map((s) => s.period)).toEqual(['FY-2023'])
	})

	it('ignores amended forms when filtering for 10-K', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2023-09-30', val: 383285000000, form: '10-K' },
						{ end: '2023-09-30', val: 999999999999, form: '10-K/A' },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(383285000000)
	})

	it('keys each statement by fiscal period and fiscal year', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2023-12-30', val: 119575000000, form: '10-Q', fp: 'Q1', fy: 2024 },
						{ end: '2024-03-30', val: 90753000000, form: '10-Q', fp: 'Q2', fy: 2024 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'AAPL', period: 'quarterly' })

		expect(statements.map((s) => s.period)).toEqual(['Q2-2024', 'Q1-2024'])
	})

	it('lets the last array entry for a period and tag win (restatement)', async () => {
		// NOTE: the product resolves a restatement by ARRAY POSITION, not by the
		// `filed` date the code comment claims — so the fixture deliberately puts
		// the two orders in conflict. The middle row carries the latest `filed`
		// date; the winner is the last row regardless.
		mount({
			facts: {
				json: companyFacts({
					NetIncomeLoss: usd([
						{ end: '2023-09-30', val: 96995000000, filed: '2023-11-03' },
						{ end: '2023-09-30', val: 97100000000, filed: '2025-02-01' },
						{ end: '2023-09-30', val: 97050000000, filed: '2024-11-01' },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		// 96995000000 would mean "first entry wins", 97100000000 "latest `filed`
		// wins"; only array position yields the third row's value.
		expect(statements[0].netIncome).toBe(97050000000)
	})

	it('resolves restatements by array order rather than filing date', async () => {
		// NOTE: suspected bug — the code comments promise "later entries (by filing
		// date) overwrite earlier", but `filed` is never compared, so whichever entry
		// happens to come last in the units array wins.
		mount({
			facts: {
				json: companyFacts({
					NetIncomeLoss: usd([
						{ end: '2023-09-30', val: 97100000000, filed: '2024-11-01' },
						{ end: '2023-09-30', val: 96995000000, filed: '2023-11-03' },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].netIncome).toBe(96995000000)
	})

	it('collapses comparative prior-year facts into the filing fiscal period', async () => {
		// NOTE: suspected bug — in companyfacts `fy`/`fp` describe the FILING's fiscal
		// period, not the fact's own period, so the two comparative years disclosed in
		// the FY2023 10-K are grouped under "FY-2023" and all but the last are lost.
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2021-09-25', val: 365817000000, fy: 2023, fp: 'FY' },
						{ end: '2022-09-24', val: 394328000000, fy: 2023, fp: 'FY' },
						{ end: '2023-09-30', val: 383285000000, fy: 2023, fp: 'FY' },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(statements[0]).toMatchObject({
			period: 'FY-2023',
			date: '2023-09-30',
			revenue: 383285000000,
		})
	})

	it('falls back from Revenues to RevenueFromContractWithCustomer', async () => {
		mount({
			facts: {
				json: companyFacts({
					RevenueFromContractWithCustomerExcludingAssessedTax: usd([
						{ end: '2023-09-30', val: 383285000000 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(383285000000)
	})

	it('prefers Revenues when both revenue tags are reported', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([{ end: '2023-09-30', val: 383285000000 }]),
					RevenueFromContractWithCustomerExcludingAssessedTax: usd([
						{ end: '2023-09-30', val: 100000000 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(383285000000)
	})

	it('keeps a reported revenue of zero instead of falling back', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([{ end: '2023-09-30', val: 0 }]),
					RevenueFromContractWithCustomerExcludingAssessedTax: usd([
						{ end: '2023-09-30', val: 500000 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(0)
	})

	it('omits revenue when neither revenue tag is reported', async () => {
		mount({ facts: { json: companyFacts({ Assets: usd([{ end: '2023-09-30', val: 1 }]) }) } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect('revenue' in statements[0]).toBe(false)
	})

	it('prefers the reported Liabilities total', async () => {
		mount({
			facts: {
				json: companyFacts({
					Liabilities: usd([{ end: '2023-09-30', val: 290437000000 }]),
					LiabilitiesCurrent: usd([{ end: '2023-09-30', val: 145308000000 }]),
					LiabilitiesNoncurrent: usd([{ end: '2023-09-30', val: 145129000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].totalLiabilities).toBe(290437000000)
	})

	it('sums current and noncurrent liabilities when Liabilities is absent', async () => {
		mount({
			facts: {
				json: companyFacts({
					LiabilitiesCurrent: usd([{ end: '2023-09-30', val: 145308000000 }]),
					LiabilitiesNoncurrent: usd([{ end: '2023-09-30', val: 145129000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].totalLiabilities).toBe(290437000000)
	})

	it('reports current liabilities alone as the total when noncurrent is missing', async () => {
		// NOTE: suspected bug — sumOptional treats a missing component as 0, so a
		// company that only tags LiabilitiesCurrent gets a totalLiabilities that
		// silently understates the balance sheet.
		mount({
			facts: {
				json: companyFacts({
					LiabilitiesCurrent: usd([{ end: '2023-09-30', val: 145308000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].totalLiabilities).toBe(145308000000)
	})

	it('reports noncurrent liabilities alone as the total when current is missing', async () => {
		mount({
			facts: {
				json: companyFacts({
					LiabilitiesNoncurrent: usd([{ end: '2023-09-30', val: 145129000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].totalLiabilities).toBe(145129000000)
	})

	it('omits totalLiabilities when no liability tag is reported', async () => {
		mount({ facts: { json: companyFacts({ Assets: usd([{ end: '2023-09-30', val: 1 }]) }) } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect('totalLiabilities' in statements[0]).toBe(false)
	})

	it('falls back from LongTermDebt to LongTermDebtNoncurrent', async () => {
		mount({
			facts: {
				json: companyFacts({
					LongTermDebtNoncurrent: usd([{ end: '2023-09-30', val: 95281000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].longTermDebt).toBe(95281000000)
	})

	it('prefers LongTermDebt when both debt tags are reported', async () => {
		mount({
			facts: {
				json: companyFacts({
					LongTermDebt: usd([{ end: '2023-09-30', val: 106548000000 }]),
					LongTermDebtNoncurrent: usd([{ end: '2023-09-30', val: 95281000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].longTermDebt).toBe(106548000000)
	})

	it('omits absent tags instead of setting them to undefined', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([{ end: '2023-09-30', val: 383285000000 }]),
					Assets: usd([{ end: '2023-09-30', val: 352583000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(Object.keys(statements[0]).sort()).toEqual([
			'date',
			'period',
			'revenue',
			'source',
			'totalAssets',
		])
	})

	it('maps every supported tag onto the statement', async () => {
		mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0]).toEqual({
			period: 'FY-2023',
			date: '2023-09-30',
			revenue: 383285000000,
			grossProfit: 169148000000,
			operatingIncome: 114301000000,
			netIncome: 96995000000,
			eps: 6.16,
			epsDiluted: 6.13,
			totalAssets: 352583000000,
			totalLiabilities: 290437000000,
			stockholdersEquity: 62146000000,
			operatingCashFlow: 110543000000,
			longTermDebt: 95281000000,
			sharesOutstanding: 15552752000,
			source: 'sec-edgar',
		})
	})

	it('prefers USD units over other units of the same concept', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: {
						units: {
							shares: unitRows([{ end: '2023-09-30', val: 999 }]),
							USD: unitRows([{ end: '2023-09-30', val: 383285000000 }]),
						},
					},
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(383285000000)
	})

	it('uses USD/shares when the concept has no USD unit', async () => {
		mount({
			facts: {
				json: companyFacts({
					EarningsPerShareDiluted: {
						units: {
							shares: unitRows([{ end: '2023-09-30', val: 999 }]),
							'USD/shares': unitRows([{ end: '2023-09-30', val: 6.13 }]),
						},
					},
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].epsDiluted).toBe(6.13)
	})

	it('uses shares when there is neither USD nor USD/shares', async () => {
		mount({
			facts: {
				json: companyFacts({
					CommonStockSharesOutstanding: {
						units: {
							pure: unitRows([{ end: '2023-09-30', val: 1 }]),
							shares: unitRows([{ end: '2023-09-30', val: 15552752000 }]),
						},
					},
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].sharesOutstanding).toBe(15552752000)
	})

	it('falls back to the first unit for an exotic currency', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: { units: { EUR: unitRows([{ end: '2023-09-30', val: 42000000 }]) } },
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].revenue).toBe(42000000)
	})

	it('skips a concept whose units object is empty', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: { units: {} },
					Assets: usd([{ end: '2023-09-30', val: 352583000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect('revenue' in statements[0]).toBe(false)
		expect(statements[0].totalAssets).toBe(352583000000)
	})

	it('sorts statements by period end date, newest first', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2021-09-25', val: 365817000000, fy: 2021 },
						{ end: '2023-09-30', val: 383285000000, fy: 2023 },
						{ end: '2022-09-24', val: 394328000000, fy: 2022 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements.map((s) => s.date)).toEqual(['2023-09-30', '2022-09-24', '2021-09-25'])
		expect(statements.map((s) => s.period)).toEqual(['FY-2023', 'FY-2022', 'FY-2021'])
	})

	it('honours an explicit limit', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([
						{ end: '2021-09-25', val: 365817000000, fy: 2021 },
						{ end: '2022-09-24', val: 394328000000, fy: 2022 },
						{ end: '2023-09-30', val: 383285000000, fy: 2023 },
					]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'AAPL', limit: 2 })

		expect(statements.map((s) => s.period)).toEqual(['FY-2023', 'FY-2022'])
	})

	it('defaults to ten statements', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd(
						Array.from({ length: 12 }, (_, i) => ({
							end: `${2012 + i}-12-31`,
							val: 1000 + i,
							fy: 2012 + i,
						})),
					),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(10)
		expect(statements[0].period).toBe('FY-2023')
		expect(statements[9].period).toBe('FY-2014')
	})

	it('returns nothing at all for a limit of zero', async () => {
		// NOTE: suspected bug — `?? 10` only guards null/undefined, so `limit: 0`
		// slices everything away instead of falling back to the default.
		mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		const statements = await getFinancials(provider, { symbol: 'AAPL', limit: 0 })

		expect(statements).toEqual([])
	})

	it('reports an unparseable period end as unknown', async () => {
		mount({ facts: { json: companyFacts({ Assets: usd([{ end: 'not-a-date', val: 1 }]) }) } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].date).toBe('unknown')
	})

	it('reports a 1970-01-01 period end as unknown', async () => {
		// NOTE: suspected bug — the epoch timestamp 0 is falsy, so a period ending on
		// 1970-01-01 loses its date.
		mount({ facts: { json: companyFacts({ Assets: usd([{ end: '1970-01-01', val: 1 }]) }) } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].date).toBe('unknown')
	})

	it('normalises a timestamped period end to a calendar day in UTC', async () => {
		mount({
			facts: { json: companyFacts({ Assets: usd([{ end: '2023-09-30T23:30:00Z', val: 1 }]) }) },
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements[0].date).toBe('2023-09-30')
	})

	it('returns an empty list when there are no us-gaap facts', async () => {
		mount({ facts: { json: { cik: 320193, facts: { dei: {} } } } })
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toEqual([])
	})

	it('returns an empty list when no fact matches the requested form', async () => {
		mount({
			facts: {
				json: companyFacts({
					Revenues: usd([{ end: '2023-12-30', val: 119575000000, form: '10-Q', fp: 'Q1' }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toEqual([])
	})

	it('ignores us-gaap tags it does not know about', async () => {
		mount({
			facts: {
				json: companyFacts({
					ResearchAndDevelopmentExpense: usd([{ end: '2023-09-30', val: 29915000000 }]),
					Assets: usd([{ end: '2023-09-30', val: 352583000000 }]),
				}),
			},
		})
		const provider = await importProvider()

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(Object.keys(statements[0]).sort()).toEqual(['date', 'period', 'source', 'totalAssets'])
	})

	it('throws when companyfacts is unavailable', async () => {
		mount({ facts: { status: 404, statusText: 'Not Found' } })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow(
			'Failed to fetch company facts: 404 Not Found',
		)
	})

	it('throws a TypeError for a payload with no facts key', async () => {
		// NOTE: suspected bug — `body.facts['us-gaap']` is read without a guard, so a
		// truncated or unexpected payload surfaces as a raw TypeError instead of a
		// provider-level error message.
		mount({ facts: { json: { cik: 320193, entityName: 'Apple Inc.' } } })
		const provider = await importProvider()

		await expect(getFinancials(provider)).rejects.toThrow(TypeError)
	})

	it('never requests companyfacts for an unknown ticker', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()

		await expect(getFinancials(provider, { symbol: 'ZZZZ' })).rejects.toThrow('not found')

		expect(fx.callCount(FACTS_MATCH)).toBe(0)
	})
})

describe('filing/list', () => {
	it('requires a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(getFilings(provider, {})).rejects.toThrow('symbol is required for filing/list')
		expect(fx.callCount()).toBe(0)
	})

	it('requests submissions for the zero-padded CIK', async () => {
		const fx = mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		await getFilings(provider)

		expect(fx.urls(SUBMISSIONS_MATCH)).toEqual([
			'https://data.sec.gov/submissions/CIK0000320193.json',
		])
	})

	it('maps every recent filing field', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings[0]).toEqual({
			accessionNumber: '0000320193-24-000081',
			form: '10-Q',
			filingDate: '2024-05-03',
			reportDate: '2024-03-30',
			primaryDocument: 'aapl-20240330.htm',
			description: '10-Q',
			source: 'sec-edgar',
		})
		expect(filings).toHaveLength(3)
	})

	it('preserves the order the submissions feed uses', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings.map((f) => f.filingDate)).toEqual(['2024-05-03', '2024-02-02', '2023-11-03'])
	})

	it('turns empty optional strings into undefined', async () => {
		mount({
			submissions: {
				json: {
					filings: {
						recent: {
							accessionNumber: ['0000320193-24-000081'],
							filingDate: ['2024-05-03'],
							reportDate: [''],
							form: ['8-K'],
							primaryDocument: [''],
							primaryDocDescription: [''],
						},
					},
				},
			},
		})
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings[0].reportDate).toBeUndefined()
		expect(filings[0].primaryDocument).toBeUndefined()
		expect(filings[0].description).toBeUndefined()
		expect(filings[0].accessionNumber).toBe('0000320193-24-000081')
	})

	it('filters to a single form type', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', type: '10-K' })

		expect(filings).toHaveLength(1)
		expect(filings[0].accessionNumber).toBe('0000320193-23-000106')
	})

	it('matches the form type exactly, not as a prefix', async () => {
		mount({
			submissions: {
				json: {
					filings: {
						recent: {
							accessionNumber: ['a-1', 'a-2'],
							filingDate: ['2024-05-03', '2024-04-03'],
							reportDate: ['2024-03-30', '2024-03-30'],
							form: ['10-K/A', '10-K'],
							primaryDocument: ['amended.htm', 'original.htm'],
							primaryDocDescription: ['10-K/A', '10-K'],
						},
					},
				},
			},
		})
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', type: '10-K' })

		expect(filings.map((f) => f.accessionNumber)).toEqual(['a-2'])
	})

	it('returns an empty list when no filing matches the type', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', type: 'S-1' })

		expect(filings).toEqual([])
	})

	it('returns exactly one filing when latest is set', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', latest: true })

		expect(filings).toHaveLength(1)
		expect(filings[0].accessionNumber).toBe('0000320193-24-000081')
	})

	it('combines latest with a type filter', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', type: '10-K', latest: true })

		expect(filings.map((f) => f.form)).toEqual(['10-K'])
	})

	it('lets latest win over a larger limit', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', latest: true, limit: 3 })

		expect(filings).toHaveLength(1)
	})

	it('ignores latest when it is explicitly false', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', latest: false })

		expect(filings).toHaveLength(3)
	})

	it('caps the list at the requested limit', async () => {
		mount({ submissions: { json: submissionsWith(10) } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', limit: 4 })

		expect(filings).toHaveLength(4)
		expect(filings.map((f) => f.filingDate)).toEqual([
			'2024-06-01',
			'2024-06-02',
			'2024-06-03',
			'2024-06-04',
		])
	})

	it('defaults to twenty filings', async () => {
		mount({ submissions: { json: submissionsWith(25) } })
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings).toHaveLength(20)
	})

	it('returns everything when the limit exceeds the feed', async () => {
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', limit: 500 })

		expect(filings).toHaveLength(3)
	})

	it('still returns one filing for a limit of zero', async () => {
		// NOTE: suspected bug — the cap is checked after the push, so `limit: 0`
		// yields a single filing here while `financials --limit 0` yields none.
		mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		const filings = await getFilings(provider, { symbol: 'AAPL', limit: 0 })

		expect(filings).toHaveLength(1)
	})

	it('returns an empty list when submissions has no recent block', async () => {
		mount({ submissions: { json: { cik: '320193', filings: { files: [] } } } })
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings).toEqual([])
	})

	it('returns an empty list when the payload has no filings at all', async () => {
		mount({ submissions: { json: { cik: '320193', name: 'Apple Inc.' } } })
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings).toEqual([])
	})

	it('returns an empty list when the recent arrays are empty', async () => {
		mount({
			submissions: {
				json: {
					filings: {
						recent: {
							accessionNumber: [],
							filingDate: [],
							reportDate: [],
							form: [],
							primaryDocument: [],
							primaryDocDescription: [],
						},
					},
				},
			},
		})
		const provider = await importProvider()

		const filings = await getFilings(provider)

		expect(filings).toEqual([])
	})

	it('throws when submissions is unavailable', async () => {
		mount({ submissions: { status: 500, statusText: 'Internal Server Error' } })
		const provider = await importProvider()

		await expect(getFilings(provider)).rejects.toThrow(
			'Failed to fetch submissions: 500 Internal Server Error',
		)
	})

	it('throws a TypeError when the recent block has no accessionNumber array', async () => {
		// NOTE: suspected bug — `recent.accessionNumber.length` is read without a
		// guard, so a partial submissions payload surfaces a raw TypeError.
		mount({ submissions: { json: { filings: { recent: { form: ['10-K'] } } } } })
		const provider = await importProvider()

		await expect(getFilings(provider)).rejects.toThrow(TypeError)
	})

	it('never requests submissions for an unknown ticker', async () => {
		const fx = mount({ submissions: { json: SUBMISSIONS } })
		const provider = await importProvider()

		await expect(getFilings(provider, { symbol: 'ZZZZ' })).rejects.toThrow(
			'Ticker "ZZZZ" not found in SEC EDGAR database',
		)

		expect(fx.callCount(SUBMISSIONS_MATCH)).toBe(0)
	})
})

describe('insiders/list', () => {
	it('requires a symbol', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(getInsiders(provider, {})).rejects.toThrow('symbol is required for insiders/list')
		expect(fx.callCount()).toBe(0)
	})

	it('queries full-text search for form 4 filings by padded CIK', async () => {
		const fx = mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		await getInsiders(provider)

		expect(fx.query(SEARCH_MATCH)).toEqual({
			q: '"0000320193"',
			forms: '4',
			dateRange: 'custom',
			startdt: '2022-06-15',
		})
		expect(fx.call(SEARCH_MATCH)?.parsed.origin).toBe('https://efts.sec.gov')
	})

	it('rolls a 29 February start date forward to 1 March', async () => {
		const fx = mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-02-29T00:00:00Z'))

		await getInsiders(provider)

		expect(fx.query(SEARCH_MATCH).startdt).toBe('2022-03-01')
	})

	it('maps hits onto insider transactions', async () => {
		mount({ search: { json: searchResponse([form4Hit({})]) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toEqual([
			{
				name: 'Cook Timothy D',
				transactionDate: '2024-04-03',
				transactionType: '4',
				shares: 0,
				description: 'FORM 4 SUBMISSION',
				accessionNumber: '0000320193-24-000078',
				source: 'sec-edgar',
			},
		])
	})

	it('strips a (CIK n) suffix and the surrounding whitespace from filer names', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['LEVINSON ARTHUR D  (CIK 0001214156)'] }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions[0].name).toBe('LEVINSON ARTHUR D')
	})

	it('skips hits filed for a different company', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Nadella Satya  (CIK 0001513142)'], ciks: ['0000789019'] }),
					form4Hit({ adsh: '0000320193-24-000079' }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.name)).toEqual(['Cook Timothy D'])
	})

	it('keeps hits that carry no cik list at all', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Adams Katherine L  (CIK 0001767094)'], ciks: undefined }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.name)).toEqual(['Adams Katherine L'])
	})

	it('matches company ciks regardless of leading zeros', async () => {
		mount({ search: { json: searchResponse([form4Hit({ ciks: ['320193'] })]) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toHaveLength(1)
	})

	it('skips a company self-filing whose name contains the ticker', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({
						display_names: ['CATERPILLAR INC  (CIK 0000018230)'],
						ciks: ['0000018230'],
					}),
					form4Hit({
						display_names: ['Umpleby James  (CIK 0001598916)'],
						ciks: ['0001598916', '0000018230'],
						adsh: '0000018230-24-000012',
					}),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider, { symbol: 'CAT' })

		expect(transactions.map((t) => t.name)).toEqual(['Umpleby James'])
	})

	it('also skips an unrelated insider whose name happens to contain the ticker', async () => {
		// NOTE: suspected bug — the self-filing guard is a plain substring test, so a
		// real insider named e.g. "Catalano" is dropped from CAT's Form 4 list.
		mount({
			search: {
				json: searchResponse([
					form4Hit({
						display_names: ['Catalano Maria  (CIK 0001598917)'],
						ciks: ['0000018230'],
					}),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider, { symbol: 'CAT' })

		expect(transactions).toEqual([])
	})

	it('fails to skip a self-filing when the company name does not contain the ticker', async () => {
		// NOTE: same substring heuristic from the other side — "Apple Inc." does not
		// contain "AAPL", so the issuer is reported as one of its own insiders.
		mount({
			search: {
				json: searchResponse([form4Hit({ display_names: ['Apple Inc.  (CIK 0000320193)'] })]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.name)).toEqual(['Apple Inc.'])
	})

	it('skips hits with no display name', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: undefined }),
					form4Hit({ display_names: ['  (CIK 0001214128)'] }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toEqual([])
	})

	it('sorts transactions by filing date, newest first', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Kondo Chris  (CIK 1)'], file_date: '2024-01-05' }),
					form4Hit({ display_names: ['Maestri Luca  (CIK 2)'], file_date: '2024-06-01' }),
					form4Hit({ display_names: ['O BRIEN Deirdre  (CIK 3)'], file_date: '2023-12-31' }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.transactionDate)).toEqual([
			'2024-06-01',
			'2024-01-05',
			'2023-12-31',
		])
	})

	it('sorts filings with an unknown date ahead of dated ones', async () => {
		// NOTE: a missing file_date becomes the literal string "unknown", which sorts
		// above every ISO date in the descending string comparison.
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Kondo Chris  (CIK 1)'], file_date: '2024-06-01' }),
					form4Hit({ display_names: ['Maestri Luca  (CIK 2)'], file_date: undefined }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.transactionDate)).toEqual(['unknown', '2024-06-01'])
	})

	it('honours an explicit limit after sorting', async () => {
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Kondo Chris  (CIK 1)'], file_date: '2024-01-05' }),
					form4Hit({ display_names: ['Maestri Luca  (CIK 2)'], file_date: '2024-06-01' }),
					form4Hit({ display_names: ['O BRIEN Deirdre  (CIK 3)'], file_date: '2023-12-31' }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider, { symbol: 'AAPL', limit: 2 })

		expect(transactions.map((t) => t.name)).toEqual(['Maestri Luca', 'Kondo Chris'])
	})

	it('defaults to twenty transactions', async () => {
		const hits = Array.from({ length: 25 }, (_, i) =>
			form4Hit({
				display_names: [`Insider ${String(i).padStart(2, '0')}  (CIK 000123456${i})`],
				file_date: `2024-06-${String(i + 1).padStart(2, '0')}`,
				adsh: `0000320193-24-0000${String(i).padStart(2, '0')}`,
			}),
		)
		mount({ search: { json: searchResponse(hits) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toHaveLength(20)
		expect(transactions[0].transactionDate).toBe('2024-06-25')
		expect(transactions[19].transactionDate).toBe('2024-06-06')
	})

	it('returns an empty list when the search request fails', async () => {
		const fx = mount({ search: { status: 403, statusText: 'Forbidden' } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toEqual([])
		expect(fx.callCount(SEARCH_MATCH)).toBe(1)
	})

	it('returns an empty list when the response carries no hits', async () => {
		mount({ search: { json: { took: 3 } } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions).toEqual([])
	})

	it('falls back to the document id for the accession number', async () => {
		mount({ search: { json: searchResponse([form4Hit({ adsh: undefined })]) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions[0].accessionNumber).toBe('0000320193-24-000078:xslF345X05/wf-form4.xml')
	})

	it('defaults the transaction type to Form 4 when the hit has no form', async () => {
		mount({ search: { json: searchResponse([form4Hit({ form: undefined })]) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions[0].transactionType).toBe('Form 4')
	})

	it('leaves the description undefined when the hit has none', async () => {
		mount({ search: { json: searchResponse([form4Hit({ file_description: undefined })]) } })
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions[0].description).toBeUndefined()
	})

	it('reports every transaction with zero shares', async () => {
		// NOTE: suspected bug — the provider never parses the Form 4 document, so it
		// emits a hard-coded `shares: 0` that formatters render as a real quantity.
		mount({
			search: {
				json: searchResponse([
					form4Hit({ display_names: ['Kondo Chris  (CIK 1)'] }),
					form4Hit({ display_names: ['Maestri Luca  (CIK 2)'], file_date: '2024-05-01' }),
				]),
			},
		})
		const provider = await importProvider()

		const transactions = await getInsiders(provider)

		expect(transactions.map((t) => t.shares)).toEqual([0, 0])
	})

	it('never searches for an unknown ticker', async () => {
		const fx = mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		await expect(getInsiders(provider, { symbol: 'ZZZZ' })).rejects.toThrow('not found')

		expect(fx.callCount(SEARCH_MATCH)).toBe(0)
	})
})

describe('search/search', () => {
	it('matches tickers by substring', async () => {
		mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'nvd' })

		expect(results).toEqual([
			{ symbol: 'NVDA', name: 'NVIDIA CORP', type: 'equity', source: 'sec-edgar' },
		])
	})

	it('matches company names case-insensitively', async () => {
		mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'apple' })

		expect(results.map((r) => r.symbol)).toEqual(['AAPL'])
	})

	it('returns nothing from the ticker map when nothing matches', async () => {
		mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'zzzz' })

		expect(results).toEqual([])
	})

	it('returns at most ten ticker matches', async () => {
		const many = Object.fromEntries(
			Array.from({ length: 14 }, (_, i) => [
				String(i),
				{ cik_str: 1000 + i, ticker: `CORP${i}`, title: `Corporate Holdings ${i}` },
			]),
		)
		mount({ tickers: { json: many }, search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'CORP' })

		expect(results).toHaveLength(10)
	})

	it('appends full-text hits after the ticker matches', async () => {
		mount({
			search: {
				json: searchResponse([
					{
						_id: '0001193125-24-000001',
						_source: {
							display_names: ['Applied Signal Technology Inc  (CIK 0001056903)'],
							form: '8-K',
							adsh: '0001193125-24-000001',
						},
					},
				]),
			},
		})
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'apple' })

		expect(results).toEqual([
			{ symbol: 'AAPL', name: 'Apple Inc.', type: 'equity', source: 'sec-edgar' },
			{
				symbol: '0001193125-24-000001',
				name: 'Applied Signal Technology Inc',
				type: '8-K',
				source: 'sec-edgar',
			},
		])
	})

	it('de-duplicates full-text hits that repeat a ticker-map company', async () => {
		mount({
			search: {
				json: searchResponse([
					{
						_id: 'a',
						_source: { display_names: ['Apple Inc.  (CIK 0000320193)'], adsh: 'a', form: '10-K' },
					},
					{
						_id: 'b',
						_source: { display_names: ['Apple Inc.  (CIK 0000320193)'], adsh: 'b', form: '8-K' },
					},
				]),
			},
		})
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'apple' })

		expect(results).toHaveLength(1)
		expect(results[0].symbol).toBe('AAPL')
	})

	it('falls back to Unknown and filing for hits missing their fields', async () => {
		mount({ search: { json: searchResponse([{ _id: 'x', _source: {} }]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'zzzz' })

		expect(results).toEqual([{ symbol: '', name: 'Unknown', type: 'filing', source: 'sec-edgar' }])
	})

	it('caps the full-text half at ten hits', async () => {
		const hits = Array.from({ length: 13 }, (_, i) => ({
			_id: `id-${i}`,
			_source: { display_names: [`Filer ${i}  (CIK 000000000${i})`], adsh: `adsh-${i}`, form: '4' },
		}))
		mount({ search: { json: searchResponse(hits) } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'zzzz' })

		expect(results).toHaveLength(10)
		expect(results[9].name).toBe('Filer 9')
	})

	it('ignores a failed full-text search and keeps the ticker matches', async () => {
		mount({ search: { status: 429, statusText: 'Too Many Requests' } })
		const provider = await importProvider()

		const results = await getSearch(provider, { query: 'msft' })

		expect(results.map((r) => r.symbol)).toEqual(['MSFT'])
	})

	it('treats a missing query as matching every company', async () => {
		// NOTE: suspected bug — `''` is a substring of every ticker, so `omd search`
		// with no query returns the first ten companies in the file as "matches".
		mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const results = await getSearch(provider, {})

		expect(results.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'CAT'])
	})

	it('forwards the query and the optional filters as search params', async () => {
		const fx = mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		await getSearch(provider, {
			query: 'lithium',
			startDate: '2024-01-01',
			endDate: '2024-06-30',
			forms: '8-K',
		})

		expect(fx.query(SEARCH_MATCH)).toEqual({
			q: 'lithium',
			startdt: '2024-01-01',
			enddt: '2024-06-30',
			forms: '8-K',
		})
	})

	it('omits the optional filters when they are not supplied', async () => {
		const fx = mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		await getSearch(provider, { query: 'lithium' })

		expect(fx.query(SEARCH_MATCH)).toEqual({ q: 'lithium' })
	})

	it('reports the source envelope for searches', async () => {
		mount({ search: { json: searchResponse([]) } })
		const provider = await importProvider()

		const result = await provider.execute<SearchResult[]>('search', 'search', { query: 'nvda' })

		expect(result.source).toBe('sec-edgar')
		expect(result.cached).toBe(false)
	})
})

describe('unsupported operations', () => {
	it('rejects an unsupported action inside a supported category', async () => {
		const fx = mount()
		const provider = await importProvider()

		await expect(provider.execute('financials', 'list', { symbol: 'AAPL' })).rejects.toThrow(
			'SEC EDGAR does not support financials/list',
		)
		expect(fx.callCount()).toBe(0)
	})

	it('rejects a category the provider does not advertise', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('quote', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'SEC EDGAR does not support quote/get',
		)
	})

	it('rejects filing/get even though filing is a capability', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('filing', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'SEC EDGAR does not support filing/get',
		)
	})

	it('rejects insiders/get', async () => {
		mount()
		const provider = await importProvider()

		await expect(provider.execute('insiders', 'get', { symbol: 'AAPL' })).rejects.toThrow(
			'SEC EDGAR does not support insiders/get',
		)
	})
})

describe('rate limiting', () => {
	it('surfaces a rate limit error once the bucket is empty', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		// The first call spends two tokens (ticker map + companyfacts); each later
		// call spends one, so ten tokens are gone after nine calls.
		for (let i = 0; i < 9; i++) {
			await getFinancials(provider)
		}

		await expect(getFinancials(provider)).rejects.toThrow(
			'SEC EDGAR rate limit exceeded — max 10 requests/second',
		)
		expect(fx.callCount()).toBe(10)
	})

	it('lets the bucket refill as time passes', async () => {
		const fx = mount({ facts: { json: FULL_FACTS } })
		const provider = await importProvider()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		for (let i = 0; i < 9; i++) {
			await getFinancials(provider)
		}
		vi.setSystemTime(new Date('2024-06-15T12:00:01Z'))

		const statements = await getFinancials(provider)

		expect(statements).toHaveLength(1)
		expect(fx.callCount()).toBe(11)
	})
})
