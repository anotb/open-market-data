import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConfigCommand } from '../../src/commands/config.js'
import { registerCryptoCommand } from '../../src/commands/crypto.js'
import { registerDividendsCommand } from '../../src/commands/dividends.js'
import { registerEarningsCommand } from '../../src/commands/earnings.js'
import { registerFilingCommand } from '../../src/commands/filing.js'
import { registerFinancialsCommand } from '../../src/commands/financials.js'
import { registerHistoryCommand } from '../../src/commands/history.js'
import { registerInsidersCommand } from '../../src/commands/insiders.js'
import { registerMacroCommand } from '../../src/commands/macro.js'
import { registerOptionsCommand } from '../../src/commands/options.js'
import { registerQuoteCommand } from '../../src/commands/quote.js'
import { registerSearchCommand } from '../../src/commands/search.js'
import { registerSourcesCommand } from '../../src/commands/sources.js'
import { loadConfig, saveConfig } from '../../src/core/config.js'
import { getProviders, route } from '../../src/core/router.js'
import type { ProviderResult } from '../../src/providers/types.js'
import type { OutputFormat } from '../../src/types.js'
import { createMockProvider } from '../helpers/providers.js'

/**
 * Behavioural tests for every command module in `src/commands/`.
 *
 * Each test builds a throwaway `Command` wired exactly like `src/cli.ts` (same
 * global flags, same `preAction` hook that normalises `--json`/`--plain` into
 * `format`), registers the command under test, and drives it through
 * `parseAsync(argv, { from: 'user' })`.
 *
 * The router and the config layer are module-mocked, so nothing here touches
 * the network or the developer's `~/.omd/config.json`. The formatter is NOT
 * mocked: the printed text is the observable behaviour under test.
 */

vi.mock('../../src/core/router.js', () => ({
	route: vi.fn(),
	getProviders: vi.fn(() => []),
	getProvidersForCategory: vi.fn(() => []),
	registerProvider: vi.fn(),
}))

vi.mock('../../src/core/config.js', () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(),
	resetConfigCache: vi.fn(),
	getConfigPath: vi.fn(() => '/tmp/omd-test-home/.omd/config.json'),
}))

/** Thrown by the mocked `process.exit` so a handler's exit is observable. */
class ProcessExitError extends Error {}

let logged: unknown[][] = []
let errored: unknown[][] = []
/** Anything commander itself wrote (help text, error banners). */
let helpOut: string[] = []
let helpErr: string[] = []

beforeEach(() => {
	logged = []
	errored = []
	helpOut = []
	helpErr = []
	vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		logged.push(args)
	})
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errored.push(args)
	})
})

afterEach(() => {
	// Several handlers signal failure through the exit code instead of throwing.
	process.exitCode = 0
})

/** Every `console.log` line the handler produced, joined as the user sees it. */
function out(): string {
	return logged.map((args) => args.map((a) => String(a ?? '')).join(' ')).join('\n')
}

/** Every `console.error` line the handler produced. */
function errOut(): string {
	return errored.map((args) => args.map((a) => String(a ?? '')).join(' ')).join('\n')
}

/** The nth `console.log` argument, for exact-match assertions. */
function loggedLine(index: number): string {
	return String(logged[index]?.[0] ?? '')
}

/** Parses the nth logged line as JSON — fails loudly if it is not valid JSON. */
function loggedJson(index = 0): unknown {
	return JSON.parse(loggedLine(index))
}

/** A root program wired exactly like `src/cli.ts`. */
function makeProgram(): Command {
	const program = new Command()
	program
		.name('omd')
		.exitOverride()
		.configureOutput({
			writeOut: (str) => {
				helpOut.push(str)
			},
			writeErr: (str) => {
				helpErr.push(str)
			},
		})
		.option('--json', 'output as JSON')
		.option('--plain', 'output as tab-separated values')
		.option('-v, --verbose', 'verbose output')
		.option('-s, --source <source>', 'force specific data source')
		.option('--no-cache', 'bypass cache')
		.hook('preAction', () => {
			const rawOpts = program.opts()
			let format: OutputFormat = 'markdown'
			if (rawOpts.json) format = 'json'
			else if (rawOpts.plain) format = 'plain'
			program.setOptionValue('format', format)
		})
	return program
}

type Register = (program: Command) => void

async function run(register: Register, argv: string[]): Promise<void> {
	const program = makeProgram()
	register(program)
	await program.parseAsync(argv, { from: 'user' })
}

/** Runs a command that is expected to reject, and hands back the rejection. */
async function runExpectingFailure(register: Register, argv: string[]): Promise<unknown> {
	const program = makeProgram()
	register(program)
	return program.parseAsync(argv, { from: 'user' }).then(
		() => {
			throw new Error('expected the command to fail, but it resolved')
		},
		(err: unknown) => err,
	)
}

interface RouteCall {
	category: string
	action: string
	args: Record<string, unknown>
	options: { source?: string; noCache?: boolean }
}

/** The nth call the handler made to `route()`. */
function routeCall(index = 0): RouteCall {
	const calls = vi.mocked(route).mock.calls
	expect(calls.length).toBeGreaterThan(index)
	const call = calls[index]
	return {
		category: call[0],
		action: call[1],
		args: call[2],
		options: call[3] ?? {},
	}
}

