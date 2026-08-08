import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TOOLS, validateAgentToolInput } from '../src/agent/catalog.js'
import { type AgentRuntime, createAgentExecutor } from '../src/agent/runtime.js'
import { createOpenMarketDataClient } from '../src/client.js'
import type { Provider, ProviderResult } from '../src/providers/types.js'
import type {
	CryptoCandle,
	EarningsData,
	FinancialStatement,
	HistoricalQuote,
	MacroSeries,
	QuoteResult,
} from '../src/types.js'

function provider(name = 'fake'): Provider {
	return {
		name,
		requiresKey: false,
		capabilities: ['quote'],
		priority: { quote: 1 },
		rateLimits: { maxRequests: 100, windowMs: 60_000 },
		isEnabled: () => true,
		execute: async <T>() => ({ data: undefined as T, source: name, cached: false }),
	}
}

function createRuntime(
	routeImpl: AgentRuntime['route'],
	providers: Provider[] = [provider()],
): AgentRuntime {
	return {
		route: routeImpl,
		getProviders: () => providers,
		ensureProviders: vi.fn(),
		now: () => new Date('2026-08-07T12:00:00.000Z'),
	}
}

function result<T>(data: T, source = 'fake', cached = false): ProviderResult<T> {
	return { data, source, cached }
}

const quote: QuoteResult = {
	symbol: 'AAPL',
	price: 110,
	change: 2,
	changePercent: 1.85,
	source: 'fake',
}

const history: HistoricalQuote[] = [
	{ date: '2026-07-08', open: 99, high: 101, low: 98, close: 100, volume: 10 },
	{ date: '2026-08-07', open: 108, high: 111, low: 107, close: 110, volume: 12 },
]

const financials: FinancialStatement[] = [
	{ period: 'quarterly', date: '2026-06-30', revenue: 1000, netIncome: 100, source: 'fake' },
]

const earnings: EarningsData[] = [
	{ symbol: 'AAPL', earningsDate: '2026-07-31', epsActual: 2, source: 'fake' },
]

describe('agent catalog', () => {
	it('publishes a unique, bounded, read-only tool surface', () => {
		expect(AGENT_TOOLS).toHaveLength(17)
		expect(new Set(AGENT_TOOLS.map((tool) => tool.name)).size).toBe(AGENT_TOOLS.length)

		for (const tool of AGENT_TOOLS) {
			expect(tool.inputSchema.type).toBe('object')
			expect(tool.inputSchema.additionalProperties).toBe(false)
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			})
		}
	})

	it('rejects unknown fields, invalid dates, blank values, and oversized requests', () => {
		expect(validateAgentToolInput('stock_quotes', { symbols: [' aapl ', 'MSFT'] })).toEqual({
			symbols: [' aapl ', 'MSFT'],
		})

		expect(() => validateAgentToolInput('stock_quotes', { symbols: ['AAPL', 'AAPL'] })).toThrow(
			/unique/i,
		)
		expect(() =>
			validateAgentToolInput('stock_quotes', { symbols: ['AAPL'], shell: 'rm -rf /' }),
		).toThrow(/not allowed/i)
		expect(() =>
			validateAgentToolInput('stock_quotes', { symbols: Array.from({ length: 21 }, () => 'A') }),
		).toThrow(/at most 20/i)
		expect(() =>
			validateAgentToolInput('stock_options', { symbol: 'AAPL', expiration: '2026-02-30' }),
		).toThrow(/valid calendar date/i)
		expect(() => validateAgentToolInput('crypto_quote', { symbol: '   ' })).toThrow(
			/non-whitespace/i,
		)
		expect(() => validateAgentToolInput('macro_series', { seriesId: 'GDP', limit: 1001 })).toThrow(
			/at most 1000/i,
		)
	})
})

describe('agent runtime', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('uses the provider batch path for multi-symbol quotes', async () => {
		const route = vi.fn(
			async <T>(_category: string, _action: string, args: Record<string, unknown>) => {
				const symbols = args.symbols as string[]
				return result(symbols.map((symbol) => ({ ...quote, symbol })) as T, 'yahoo')
			},
		) as AgentRuntime['route']
		const runtime = createRuntime(route)
		const response = await createAgentExecutor(runtime).execute('stock_quotes', {
			symbols: ['aapl', ' msft '],
			source: ' YAHOO ',
		})

		expect(route).toHaveBeenCalledTimes(1)
		expect(route).toHaveBeenCalledWith(
			'quote',
			'get',
			{ symbols: ['AAPL', 'MSFT'] },
			{ source: 'yahoo', noCache: false },
		)
		expect(response.data.map((item) => item.symbol)).toEqual(['AAPL', 'MSFT'])
		expect(response.meta).toMatchObject({
			tool: 'stock_quotes',
			request: { symbols: ['AAPL', 'MSFT'] },
			source: 'yahoo',
			cached: false,
			retrievedAt: '2026-08-07T12:00:00.000Z',
		})
	})

	it('fills symbols omitted by a provider batch response without hiding the fallback', async () => {
		const route = vi.fn(
			async <T>(_category: string, _action: string, args: Record<string, unknown>) => {
				if (Array.isArray(args.symbols)) {
					return result([{ ...quote, symbol: 'AAPL' }] as T, 'yahoo')
				}
				return result({ ...quote, symbol: args.symbol as string } as T, 'yahoo')
			},
		) as AgentRuntime['route']
		const response = await createAgentExecutor(createRuntime(route)).execute('stock_quotes', {
			symbols: ['AAPL', 'MSFT'],
		})

		expect(route).toHaveBeenCalledTimes(2)
		expect(response.data.map((item) => item.symbol)).toEqual(['AAPL', 'MSFT'])
		expect(response.meta.partial).toBe(false)
		expect(response.meta.warnings?.[0]).toMatch(/omitted MSFT/i)
	})

	it('rejects symbols that collide after normalization', async () => {
		const route = vi.fn() as unknown as AgentRuntime['route']
		const executor = createAgentExecutor(createRuntime(route))

		await expect(executor.execute('stock_quotes', { symbols: ['AAPL', ' aapl '] })).rejects.toThrow(
			/unique after normalization/i,
		)
		expect(route).not.toHaveBeenCalled()
	})

	it('bounds and orders provider output even when a provider returns too much', async () => {
		const route = vi.fn(async <T>(category: string) => {
			if (category === 'financials') {
				return result([
					{ ...financials[0], date: '2025-12-31' },
					{ ...financials[0], date: '2026-06-30' },
					{ ...financials[0], date: '2026-03-31' },
				] as T)
			}
			if (category === 'history') {
				return result([
					{ ...history[1], date: '2026-08-07' },
					{ ...history[0], date: '2026-08-05' },
					{ ...history[0], date: '2026-08-06' },
				] as T)
			}
			if (category === 'crypto') {
				const candles: CryptoCandle[] = Array.from({ length: 1005 }, (_, index) => ({
					time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
					open: index,
					high: index,
					low: index,
					close: index,
					volume: index,
				}))
				return result(candles.reverse() as T)
			}
			throw new Error(`Unexpected category ${category}`)
		}) as AgentRuntime['route']
		const executor = createAgentExecutor(createRuntime(route))

		const statements = await executor.execute('stock_financials', {
			symbol: 'aapl',
			limit: 2,
		})
		const prices = await executor.execute('stock_history', { symbol: 'aapl', days: 2 })
		const candles = await executor.execute('crypto_history', {
			symbol: 'btc',
			days: 3650,
			interval: '1m',
		})

		expect(statements.data.map((item) => item.date)).toEqual(['2026-06-30', '2026-03-31'])
		expect(prices.data.map((item) => item.date)).toEqual(['2026-08-06', '2026-08-07'])
		expect(candles.data).toHaveLength(1000)
		expect(candles.data[0].time < (candles.data.at(-1)?.time ?? '')).toBe(true)
	})

	it('routes non-US macro data to World Bank, applies defaults, and bounds observations', async () => {
		const series: MacroSeries = {
			id: 'NY.GDP.MKTP.CD',
			title: 'GDP',
			frequency: 'Annual',
			data: Array.from({ length: 150 }, (_, index) => ({
				date: String(1877 + index),
				value: index,
			})),
			source: 'worldbank',
		}
		const route = vi.fn(async <T>() => result(series as T, 'worldbank')) as AgentRuntime['route']
		const response = await createAgentExecutor(createRuntime(route)).execute('macro_series', {
			seriesId: 'ny.gdp.mktp.cd',
			country: 'gb',
		})

		expect(route).toHaveBeenCalledWith(
			'macro',
			'get',
			expect.objectContaining({
				seriesId: 'NY.GDP.MKTP.CD',
				country: 'GB',
				limit: 120,
			}),
			{ source: 'worldbank', noCache: false },
		)
		expect(response.data.data).toHaveLength(120)
		expect(response.meta.request).toMatchObject({
			seriesId: 'NY.GDP.MKTP.CD',
			country: 'GB',
			limit: 120,
			source: 'worldbank',
		})
	})

	it('rejects a country parameter with a non-World-Bank source', async () => {
		const route = vi.fn() as unknown as AgentRuntime['route']
		const executor = createAgentExecutor(createRuntime(route))

		await expect(
			executor.execute('macro_series', {
				seriesId: 'GDP',
				country: 'GB',
				source: 'fred',
			}),
		).rejects.toThrow(/only supported when source is worldbank/i)
		expect(route).not.toHaveBeenCalled()
	})

	it('normalizes macro search fields from provider-specific casing', async () => {
		const route = vi.fn(async <T>() =>
			result(
				[
					{
						id: 'UNRATE',
						title: 'Unemployment Rate',
						units: 'Percent',
						frequency: 'Monthly',
						seasonal_adjustment: 'Seasonally Adjusted',
						popularity: 99,
					},
				] as T,
				'fred',
			),
		) as AgentRuntime['route']
		const response = await createAgentExecutor(createRuntime(route)).execute('macro_search', {
			query: ' unemployment ',
		})

		expect(response.data).toEqual([
			expect.objectContaining({
				id: 'UNRATE',
				seasonalAdjustment: 'Seasonally Adjusted',
			}),
		])
		expect(response.meta.request).toMatchObject({ query: 'unemployment', limit: 20 })
	})

	it('returns an honest partial company snapshot when a component fails', async () => {
		const route = vi.fn(async <T>(category: string) => {
			switch (category) {
				case 'quote':
					return result(quote as T, 'yahoo')
				case 'history':
					return result([...history].reverse() as T, 'yahoo')
				case 'financials':
					return result(financials as T, 'sec-edgar')
				case 'earnings':
					return result(earnings as T, 'yahoo')
				case 'filing':
					throw new Error('SEC temporarily unavailable')
				default:
					throw new Error(`Unexpected category ${category}`)
			}
		}) as AgentRuntime['route']
		const response = await createAgentExecutor(createRuntime(route)).execute('company_snapshot', {
			symbol: 'aapl',
		})

		expect(response.data.performance).toEqual({
			startDate: '2026-07-08',
			endDate: '2026-08-07',
			startClose: 100,
			endClose: 110,
			absoluteChange: 10,
			percentChange: 10,
			observations: 2,
		})
		expect(response.data.recentHistory).toEqual(history)
		expect(response.data.filings).toBeNull()
		expect(response.meta.partial).toBe(true)
		expect(response.meta.sources).toEqual(['sec-edgar', 'yahoo'])
		expect(response.meta.errors).toEqual([
			{ component: 'filings', message: 'SEC temporarily unavailable' },
		])
	})

	it('reports live provider health separately from static capability status', async () => {
		const route = vi.fn() as unknown as AgentRuntime['route']
		const healthy = provider('yahoo')
		healthy.execute = async <T>() => result({ price: 100 } as T, 'yahoo')
		const response = await createAgentExecutor(createRuntime(route, [healthy])).execute(
			'provider_health',
			{ sources: ['YAHOO'], timeoutMs: 5000 },
		)

		expect(route).not.toHaveBeenCalled()
		expect(response.data).toEqual([expect.objectContaining({ name: 'yahoo', status: 'ok' })])
		expect(response.meta.partial).not.toBe(true)
	})

	it('reports sorted provider capability status without making a network request', async () => {
		const route = vi.fn() as unknown as AgentRuntime['route']
		const response = await createAgentExecutor(
			createRuntime(route, [provider('zeta'), provider('alpha')]),
		).execute('provider_status', {})

		expect(route).not.toHaveBeenCalled()
		expect(response.data.map((item) => item.name)).toEqual(['alpha', 'zeta'])
	})

	it('exposes typed results through the high-level TypeScript client', async () => {
		const route = vi.fn(async <T>() =>
			result({ ...quote, symbol: 'AAPL' } as T, 'yahoo'),
		) as AgentRuntime['route']
		const client = createOpenMarketDataClient({ runtime: createRuntime(route) })
		const response = await client.quotes(['aapl'])

		expect(response.data[0]?.symbol).toBe('AAPL')
		expect(response.meta.source).toBe('yahoo')
	})
})