/** Makes `route()` resolve with `data` for every call in this test. */
function mockRoute(data: unknown, source = 'yahoo', cached = false): void {
	vi.mocked(route).mockResolvedValue({ data, source, cached } as ProviderResult<unknown>)
}

describe('search', () => {
	it('routes the query and renders a markdown table', async () => {
		mockRoute(
			[
				{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY', source: 'yahoo' },
				{ symbol: 'AAPL.MX', name: 'Apple Inc.', source: 'yahoo' },
			],
			'yahoo',
		)

		await run(registerSearchCommand, ['search', 'apple'])

		const call = routeCall()
		expect(call.category).toBe('search')
		expect(call.action).toBe('search')
		expect(call.args).toEqual({ query: 'apple' })
		expect(out()).toMatch(/\| Symbol\s+\| Name\s+\| Exchange/)
		expect(out()).toMatch(/\| AAPL\s+\| Apple Inc\.\s+\| NASDAQ\s+\| EQUITY\s+\| yahoo\s+\|/)
		// Blank cells for the missing exchange/type of the second row.
		expect(out()).toMatch(/\| AAPL\.MX\s+\| Apple Inc\.\s+\|\s+\|\s+\| yahoo\s+\|/)
		// `search` deliberately prints no "Source:" footer.
		expect(logged).toHaveLength(1)
	})

	it('passes --source and --no-cache through to the router', async () => {
		mockRoute([])

		await run(registerSearchCommand, ['--source', 'finnhub', '--no-cache', 'search', 'tesla'])

		expect(routeCall().options.source).toBe('finnhub')
		// NOTE: commander stores `--no-cache` as `opts.cache === false`, but every
		// command reads `opts.noCache`, which is never set. The cache is therefore
		// never actually bypassed. Asserting the current (buggy) behaviour.
		expect(routeCall().options.noCache).toBeUndefined()
	})

	it('emits JSON when --json is set', async () => {
		mockRoute([{ symbol: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', source: 'yahoo' }])

		await run(registerSearchCommand, ['--json', 'search', 'micro'])

		expect(loggedJson()).toEqual([
			{ Symbol: 'MSFT', Name: 'Microsoft', Exchange: 'NASDAQ', Type: '', Source: 'yahoo' },
		])
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('No providers available for "search"'))

		const err = await runExpectingFailure(registerSearchCommand, ['search', 'apple'])

		expect((err as Error).message).toBe('No providers available for "search"')
		expect(out()).toBe('')
	})
})

const QUOTE = {
	symbol: 'AAPL',
	price: 189.5,
	change: 2.25,
	changePercent: 1.2,
	volume: 52_000_000,
	marketCap: 2_950_000_000_000,
	dayLow: 187,
	dayHigh: 190.1,
	low52w: 124.17,
	high52w: 199.62,
	open: 188,
	previousClose: 187.25,
	source: 'yahoo',
}

describe('quote', () => {
	it('renders a single quote as key/value with a cached source line', async () => {
		mockRoute(QUOTE, 'yahoo', true)

		await run(registerQuoteCommand, ['quote', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('quote')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({ symbol: 'AAPL' })
		expect(out()).toMatch(/\*\*Symbol\s*\*\*: AAPL/)
		expect(out()).toContain('$189.50')
		expect(out()).toContain('$2.25 (+1.20%)')
		expect(out()).toContain('$187.00 — $190.10')
		expect(out()).toMatch(/\*\*Source\s*\*\*: yahoo \(cached\)/)
	})

	it('emits a single JSON object for one symbol, omitting absent fields', async () => {
		mockRoute({ symbol: 'F', price: 12, change: -0.5, changePercent: -4, source: 'yahoo' })

		await run(registerQuoteCommand, ['--json', 'quote', 'F'])

		expect(loggedJson()).toEqual({
			Symbol: 'F',
			Price: '$12.00',
			Change: '-$0.50 (-4.00%)',
			Source: 'yahoo',
		})
		expect(logged).toHaveLength(1)
	})

	it('asks for a batch when several symbols are given', async () => {
		mockRoute(
			[QUOTE, { symbol: 'MSFT', price: 420.1, change: 1, changePercent: 0.24, source: 'yahoo' }],
			'yahoo',
		)

		await run(registerQuoteCommand, ['quote', 'AAPL', 'MSFT'])

		expect(vi.mocked(route)).toHaveBeenCalledTimes(1)
		expect(routeCall().args).toEqual({ symbols: ['AAPL', 'MSFT'] })
		expect(out()).toMatch(
			/\| AAPL\s+\| \$189\.50\s+\| \+1\.20%\s+\| 52M\s+\| 2\.95T\s+\| yahoo\s+\|/,
		)
		// Volume and market cap are blank for a quote that carries neither.
		expect(out()).toMatch(/\| MSFT\s+\| \$420\.10\s+\| \+0\.24%\s+\|\s+\|\s+\| yahoo\s+\|/)
	})

	it('falls back to one request per symbol when the batch fails', async () => {
		vi.mocked(route).mockImplementation(async (_category, _action, args) => {
			if (Array.isArray(args.symbols)) throw new Error('batch not supported')
			return {
				data: { ...QUOTE, symbol: String(args.symbol), price: 10 },
				source: `src-${String(args.symbol)}`,
				cached: false,
			} as ProviderResult<unknown>
		})

		await run(registerQuoteCommand, ['quote', 'AAPL', 'MSFT'])

		expect(vi.mocked(route)).toHaveBeenCalledTimes(3)
		expect(routeCall(1).args).toEqual({ symbol: 'AAPL' })
		expect(routeCall(2).args).toEqual({ symbol: 'MSFT' })
		expect(out()).toContain('src-AAPL')
		expect(out()).toContain('src-MSFT')
	})

	it('propagates a single-symbol router failure', async () => {
		vi.mocked(route).mockRejectedValue(new Error('all providers failed'))

		const err = await runExpectingFailure(registerQuoteCommand, ['quote', 'AAPL'])

		expect((err as Error).message).toBe('all providers failed')
	})
})

describe('financials', () => {
	const STATEMENTS = [
		{
			period: 'FY2023',
			date: '2023-09-30',
			revenue: 383_285_000_000,
			netIncome: 96_995_000_000,
			eps: 6.13,
			totalAssets: 352_583_000_000,
			stockholdersEquity: 62_146_000_000,
			source: 'sec-edgar',
		},
		// A period the provider could only partially fill in.
		{ period: 'FY2022', date: '2022-09-30', revenue: 394_328_000_000, source: 'sec-edgar' },
	]

	it('defaults to annual periods with a limit of 5', async () => {
		mockRoute(STATEMENTS, 'sec-edgar', true)

		await run(registerFinancialsCommand, ['financials', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('financials')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({ symbol: 'AAPL', period: 'annual', limit: 5 })
		expect(out()).toMatch(/\| FY2023\s+\| 2023-09-30\s+\| 383\.29B\s+\| 97\.00B\s+\| 6\.13/)
		expect(loggedLine(1)).toBe('\nSource: sec-edgar (cached)')
	})

	it('parses --period and --limit', async () => {
		mockRoute([])

		await run(registerFinancialsCommand, [
			'--source',
			'sec-edgar',
			'financials',
			'AAPL',
			'--period',
			'quarterly',
			'--limit',
			'3',
		])

		expect(routeCall().args).toEqual({ symbol: 'AAPL', period: 'quarterly', limit: 3 })
		expect(routeCall().options.source).toBe('sec-edgar')
	})

	it('emits JSON with no source footer', async () => {
		mockRoute(STATEMENTS, 'sec-edgar', true)

		await run(registerFinancialsCommand, ['--json', 'financials', 'AAPL'])

		const rows = loggedJson() as Record<string, unknown>[]
		expect(rows[0]).toMatchObject({ Period: 'FY2023', Revenue: '383.29B', EPS: '6.13' })
		expect(rows[1]).toEqual({
			Period: 'FY2022',
			Date: '2022-09-30',
			Revenue: '394.33B',
			'Net Income': '',
			EPS: '',
			Assets: '',
			Equity: '',
		})
		expect(logged).toHaveLength(1)
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('no financials provider'))

		const err = await runExpectingFailure(registerFinancialsCommand, ['financials', 'AAPL'])

		expect((err as Error).message).toBe('no financials provider')
	})
})

describe('history', () => {
	const CANDLES = [
		{ date: '2024-06-14', open: 100, high: 105.5, low: 99.25, close: 104, volume: 1_500_000 },
	]

	it('defaults to 30 days and prints the source footer', async () => {
		mockRoute(CANDLES, 'yahoo', true)

		await run(registerHistoryCommand, ['history', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('history')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({ symbol: 'AAPL', days: 30 })
		expect(out()).toMatch(
			/\| 2024-06-14\s+\| \$100\.00\s+\| \$105\.50\s+\| \$99\.25\s+\| \$104\.00\s+\| 2M/,
		)
		expect(loggedLine(1)).toBe('\nSource: yahoo (cached)')
	})

	it('parses --days as a number', async () => {
		mockRoute([])

		await run(registerHistoryCommand, ['history', 'AAPL', '--days', '7'])

		expect(routeCall().args).toEqual({ symbol: 'AAPL', days: 7 })
	})

	it('renders tab-separated rows with --plain', async () => {
		mockRoute(CANDLES, 'yahoo')

		await run(registerHistoryCommand, ['--plain', 'history', 'AAPL'])

		expect(loggedLine(0).split('\n')[0]).toBe('Date\tOpen\tHigh\tLow\tClose\tVolume')
		expect(loggedLine(0).split('\n')[1]).toBe('2024-06-14\t$100.00\t$105.50\t$99.25\t$104.00\t2M')
		expect(loggedLine(1)).toBe('\nSource: yahoo')
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('history unavailable'))

		const err = await runExpectingFailure(registerHistoryCommand, ['history', 'AAPL'])

		expect((err as Error).message).toBe('history unavailable')
	})
})

describe('options', () => {
	const CONTRACTS = [
		{
			strike: 190,
			expiration: '2024-06-21',
			type: 'call' as const,
			lastPrice: 3.4,
			bid: 3.3,
			ask: 3.5,
			volume: 850,
			openInterest: 1200,
			impliedVolatility: 0.25,
		},
		{ strike: 180, expiration: '2024-06-21', type: 'put' as const, lastPrice: 1.1 },
	]

	it('renders every contract and omits absent numeric fields', async () => {
		mockRoute(CONTRACTS, 'yahoo', true)

		await run(registerOptionsCommand, ['options', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('options')
		expect(call.action).toBe('get')
		// The --type filter is applied locally, not forwarded to the router.
		expect(call.args).toEqual({ symbol: 'AAPL' })
		expect(out()).toMatch(
			/\| CALL\s+\| 2024-06-21\s+\| \$190\.00\s+\| \$3\.40\s+\| \$3\.30\s+\| \$3\.50/,
		)
		expect(out()).toContain('25.0%')
		expect(out()).toContain('PUT')
		expect(loggedLine(1)).toBe('\nSource: yahoo (cached)')
	})

	it('filters to calls with --type call', async () => {
		mockRoute(CONTRACTS)

		await run(registerOptionsCommand, ['options', 'AAPL', '--type', 'call'])

		expect(out()).toContain('CALL')
		expect(out()).not.toContain('PUT')
	})

	it('emits JSON for the filtered puts', async () => {
		mockRoute(CONTRACTS)

		await run(registerOptionsCommand, ['--json', 'options', 'AAPL', '--type', 'put'])

		const rows = loggedJson() as Record<string, unknown>[]
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ Type: 'PUT', Strike: '$180.00', Last: '$1.10', IV: '' })
		expect(logged).toHaveLength(1)
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('no options provider'))

		const err = await runExpectingFailure(registerOptionsCommand, ['options', 'AAPL'])

		expect((err as Error).message).toBe('no options provider')
	})
})

describe('earnings', () => {
	it('renders the surprise column with an explicit sign', async () => {
		mockRoute(
			[
				{
					symbol: 'AAPL',
					earningsDate: '2024-05-02',
					epsEstimate: 1.5,
					epsActual: 1.6,
					source: 'finnhub',
				},
				{
					symbol: 'AAPL',
					earningsDate: '2024-02-01',
					epsEstimate: 2.1,
					epsActual: 2.0,
					source: 'finnhub',
				},
			],
			'finnhub',
			true,
		)

		await run(registerEarningsCommand, ['earnings', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('earnings')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({ symbol: 'AAPL' })
		expect(out()).toMatch(/\| 2024-05-02\s+\| 1\.50\s+\| 1\.60\s+\| \+0\.10\s+\|/)
		expect(out()).toMatch(/\| 2024-02-01\s+\| 2\.10\s+\| 2\.00\s+\| -0\.10\s+\|/)
		expect(loggedLine(1)).toBe('\nSource: finnhub (cached)')
	})

	it('prints a friendly message and no footer when there is no data', async () => {
		mockRoute([], 'finnhub')

		await run(registerEarningsCommand, ['earnings', 'ZZZZ'])

		expect(logged).toHaveLength(1)
		expect(loggedLine(0)).toBe('No earnings data available.')
	})

	it('emits JSON when --json is set, blanking absent estimates', async () => {
		mockRoute([
			{ symbol: 'AAPL', earningsDate: '2024-05-02', source: 'finnhub' },
			{ symbol: 'AAPL', epsEstimate: 1.4, source: 'finnhub' },
		])

		await run(registerEarningsCommand, ['--json', 'earnings', 'AAPL'])

		expect(loggedJson()).toEqual([
			{ Date: '2024-05-02', 'EPS Est.': '', 'EPS Actual': '', Surprise: '' },
			{ Date: '', 'EPS Est.': '1.40', 'EPS Actual': '', Surprise: '' },
		])
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('earnings unavailable'))

		const err = await runExpectingFailure(registerEarningsCommand, ['earnings', 'AAPL'])

		expect((err as Error).message).toBe('earnings unavailable')
	})
})

describe('dividends', () => {
	it('renders dividend rows with a source footer', async () => {
		mockRoute(
			[
				{ date: '2024-05-10', amount: 0.25, source: 'yahoo' },
				{ date: '2024-02-09', amount: 0.24, source: 'yahoo' },
			],
			'yahoo',
			true,
		)

		await run(registerDividendsCommand, ['--source', 'yahoo', 'dividends', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('dividends')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({ symbol: 'AAPL' })
		expect(call.options.source).toBe('yahoo')
		expect(out()).toMatch(/\| 2024-05-10\s+\| \$0\.25\s+\|/)
		expect(loggedLine(1)).toBe('\nSource: yahoo (cached)')
	})

	it('prints a friendly message and no footer when there is no data', async () => {
		mockRoute([], 'yahoo')

		await run(registerDividendsCommand, ['dividends', 'GOOG'])

		expect(logged).toHaveLength(1)
		expect(loggedLine(0)).toBe('No dividend data available.')
	})

	it('emits JSON when --json is set', async () => {
		mockRoute([{ date: '2024-05-10', amount: 0.25, source: 'yahoo' }])

		await run(registerDividendsCommand, ['--json', 'dividends', 'AAPL'])

		expect(loggedJson()).toEqual([{ Date: '2024-05-10', Amount: '$0.25' }])
		expect(logged).toHaveLength(1)
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('dividends unavailable'))

		const err = await runExpectingFailure(registerDividendsCommand, ['dividends', 'AAPL'])

		expect((err as Error).message).toBe('dividends unavailable')
	})
})

describe('filing', () => {
	const FILINGS = [
		{
			accessionNumber: '0000320193-23-000106',
			form: '10-K',
			filingDate: '2023-11-03',
			reportDate: '2023-09-30',
			description: 'Annual report',
			source: 'sec-edgar',
		},
		{
			accessionNumber: '0000320193-23-000077',
			form: '10-Q',
			filingDate: '2023-08-04',
			source: 'sec-edgar',
		},
	]

	it('defaults to a limit of 20 with no type filter', async () => {
		mockRoute(FILINGS, 'sec-edgar', true)

		await run(registerFilingCommand, ['filing', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('filing')
		expect(call.action).toBe('list')
		expect(call.args).toEqual({
			symbol: 'AAPL',
			type: undefined,
			latest: undefined,
			limit: 20,
		})
		expect(out()).toContain('10-K')
		expect(out()).toContain('10-Q')
		expect(loggedLine(1)).toBe('\nSource: sec-edgar (cached)')
	})

	it('forwards --type/--limit and keeps only the newest filing for --latest', async () => {
		mockRoute(FILINGS, 'sec-edgar')

		await run(registerFilingCommand, [
			'filing',
			'AAPL',
			'--type',
			'10-K',
			'--latest',
			'--limit',
			'5',
		])

		expect(routeCall().args).toEqual({
			symbol: 'AAPL',
			type: '10-K',
			latest: true,
			limit: 5,
		})
		expect(out()).toContain('0000320193-23-000106')
		expect(out()).not.toContain('0000320193-23-000077')
	})

	it('emits JSON when --json is set', async () => {
		mockRoute(FILINGS, 'sec-edgar')

		await run(registerFilingCommand, ['--json', 'filing', 'AAPL'])

		const rows = loggedJson() as Record<string, unknown>[]
		expect(rows).toHaveLength(2)
		expect(rows[0]).toEqual({
			Form: '10-K',
			Filed: '2023-11-03',
			'Report Date': '2023-09-30',
			'Accession #': '0000320193-23-000106',
			Description: 'Annual report',
		})
		expect(logged).toHaveLength(1)
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('ticker not found'))

		const err = await runExpectingFailure(registerFilingCommand, ['filing', 'NOPE'])

		expect((err as Error).message).toBe('ticker not found')
	})
})

describe('insiders', () => {
	const TRANSACTIONS = [
		{
			name: 'COOK TIMOTHY D',
			transactionDate: '2024-04-02',
			transactionType: '4',
			shares: 0,
			description: 'Officer: CEO',
			source: 'sec-edgar',
		},
	]

	it('defaults to a limit of 20 and prints the Form 4 note', async () => {
		mockRoute(TRANSACTIONS, 'sec-edgar', true)

		await run(registerInsidersCommand, ['insiders', 'AAPL'])

		const call = routeCall()
		expect(call.category).toBe('insiders')
		expect(call.action).toBe('list')
		expect(call.args).toEqual({ symbol: 'AAPL', limit: 20 })
		expect(out()).toMatch(/\| COOK TIMOTHY D\s+\| 2024-04-02\s+\| 4\s+\| Officer: CEO\s+\|/)
		expect(loggedLine(1)).toBe('\nSource: sec-edgar (cached)')
		expect(loggedLine(2)).toContain('view the actual Form 4 filing on SEC.gov')
	})

	it('parses --limit as a number', async () => {
		mockRoute([])

		await run(registerInsidersCommand, ['insiders', 'AAPL', '--limit', '5'])

		expect(routeCall().args).toEqual({ symbol: 'AAPL', limit: 5 })
	})

	it('emits JSON with neither footer nor note', async () => {
		mockRoute(TRANSACTIONS, 'sec-edgar')

		await run(registerInsidersCommand, ['--json', 'insiders', 'AAPL'])

		expect(loggedJson()).toEqual([
			{
				Filer: 'COOK TIMOTHY D',
				Filed: '2024-04-02',
				Form: '4',
				Description: 'Officer: CEO',
			},
		])
		expect(logged).toHaveLength(1)
	})

	it('propagates router failures', async () => {
		vi.mocked(route).mockRejectedValue(new Error('insiders unavailable'))

		const err = await runExpectingFailure(registerInsidersCommand, ['insiders', 'AAPL'])

		expect((err as Error).message).toBe('insiders unavailable')
	})
})

describe('macro', () => {
	const SERIES = {
		id: 'GDP',
		title: 'Gross Domestic Product',
		units: 'Billions of Dollars',
		frequency: 'Quarterly',
		seasonalAdjustment: 'Seasonally Adjusted Annual Rate',
		data: [
			{ date: '2024-01-01', value: 28624.069 },
			{ date: '2023-10-01', value: 28296.967 },
		],
		source: 'fred',
	}

	it('searches FRED series with a parsed --limit', async () => {
		mockRoute([
			{
				id: 'UNRATE',
				title: 'Unemployment Rate',
				units: 'Percent',
				frequency: 'Monthly',
				seasonal_adjustment: 'Seasonally Adjusted',
				popularity: 90,
			},
			// A hit with no frequency/units metadata.
			{ id: 'U6RATE', title: 'Total Unemployed', popularity: 40 },
		])

		await run(registerMacroCommand, ['macro', 'search', 'unemployment', '--limit', '5'])

		const call = routeCall()
		expect(call.category).toBe('macro')
		expect(call.action).toBe('search')
		expect(call.args).toEqual({ query: 'unemployment', limit: 5 })
		expect(out()).toMatch(/\| UNRATE\s+\| Unemployment Rate\s+\| Monthly\s+\| Percent\s+\|/)
		expect(out()).toMatch(/\| U6RATE\s+\| Total Unemployed\s+\|\s+\|\s+\|/)
		// `macro search` prints no "Source:" footer.
		expect(logged).toHaveLength(1)
	})

	it('upper-cases the series id and renders header, table and footer', async () => {
		mockRoute(SERIES, 'fred', true)

		await run(registerMacroCommand, ['macro', 'gdp'])

		const call = routeCall()
		expect(call.category).toBe('macro')
		expect(call.action).toBe('get')
		expect(call.args).toEqual({
			seriesId: 'GDP',
			start: undefined,
			end: undefined,
			limit: undefined,
			country: 'US',
		})
		expect(call.options.source).toBeUndefined()
		expect(loggedLine(0)).toContain('Gross Domestic Product')
		expect(loggedLine(2)).toMatch(/\| 2024-01-01\s+\| 28624\.069\s+\|/)
		expect(loggedLine(3)).toBe('\nSource: fred (cached)')
	})

	it('forwards --start/--end/--limit for a series request', async () => {
		mockRoute(SERIES, 'fred')

		await run(registerMacroCommand, [
			'macro',
			'GDP',
			'--start',
			'2020-01-01',
			'--end',
			'2024-01-01',
			'--limit',
			'4',
		])

		expect(routeCall().args).toEqual({
			seriesId: 'GDP',
			start: '2020-01-01',
			end: '2024-01-01',
			limit: 4,
			country: 'US',
		})
	})

	it('defaults non-US countries to the World Bank source', async () => {
		mockRoute(SERIES, 'worldbank')

		await run(registerMacroCommand, ['macro', 'gdp', '--country', 'de'])

		expect(routeCall().args).toMatchObject({ seriesId: 'GDP', country: 'de' })
		expect(routeCall().options.source).toBe('worldbank')
	})

	it('lets an explicit --source win over the World Bank default', async () => {
		mockRoute(SERIES, 'fred')

		await run(registerMacroCommand, ['--source', 'fred', 'macro', 'GDP', '--country', 'DE'])

		expect(routeCall().options.source).toBe('fred')
	})

	it('emits one combined JSON object with --json', async () => {
		mockRoute(SERIES, 'fred', true)

		await run(registerMacroCommand, ['--json', 'macro', 'GDP'])

		expect(loggedJson()).toEqual({
			series: 'GDP',
			title: 'Gross Domestic Product',
			units: 'Billions of Dollars',
			frequency: 'Quarterly',
			seasonalAdjustment: 'Seasonally Adjusted Annual Rate',
			source: 'fred',
			cached: true,
			data: SERIES.data,
		})
		expect(logged).toHaveLength(1)
	})

	it('shows help instead of routing when no series id is given', async () => {
		mockRoute(SERIES)

		const err = await runExpectingFailure(registerMacroCommand, ['macro'])

		expect((err as { code?: string }).code).toBe('commander.help')
		expect(vi.mocked(route)).not.toHaveBeenCalled()
		expect(helpOut.join('')).toContain('Usage: omd macro')
	})

	it('lets the global -s shadow the subcommand -s/--start short flag', async () => {
		mockRoute(SERIES, 'fred')

		// NOTE: `-s` is registered twice — globally as `--source` and on
		// `macro get` as `--start`. Commander resolves it against the root
		// command, so `-s 2020-01-01` picks a data source rather than a start
		// date. Documenting current behaviour; `--start` is the working spelling.
		await run(registerMacroCommand, ['macro', 'GDP', '-s', '2020-01-01'])

		expect(routeCall().args).toMatchObject({ start: undefined })
		expect(routeCall().options.source).toBe('2020-01-01')
	})
})

describe('crypto', () => {
	const BTC = {
		symbol: 'btc',
		name: 'Bitcoin',
		price: 67_000.5,
		changePercent24h: 2.5,
		volume24h: 32_000_000_000,
		marketCap: 1_320_000_000_000,
		marketCapRank: 1,
		high24h: 68_000,
		low24h: 65_500,
		ath: 73_750,
		source: 'coingecko',
	}

	it('lists the top coins with a default limit of 10', async () => {
		mockRoute(
			[BTC, { ...BTC, symbol: 'eth', name: 'Ethereum', marketCapRank: 2 }],
			'coingecko',
			true,
		)

		await run(registerCryptoCommand, ['crypto', 'top'])

		const call = routeCall()
		expect(call.category).toBe('crypto')
		expect(call.action).toBe('top')
		expect(call.args).toEqual({ limit: 10 })
		expect(out()).toMatch(/\| 1\s+\| BTC\s+\| Bitcoin\s+\| \$67,000\.50\s+\| \+2\.50%\s+\| 1\.32T/)
		expect(out()).toContain('ETH')
		expect(loggedLine(1)).toBe('\nSource: coingecko (cached)')
	})

	it('parses a positional limit argument', async () => {
		mockRoute([], 'coingecko')

		await run(registerCryptoCommand, ['crypto', 'top', '5'])

		expect(routeCall().args).toEqual({ limit: 5 })
	})

	it('leaves cells blank for a coin with no rank, name or market data', async () => {
		mockRoute([{ symbol: 'xrp', price: 0.5, source: 'coingecko' }], 'coingecko')

		await run(registerCryptoCommand, ['--plain', 'crypto', 'top'])

		expect(loggedLine(0).split('\n')[1]).toBe('\tXRP\t\t$0.50\t\t\t')
		expect(loggedLine(1)).toBe('\nSource: coingecko')
	})

	it('emits JSON for top with no source footer', async () => {
		mockRoute([BTC], 'coingecko', true)

		await run(registerCryptoCommand, ['--json', 'crypto', 'top'])

		const rows = loggedJson() as Record<string, unknown>[]
		expect(rows[0]).toMatchObject({ '#': '1', Symbol: 'BTC', Price: '$67,000.50' })
		expect(logged).toHaveLength(1)
	})

	it('hints at the CoinGecko key when top fails and no key is configured', async () => {
		vi.mocked(loadConfig).mockReturnValue({})
		vi.mocked(route).mockRejectedValue(new Error('429 rate limited'))

		await run(registerCryptoCommand, ['crypto', 'top'])

		expect(errOut()).toBe(
			'Market rankings require CoinGecko. Run: omd config set coingeckoApiKey <key>',
		)
		expect(out()).toBe('')
		expect(process.exitCode).toBe(1)
	})

	it('reports the underlying failure when a CoinGecko key is configured', async () => {
		vi.mocked(loadConfig).mockReturnValue({ coingeckoApiKey: 'cg-secret' })
		vi.mocked(route).mockRejectedValue(new Error('429 rate limited'))

		await run(registerCryptoCommand, ['crypto', 'top'])

		expect(errOut()).toBe('Failed to fetch market rankings: 429 rate limited')
		expect(process.exitCode).toBe(1)
	})

	it('upper-cases the symbol and parses --days/--interval for history', async () => {
		mockRoute(
			[{ time: '2024-06-14', open: 66000, high: 67500, low: 65800, close: 67000.5, volume: 1234 }],
			'binance',
			true,
		)

		await run(registerCryptoCommand, [
			'crypto',
			'history',
			'btc',
			'--days',
			'7',
			'--interval',
			'1h',
		])

		const call = routeCall()
		expect(call.category).toBe('crypto')
		expect(call.action).toBe('history')
		expect(call.args).toEqual({ symbol: 'BTC', days: 7, interval: '1h' })
		expect(out()).toMatch(
			/\| 2024-06-14\s+\| 66000\.00\s+\| 67500\.00\s+\| 65800\.00\s+\| 67000\.50/,
		)
		expect(loggedLine(1)).toBe('\nSource: binance (cached)')
	})

	it('defaults crypto history to 30 days and no interval', async () => {
		mockRoute([], 'binance')

		await run(registerCryptoCommand, ['crypto', 'history', 'eth'])

		expect(routeCall().args).toEqual({ symbol: 'ETH', days: 30, interval: undefined })
	})

	it('treats a bare symbol as a quote request', async () => {
		mockRoute(BTC, 'coingecko', true)

		await run(registerCryptoCommand, ['crypto', 'btc'])

		const call = routeCall()
		expect(call.category).toBe('crypto')
		expect(call.action).toBe('quote')
		expect(call.args).toEqual({ symbol: 'BTC' })
		expect(out()).toMatch(/\*\*Symbol\s*\*\*: BTC/)
		expect(out()).toContain('$67,000.50')
		expect(out()).toMatch(/\*\*Source\s*\*\*: coingecko \(cached\)/)
		// The quote view folds the source into the key/value block — no footer.
		expect(logged).toHaveLength(1)
	})

	it('emits the quote as JSON, source included', async () => {
		mockRoute(BTC, 'coingecko')

		await run(registerCryptoCommand, ['--json', 'crypto', 'BTC'])

		const quote = loggedJson() as Record<string, unknown>
		expect(quote).toMatchObject({
			Symbol: 'BTC',
			Name: 'Bitcoin',
			Price: '$67,000.50',
			'24h Change': '+2.50%',
			Rank: '1',
			'24h High': '$68,000.00',
			ATH: '$73,750.00',
			Source: 'coingecko',
		})
	})

	it('omits every field a sparse quote does not carry', async () => {
		mockRoute({ symbol: 'xrp', price: 0.5, source: 'coingecko' }, 'coingecko')

		await run(registerCryptoCommand, ['--json', 'crypto', 'xrp'])

		expect(loggedJson()).toEqual({ Symbol: 'XRP', Price: '$0.50', Source: 'coingecko' })
	})

	it('shows help instead of routing when no symbol is given', async () => {
		const err = await runExpectingFailure(registerCryptoCommand, ['crypto'])

		expect((err as { code?: string }).code).toBe('commander.help')
		expect(vi.mocked(route)).not.toHaveBeenCalled()
		expect(helpOut.join('')).toContain('Usage: omd crypto')
	})

	it('propagates a crypto quote failure', async () => {
		vi.mocked(route).mockRejectedValue(new Error('unknown symbol'))

		const err = await runExpectingFailure(registerCryptoCommand, ['crypto', 'XYZ'])

		expect((err as Error).message).toBe('unknown symbol')
	})
})

describe('sources', () => {
	it('reports status, key state, categories and rate limits', async () => {
		vi.mocked(getProviders).mockReturnValue([
			createMockProvider({
				name: 'yahoo',
				capabilities: ['quote', 'history'],
				rateLimits: { maxRequests: 2000, windowMs: 3_600_000 },
			}),
			createMockProvider({
				name: 'fred',
				requiresKey: true,
				capabilities: ['macro'],
				rateLimits: { maxRequests: 120, windowMs: 60_000 },
				isEnabled: () => false,
			}),
			createMockProvider({
				name: 'binance',
				capabilities: ['crypto'],
				rateLimits: { maxRequests: 20, windowMs: 1_000 },
			}),
		])

		await run(registerSourcesCommand, ['sources'])

		expect(out()).toMatch(/\| yahoo\s+\| enabled\s+\| none\s+\| quote, history\s+\| 2000\/day\s+\|/)
		expect(out()).toMatch(/\| fred\s+\| disabled\s+\| missing\s+\| macro\s+\| 120\/min\s+\|/)
		expect(out()).toMatch(/\| binance\s+\| enabled\s+\| none\s+\| crypto\s+\| 20\/sec\s+\|/)
	})

	it('marks a key-requiring provider as configured once enabled', async () => {
		vi.mocked(getProviders).mockReturnValue([
			createMockProvider({
				name: 'coingecko',
				requiresKey: true,
				capabilities: ['crypto'],
				isEnabled: () => true,
			}),
		])

		await run(registerSourcesCommand, ['sources'])

		expect(out()).toMatch(
			/\| coingecko\s+\| enabled\s+\| configured\s+\| crypto\s+\| 100\/min\s+\|/,
		)
	})

	it('emits JSON when --json is set', async () => {
		vi.mocked(getProviders).mockReturnValue([
			createMockProvider({ name: 'yahoo', capabilities: ['quote'] }),
		])

		await run(registerSourcesCommand, ['--json', 'sources'])

		expect(loggedJson()).toEqual([
			{
				Source: 'yahoo',
				Status: 'enabled',
				'API Key': 'none',
				Categories: 'quote',
				'Rate Limit': '100/min',
			},
		])
	})

	it('renders an empty table when nothing is registered', async () => {
		vi.mocked(getProviders).mockReturnValue([])

		await run(registerSourcesCommand, ['sources'])

		expect(out()).toContain('| Source | Status | API Key | Categories | Rate Limit |')
	})
})

describe('config', () => {
	it('shows the config path and masks every API key', async () => {
		vi.mocked(loadConfig).mockReturnValue({
			fredApiKey: 'fred-secret',
			coingeckoApiKey: 'cg-secret',
			finnhubApiKey: 'finnhub-secret',
			alphaVantageApiKey: 'av-secret',
			edgarUserAgent: 'Tester tester@example.com',
			defaultFormat: 'json',
			disabledSources: ['binance'],
		})

		await run(registerConfigCommand, ['config', 'show'])

		expect(loggedLine(0)).toContain('/tmp/omd-test-home/.omd/config.json')
		expect(loggedJson(1)).toEqual({
			fredApiKey: '***configured***',
			coingeckoApiKey: '***configured***',
			finnhubApiKey: '***configured***',
			alphaVantageApiKey: '***configured***',
			edgarUserAgent: 'Tester tester@example.com',
			defaultFormat: 'json',
			disabledSources: ['binance'],
		})
		expect(out()).not.toContain('fred-secret')
		expect(out()).not.toContain('av-secret')
	})

	it('shows an empty object when nothing is configured', async () => {
		vi.mocked(loadConfig).mockReturnValue({})

		await run(registerConfigCommand, ['config', 'show'])

		expect(loggedJson(1)).toEqual({})
	})

	it('saves a valid key and echoes the value masked', async () => {
		await run(registerConfigCommand, ['config', 'set', 'fredApiKey', 'abc123'])

		expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ fredApiKey: 'abc123' })
		expect(loggedLine(0)).toBe('Set fredApiKey = ***')
		expect(out()).not.toContain('abc123')
	})

	it('echoes non-secret values in full', async () => {
		await run(registerConfigCommand, ['config', 'set', 'defaultFormat', 'plain'])

		expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ defaultFormat: 'plain' })
		expect(loggedLine(0)).toBe('Set defaultFormat = plain')
	})

	it('rejects an unknown key without saving', async () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new ProcessExitError('exit')
		})

		const err = await runExpectingFailure(registerConfigCommand, ['config', 'set', 'bogus', 'x'])

		expect(err).toBeInstanceOf(ProcessExitError)
		expect(exitSpy).toHaveBeenCalledWith(1)
		expect(errOut()).toContain('Invalid key: bogus')
		expect(errOut()).toContain('fredApiKey')
		expect(vi.mocked(saveConfig)).not.toHaveBeenCalled()
	})

	it('prints the config file path', async () => {
		await run(registerConfigCommand, ['config', 'path'])

		expect(loggedLine(0)).toBe('/tmp/omd-test-home/.omd/config.json')
	})
})
