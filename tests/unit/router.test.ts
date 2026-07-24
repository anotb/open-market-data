import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataCategory, Provider, ProviderResult } from '../../src/providers/types.js'
import { type TempHome, clearConfigEnv, freshImport, makeTempHome } from '../helpers/modules.js'
import {
	ALL_CATEGORIES,
	createFailingProvider,
	createMockProvider,
	createRecordingProvider,
} from '../helpers/providers.js'

/**
 * src/core/router.ts keeps the provider registry in a module-level array and
 * shares the process-lifetime state of cache.ts, config.ts and rate-limiter.ts.
 * Every test therefore:
 *   1. points $HOME at a throwaway dir so `disabledSources` can be controlled
 *      through a real config file without touching the developer's machine,
 *   2. re-imports the router through `freshImport` so the registry, the cache
 *      and the rate-limit buckets all start empty,
 *   3. pulls cache/config/rate-limiter out of that SAME module generation.
 * No test touches the network — every provider here is a local stand-in.
 */

type RouterModule = typeof import('../../src/core/router.js')
type CacheModule = typeof import('../../src/core/cache.js')
type ConfigModule = typeof import('../../src/core/config.js')
type RateLimiterModule = typeof import('../../src/core/rate-limiter.js')

interface Harness {
	router: RouterModule
	cache: CacheModule
	config: ConfigModule
	rateLimiter: RateLimiterModule
}

/** One fresh generation of the router and everything it shares state with. */
async function loadRouter(): Promise<Harness> {
	const router = await freshImport<RouterModule>('../../src/core/router.js')
	const cache: CacheModule = await import('../../src/core/cache.js')
	const config: ConfigModule = await import('../../src/core/config.js')
	const rateLimiter: RateLimiterModule = await import('../../src/core/rate-limiter.js')
	return { router, cache, config, rateLimiter }
}

let home: TempHome
let restoreConfigEnv: () => void

beforeEach(() => {
	restoreConfigEnv = clearConfigEnv()
	home = makeTempHome()
})

afterEach(() => {
	vi.useRealTimers()
	home.cleanup()
	restoreConfigEnv()
})

/** Writes `~/.omd/config.json` — must run before `loadRouter()`. */
function writeConfig(value: Record<string, unknown>): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, JSON.stringify(value, null, 2), { mode: 0o600 })
}

const names = (providers: Provider[]): string[] => providers.map((p) => p.name)

/** Captures the rejection so a test can assert on the exact message. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise
	} catch (err) {
		return err as Error
	}
	throw new Error('expected the promise to reject, but it resolved')
}

// --- fixtures, shaped like the CLI's own result types -----------------------

const AAPL_YAHOO = {
	symbol: 'AAPL',
	price: 189.71,
	change: 1.32,
	changePercent: 0.7,
	volume: 48_527_900,
	previousClose: 188.39,
	source: 'yahoo',
}

const AAPL_FINNHUB = {
	symbol: 'AAPL',
	price: 189.55,
	change: 1.16,
	changePercent: 0.62,
	previousClose: 188.39,
	source: 'finnhub',
}

const BTC_BINANCE = {
	symbol: 'BTCUSDT',
	price: 67_412.55,
	change: 812.4,
	changePercent: 1.22,
	volume: 21_884.31,
	source: 'binance',
}

const BTC_COINGECKO = {
	symbol: 'bitcoin',
	price: 67_390.11,
	change: 790.02,
	changePercent: 1.19,
	source: 'coingecko',
}

const CPI_SERIES = {
	seriesId: 'CPIAUCSL',
	title: 'Consumer Price Index for All Urban Consumers',
	units: 'Index 1982-1984=100',
	observations: [
		{ date: '2024-04-01', value: 313.548 },
		{ date: '2024-05-01', value: 314.069 },
	],
	source: 'fred',
}

// ---------------------------------------------------------------------------

describe('registerProvider', () => {
	it('adds a provider to the registry', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(names(router.getProviders())).toEqual(['yahoo'])
	})

	it('keeps providers in registration order', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'sec-edgar' }))
		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'finnhub' }))

		expect(names(router.getProviders())).toEqual(['sec-edgar', 'yahoo', 'finnhub'])
	})

	it('ignores a second registration of the same name', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(router.getProviders()).toHaveLength(1)
	})

	it('keeps the first registration when a name is reused', async () => {
		const { router } = await loadRouter()
		const first = createMockProvider({ name: 'yahoo', priority: { quote: 1 } })
		const second = createMockProvider({ name: 'yahoo', priority: { quote: 9 } })

		router.registerProvider(first)
		router.registerProvider(second)

		expect(router.getProviders()[0]).toBe(first)
		expect(router.getProviders()[0]?.priority.quote).toBe(1)
	})

	it('routes to the first registration when a name is reused', async () => {
		const { router } = await loadRouter()
		const winner = createRecordingProvider('yahoo', AAPL_YAHOO)
		const loser = createRecordingProvider('yahoo', AAPL_FINNHUB)
		router.registerProvider(winner.provider)
		router.registerProvider(loser.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.data).toEqual(AAPL_YAHOO)
		expect(winner.calls).toHaveLength(1)
		expect(loser.calls).toHaveLength(0)
	})

	it('treats names that differ only in case as different providers', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'Yahoo' }))

		expect(names(router.getProviders())).toEqual(['yahoo', 'Yahoo'])
	})

	it('registers a provider that declares no capabilities at all', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'inert', capabilities: [] }))

		expect(names(router.getProviders())).toEqual(['inert'])
		expect(router.getProvidersForCategory('quote')).toEqual([])
	})

	it('registers a disabled provider so it can still be reported on', async () => {
		const { router } = await loadRouter()

		router.registerProvider(createMockProvider({ name: 'fred', isEnabled: () => false }))

		expect(names(router.getProviders())).toEqual(['fred'])
	})

	it('starts from an empty registry in every fresh module generation', async () => {
		const first = await loadRouter()
		first.router.registerProvider(createMockProvider({ name: 'yahoo' }))
		expect(first.router.getProviders()).toHaveLength(1)

		const second = await loadRouter()

		expect(second.router.getProviders()).toEqual([])
	})
})

describe('getProviders', () => {
	it('returns an empty array before anything is registered', async () => {
		const { router } = await loadRouter()

		expect(router.getProviders()).toEqual([])
	})

	it('returns a copy, so pushing into it does not grow the registry', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		const snapshot = router.getProviders()
		snapshot.push(createMockProvider({ name: 'intruder' }))

		expect(names(router.getProviders())).toEqual(['yahoo'])
	})

	it('returns a copy, so emptying it does not clear the registry', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'finnhub' }))

		router.getProviders().splice(0, 2)

		expect(names(router.getProviders())).toEqual(['yahoo', 'finnhub'])
	})

	it('returns a copy, so reordering it does not reorder the registry', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'finnhub' }))

		router.getProviders().reverse()

		expect(names(router.getProviders())).toEqual(['yahoo', 'finnhub'])
	})

	it('returns a new array on every call', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(router.getProviders()).not.toBe(router.getProviders())
		expect(router.getProviders()).toEqual(router.getProviders())
	})

	it('hands back the registered provider objects themselves', async () => {
		const { router } = await loadRouter()
		const provider = createMockProvider({ name: 'yahoo' })
		router.registerProvider(provider)

		expect(router.getProviders()[0]).toBe(provider)
	})

	it('includes providers that are disabled or turned off in config', async () => {
		writeConfig({ disabledSources: ['binance'] })
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'binance' }))
		router.registerProvider(createMockProvider({ name: 'fred', isEnabled: () => false }))

		expect(names(router.getProviders())).toEqual(['binance', 'fred'])
	})
})

describe('getProvidersForCategory — filtering', () => {
	it('returns providers that declare the category', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo', capabilities: ['quote'] }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('excludes providers that do not declare the category', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)

		expect(router.getProvidersForCategory('quote')).toEqual([])
	})

	it('returns a multi-capability provider for each of its categories', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				capabilities: ['quote', 'history', 'search'],
				priority: { quote: 1, history: 1, search: 2 },
			}),
		)

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
		expect(names(router.getProvidersForCategory('history'))).toEqual(['yahoo'])
		expect(names(router.getProvidersForCategory('search'))).toEqual(['yahoo'])
		expect(router.getProvidersForCategory('options')).toEqual([])
	})

	it.each(ALL_CATEGORIES)('returns a fully capable provider for %s', async (category) => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'omni', capabilities: [...ALL_CATEGORIES], priority: {} }),
		)

		expect(names(router.getProvidersForCategory(category))).toEqual(['omni'])
	})

	it('excludes providers whose isEnabled() returns false', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		router.registerProvider(createMockProvider({ name: 'finnhub', isEnabled: () => false }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('re-evaluates isEnabled() on every call rather than caching it', async () => {
		const { router } = await loadRouter()
		let enabled = false
		router.registerProvider(createMockProvider({ name: 'finnhub', isEnabled: () => enabled }))

		expect(router.getProvidersForCategory('quote')).toEqual([])
		enabled = true
		expect(names(router.getProvidersForCategory('quote'))).toEqual(['finnhub'])
	})

	it('excludes providers named in config.disabledSources', async () => {
		writeConfig({ disabledSources: ['binance'] })
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)
		router.registerProvider(
			createMockProvider({ name: 'coingecko', capabilities: ['crypto'], priority: { crypto: 2 } }),
		)

		expect(names(router.getProvidersForCategory('crypto'))).toEqual(['coingecko'])
	})

	it('excludes every provider listed in disabledSources', async () => {
		writeConfig({ disabledSources: ['binance', 'coingecko'] })
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)
		router.registerProvider(
			createMockProvider({ name: 'coingecko', capabilities: ['crypto'], priority: { crypto: 2 } }),
		)

		expect(router.getProvidersForCategory('crypto')).toEqual([])
	})

	it('keeps every provider when there is no config file at all', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('keeps every provider when disabledSources is an empty array', async () => {
		writeConfig({ disabledSources: [], defaultFormat: 'markdown' })
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('ignores disabledSources entries that match no registered provider', async () => {
		writeConfig({ disabledSources: ['polygon', 'iex'] })
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('matches disabledSources names case-sensitively', async () => {
		writeConfig({ disabledSources: ['Yahoo'] })
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo'])
	})

	it('returns an empty array when nothing is registered', async () => {
		const { router } = await loadRouter()

		expect(router.getProvidersForCategory('quote')).toEqual([])
	})

	it('returns a new array on every call', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		expect(router.getProvidersForCategory('quote')).not.toBe(
			router.getProvidersForCategory('quote'),
		)
	})
})

describe('getProvidersForCategory — ordering', () => {
	it('sorts ascending by the priority for the category', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'third', priority: { quote: 30 } }))
		router.registerProvider(createMockProvider({ name: 'first', priority: { quote: 10 } }))
		router.registerProvider(createMockProvider({ name: 'second', priority: { quote: 20 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['first', 'second', 'third'])
	})

	it('uses the priority of the requested category, not of another one', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				capabilities: ['quote', 'crypto'],
				priority: { quote: 1, crypto: 9 },
			}),
		)
		router.registerProvider(
			createMockProvider({
				name: 'binance',
				capabilities: ['quote', 'crypto'],
				priority: { quote: 9, crypto: 1 },
			}),
		)

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo', 'binance'])
		expect(names(router.getProvidersForCategory('crypto'))).toEqual(['binance', 'yahoo'])
	})

	it('treats priority 0 as the strongest priority', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'one', priority: { quote: 1 } }))
		router.registerProvider(createMockProvider({ name: 'zero', priority: { quote: 0 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['zero', 'one'])
	})

	it('sorts a negative priority ahead of zero', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'zero', priority: { quote: 0 } }))
		router.registerProvider(createMockProvider({ name: 'negative', priority: { quote: -5 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['negative', 'zero'])
	})

	it('sorts a provider with no priority entry for the category last', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'unranked', priority: {} }))
		router.registerProvider(createMockProvider({ name: 'ranked', priority: { quote: 50 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['ranked', 'unranked'])
	})

	it('defaults to 99 for a provider that only ranks a different category', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'crypto-first',
				capabilities: ['quote', 'crypto'],
				priority: { crypto: 1 },
			}),
		)
		router.registerProvider(createMockProvider({ name: 'ranked', priority: { quote: 98 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['ranked', 'crypto-first'])
	})

	it('treats an explicit undefined priority the same as a missing one', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'explicit', priority: { quote: undefined } }),
		)
		router.registerProvider(createMockProvider({ name: 'ranked', priority: { quote: 98 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['ranked', 'explicit'])
	})

	it('sorts priority 100 after a provider with no entry, which defaults to 99', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'century', priority: { quote: 100 } }))
		router.registerProvider(createMockProvider({ name: 'unranked', priority: {} }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['unranked', 'century'])
	})

	it('leaves an explicit 99 tied with a missing entry, keeping registration order', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'explicit-99', priority: { quote: 99 } }))
		router.registerProvider(createMockProvider({ name: 'unranked', priority: {} }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['explicit-99', 'unranked'])
	})

	it('keeps registration order for equal priorities when both have headroom', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'alpha', priority: { quote: 5 } }))
		router.registerProvider(createMockProvider({ name: 'beta', priority: { quote: 5 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['alpha', 'beta'])
	})

	it('breaks a priority tie toward the provider with rate-limit headroom', async () => {
		const { router, rateLimiter } = await loadRouter()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const throttledLimits = { maxRequests: 1, windowMs: 60_000 }
		router.registerProvider(
			createMockProvider({
				name: 'throttled',
				priority: { quote: 5 },
				rateLimits: throttledLimits,
			}),
		)
		router.registerProvider(createMockProvider({ name: 'roomy', priority: { quote: 5 } }))
		// Spend the throttled provider's only token so canRequest() reports false.
		expect(rateLimiter.consumeToken('throttled', throttledLimits)).toBe(true)

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['roomy', 'throttled'])
	})

	it('keeps the rate-limited provider last no matter the registration order', async () => {
		const { router, rateLimiter } = await loadRouter()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const throttledLimits = { maxRequests: 1, windowMs: 60_000 }
		router.registerProvider(createMockProvider({ name: 'roomy', priority: { quote: 5 } }))
		router.registerProvider(
			createMockProvider({
				name: 'throttled',
				priority: { quote: 5 },
				rateLimits: throttledLimits,
			}),
		)
		rateLimiter.consumeToken('throttled', throttledLimits)

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['roomy', 'throttled'])
	})

	it('does not let rate-limit headroom beat a better priority', async () => {
		const { router, rateLimiter } = await loadRouter()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const throttledLimits = { maxRequests: 1, windowMs: 60_000 }
		router.registerProvider(
			createMockProvider({
				name: 'throttled',
				priority: { quote: 1 },
				rateLimits: throttledLimits,
			}),
		)
		router.registerProvider(createMockProvider({ name: 'roomy', priority: { quote: 2 } }))
		rateLimiter.consumeToken('throttled', throttledLimits)

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['throttled', 'roomy'])
	})

	it('restores the tie order once the throttled bucket refills', async () => {
		const { router, rateLimiter } = await loadRouter()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
		const throttledLimits = { maxRequests: 1, windowMs: 60_000 }
		router.registerProvider(
			createMockProvider({
				name: 'throttled',
				priority: { quote: 5 },
				rateLimits: throttledLimits,
			}),
		)
		router.registerProvider(createMockProvider({ name: 'roomy', priority: { quote: 5 } }))
		rateLimiter.consumeToken('throttled', throttledLimits)
		expect(names(router.getProvidersForCategory('quote'))).toEqual(['roomy', 'throttled'])

		vi.setSystemTime(new Date('2024-06-15T12:01:00Z'))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['throttled', 'roomy'])
	})

	it('does not reorder the registry itself', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'slow', priority: { quote: 50 } }))
		router.registerProvider(createMockProvider({ name: 'fast', priority: { quote: 1 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['fast', 'slow'])
		expect(names(router.getProviders())).toEqual(['slow', 'fast'])
	})

	it('sorts only the providers that survive filtering', async () => {
		writeConfig({ disabledSources: ['off-in-config'] })
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'off-in-config', priority: { quote: 0 } }))
		router.registerProvider(
			createMockProvider({ name: 'off', priority: { quote: 0 }, isEnabled: () => false }),
		)
		router.registerProvider(createMockProvider({ name: 'second', priority: { quote: 20 } }))
		router.registerProvider(createMockProvider({ name: 'first', priority: { quote: 10 } }))

		expect(names(router.getProvidersForCategory('quote'))).toEqual(['first', 'second'])
	})
})

describe('route — provider selection', () => {
	it('returns the result of the highest-priority provider', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 5 } }).provider,
		)
		router.registerProvider(
			createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } }).provider,
		)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: false })
	})

	it('passes the category, action and args straight through to execute', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, {
			capabilities: ['history'],
			priority: { history: 1 },
		})
		router.registerProvider(yahoo.provider)

		await router.route('history', 'daily', { symbol: 'AAPL', range: '1mo', interval: '1d' })

		expect(yahoo.calls).toEqual([
			{
				category: 'history',
				action: 'daily',
				args: { symbol: 'AAPL', range: '1mo', interval: '1d' },
			},
		])
	})

	it('does not consult lower-priority providers when the first succeeds', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } })
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(yahoo.provider)
		router.registerProvider(finnhub.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(yahoo.calls).toHaveLength(1)
		expect(finnhub.calls).toHaveLength(0)
	})

	it('falls back to the next provider and returns its result when the first throws', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'yahoo 502'),
				priority: { quote: 1 },
			}),
		)
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(finnhub.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: false })
		expect(finnhub.calls).toEqual([{ category: 'quote', action: 'get', args: { symbol: 'AAPL' } }])
	})

	it('falls back through several consecutive failures', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ ...createFailingProvider('a', 'a down'), priority: { quote: 1 } }),
		)
		router.registerProvider(
			createMockProvider({ ...createFailingProvider('b', 'b down'), priority: { quote: 2 } }),
		)
		const last = createRecordingProvider('c', AAPL_YAHOO, { priority: { quote: 3 } })
		router.registerProvider(last.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('c')
		expect(last.calls).toHaveLength(1)
	})

	it('falls back in priority order, not registration order', async () => {
		const { router } = await loadRouter()
		const third = createRecordingProvider('third', AAPL_YAHOO, { priority: { quote: 3 } })
		router.registerProvider(third.provider)
		router.registerProvider(
			createMockProvider({ ...createFailingProvider('first', 'boom'), priority: { quote: 1 } }),
		)
		const second = createRecordingProvider('second', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(second.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('second')
		expect(third.calls).toHaveLength(0)
	})

	it('returns the provider result verbatim, including its own source label', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async <T>() =>
					({
						data: AAPL_YAHOO as unknown as T,
						source: 'yahoo-v8',
						cached: true,
					}) as ProviderResult<T>,
			}),
		)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_YAHOO, source: 'yahoo-v8', cached: true })
	})

	it('skips a provider whose isEnabled() is false even at top priority', async () => {
		const { router } = await loadRouter()
		const off = createRecordingProvider('off', AAPL_FINNHUB, {
			priority: { quote: 1 },
			isEnabled: () => false,
		})
		const on = createRecordingProvider('on', AAPL_YAHOO, { priority: { quote: 9 } })
		router.registerProvider(off.provider)
		router.registerProvider(on.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('on')
		expect(off.calls).toHaveLength(0)
	})

	it('skips a provider disabled in config even at top priority', async () => {
		writeConfig({ disabledSources: ['binance'] })
		const { router } = await loadRouter()
		const binance = createRecordingProvider('binance', BTC_BINANCE, {
			capabilities: ['crypto'],
			priority: { crypto: 1 },
		})
		const coingecko = createRecordingProvider('coingecko', BTC_COINGECKO, {
			capabilities: ['crypto'],
			priority: { crypto: 2 },
		})
		router.registerProvider(binance.provider)
		router.registerProvider(coingecko.provider)

		const result = await router.route('crypto', 'get', { symbol: 'BTC' })

		expect(result).toEqual({ data: BTC_COINGECKO, source: 'coingecko', cached: false })
		expect(binance.calls).toHaveLength(0)
	})

	it('ignores providers that lack the requested capability', async () => {
		const { router } = await loadRouter()
		const binance = createRecordingProvider('binance', BTC_BINANCE, {
			capabilities: ['crypto'],
			priority: { crypto: 1 },
		})
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 5 } })
		router.registerProvider(binance.provider)
		router.registerProvider(yahoo.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('yahoo')
		expect(binance.calls).toHaveLength(0)
	})

	it('accepts an empty args object', async () => {
		const { router } = await loadRouter()
		const fred = createRecordingProvider('fred', CPI_SERIES, {
			capabilities: ['macro'],
			priority: { macro: 1 },
		})
		router.registerProvider(fred.provider)

		const result = await router.route('macro', 'list', {})

		expect(result.data).toEqual(CPI_SERIES)
		expect(fred.calls).toEqual([{ category: 'macro', action: 'list', args: {} }])
	})
})

describe('route — every provider fails', () => {
	it('names the tried sources and the last error message', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'yahoo 502'),
				priority: { quote: 1 },
			}),
		)
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('finnhub', 'finnhub 429 rate limit'),
				priority: { quote: 2 },
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe(
			'All providers failed for quote/get (tried: yahoo, finnhub): finnhub 429 rate limit',
		)
	})

	it('lists a single failing source without a separator', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createFailingProvider('yahoo', 'socket hang up'))

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('All providers failed for quote/get (tried: yahoo): socket hang up')
	})

	it('lists the sources in the order they were tried', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ ...createFailingProvider('slow', 'slow down'), priority: { quote: 9 } }),
		)
		router.registerProvider(
			createMockProvider({ ...createFailingProvider('fast', 'fast down'), priority: { quote: 1 } }),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('All providers failed for quote/get (tried: fast, slow): slow down')
	})

	it('includes the category and the action in the message', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('fred', 'FRED 400 Bad Request'),
				capabilities: ['macro'],
				priority: { macro: 1 },
			}),
		)

		const err = await rejection(router.route('macro', 'series', { seriesId: 'CPIAUCSL' }))

		expect(err.message).toBe(
			'All providers failed for macro/series (tried: fred): FRED 400 Bad Request',
		)
	})

	it('stringifies a rejection that is not an Error', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async () => {
					throw 'upstream said no'
				},
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('All providers failed for quote/get (tried: yahoo): upstream said no')
	})

	it('stringifies a thrown plain object', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async () => {
					throw { status: 500 }
				},
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('All providers failed for quote/get (tried: yahoo): [object Object]')
	})

	it('stringifies a thrown undefined', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async () => {
					// Reproduces a provider doing a bare `throw undefined`.
					throw undefined
				},
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('All providers failed for quote/get (tried: yahoo): undefined')
	})

	it('rejects with an Error instance', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createFailingProvider('yahoo'))

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err).toBeInstanceOf(Error)
	})

	it('caches nothing when every provider fails', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(createFailingProvider('yahoo', 'yahoo 502'))

		await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(cache.size()).toBe(0)
	})

	it('caches nothing for a provider that failed before a later one succeeded', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'yahoo 502'),
				priority: { quote: 1 },
			}),
		)
		router.registerProvider(
			createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } }).provider,
		)

		await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(cache.get('yahoo', 'quote', { action: 'get', symbol: 'AAPL' })).toBeUndefined()
		expect(cache.get('finnhub', 'quote', { action: 'get', symbol: 'AAPL' })).toEqual(AAPL_FINNHUB)
	})
})

describe('route — the source option', () => {
	it('executes exactly the named provider', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } })
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(yahoo.provider)
		router.registerProvider(finnhub.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'finnhub' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: false })
		expect(yahoo.calls).toHaveLength(0)
	})

	it('does not fall back to another provider when the forced source fails', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'yahoo 502'),
				priority: { quote: 1 },
			}),
		)
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(finnhub.provider)

		const err = await rejection(
			router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'yahoo' }),
		)

		expect(err.message).toBe('All providers failed for quote/get (tried: yahoo): yahoo 502')
		expect(finnhub.calls).toHaveLength(0)
	})

	it('throws when the source is not registered', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		const err = await rejection(
			router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'polygon' }),
		)

		expect(err.message).toBe('Source "polygon" not available for category "quote"')
	})

	it('throws when the source is registered but lacks the capability', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		const err = await rejection(
			router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'binance' }),
		)

		expect(err.message).toBe('Source "binance" not available for category "quote"')
	})

	it('throws when the source is registered but not enabled', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'fred',
				capabilities: ['macro'],
				priority: { macro: 1 },
				requiresKey: true,
				keyEnvVar: 'FRED_API_KEY',
				isEnabled: () => false,
			}),
		)

		const err = await rejection(router.route('macro', 'series', {}, { source: 'fred' }))

		expect(err.message).toBe('Source "fred" not available for category "macro"')
	})

	it('throws when the source is disabled in config', async () => {
		writeConfig({ disabledSources: ['binance'] })
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)

		const err = await rejection(
			router.route('crypto', 'get', { symbol: 'BTC' }, { source: 'binance' }),
		)

		expect(err.message).toBe('Source "binance" not available for category "crypto"')
	})

	it('matches the source name case-sensitively', async () => {
		const { router } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))

		const err = await rejection(
			router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'Yahoo' }),
		)

		expect(err.message).toBe('Source "Yahoo" not available for category "quote"')
	})

	it('prefers the source error over the "no providers" error', async () => {
		const { router } = await loadRouter()

		const err = await rejection(
			router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'polygon' }),
		)

		expect(err.message).toBe('Source "polygon" not available for category "quote"')
	})

	it('treats an empty source string as no source at all', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } })
		router.registerProvider(yahoo.provider)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' }, { source: '' })

		expect(result.source).toBe('yahoo')
		expect(yahoo.calls).toHaveLength(1)
	})
})

describe('route — nothing available', () => {
	it('throws the plain message when the registry is empty', async () => {
		const { router } = await loadRouter()

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe('No providers available for category "quote"')
	})

	it('throws the plain message when no provider declares the category', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)

		const err = await rejection(router.route('options', 'chain', { symbol: 'AAPL' }))

		expect(err.message).toBe('No providers available for category "options"')
	})

	it.each([
		['FRED_API_KEY', 'fredApiKey'],
		['COINGECKO_API_KEY', 'coingeckoApiKey'],
		['FINNHUB_API_KEY', 'finnhubApiKey'],
		['ALPHA_VANTAGE_API_KEY', 'alphaVantageApiKey'],
	])('points a provider needing %s at `omd config set %s`', async (envVar, configKey) => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'keyed',
				capabilities: ['macro'],
				priority: { macro: 1 },
				requiresKey: true,
				keyEnvVar: envVar,
				isEnabled: () => false,
			}),
		)

		const err = await rejection(router.route('macro', 'series', {}, { noCache: true }))

		expect(err.message).toBe(
			`No providers available for "macro". Providers exist but are not enabled:\n  keyed: requires ${envVar} (run: omd config set ${configKey} <key>)`,
		)
	})

	it('falls back to the raw env var name for an unmapped key', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'polygon',
				capabilities: ['quote'],
				requiresKey: true,
				keyEnvVar: 'POLYGON_API_KEY',
				isEnabled: () => false,
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(err.message).toBe(
			'No providers available for "quote". Providers exist but are not enabled:\n  polygon: requires POLYGON_API_KEY (run: omd config set POLYGON_API_KEY <key>)',
		)
	})

	it('does not map the EDGAR user agent env var', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'sec-edgar',
				capabilities: ['filing'],
				requiresKey: true,
				keyEnvVar: 'EDGAR_USER_AGENT',
				isEnabled: () => false,
			}),
		)

		const err = await rejection(router.route('filing', 'list', { symbol: 'AAPL' }))

		expect(err.message).toBe(
			'No providers available for "filing". Providers exist but are not enabled:\n  sec-edgar: requires EDGAR_USER_AGENT (run: omd config set EDGAR_USER_AGENT <key>)',
		)
	})

	it('reports a disabled provider with no keyEnvVar as simply disabled', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'binance',
				capabilities: ['crypto'],
				priority: { crypto: 1 },
				isEnabled: () => false,
			}),
		)

		const err = await rejection(router.route('crypto', 'get', { symbol: 'BTC' }))

		expect(err.message).toBe(
			'No providers available for "crypto". Providers exist but are not enabled:\n  binance: disabled',
		)
	})

	it('reports a provider switched off through config.disabledSources', async () => {
		writeConfig({ disabledSources: ['binance'] })
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)

		const err = await rejection(router.route('crypto', 'get', { symbol: 'BTC' }))

		expect(err.message).toBe(
			'No providers available for "crypto". Providers exist but are not enabled:\n  binance: disabled in config',
		)
	})

	it('lists one reason per capable provider, in registration order', async () => {
		writeConfig({ disabledSources: ['coingecko'] })
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'fred',
				capabilities: ['macro'],
				requiresKey: true,
				keyEnvVar: 'FRED_API_KEY',
				isEnabled: () => false,
			}),
		)
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['macro'], isEnabled: () => false }),
		)
		router.registerProvider(createMockProvider({ name: 'coingecko', capabilities: ['macro'] }))

		const err = await rejection(router.route('macro', 'series', { seriesId: 'CPIAUCSL' }))

		expect(err.message).toBe(
			[
				'No providers available for "macro". Providers exist but are not enabled:',
				'  fred: requires FRED_API_KEY (run: omd config set fredApiKey <key>)',
				'  binance: disabled',
				'  coingecko: disabled in config',
			].join('\n'),
		)
	})

	it('ignores providers of other categories when building the reasons', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'yahoo', capabilities: ['quote'], isEnabled: () => false }),
		)
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], isEnabled: () => false }),
		)

		const err = await rejection(router.route('crypto', 'get', { symbol: 'BTC' }))

		expect(err.message).toBe(
			'No providers available for "crypto". Providers exist but are not enabled:\n  binance: disabled',
		)
	})

	it('reports "unknown" for a provider that turns itself on between the two checks', async () => {
		// NOTE: suspected bug — the "unknown" branch is only reachable when
		// isEnabled() is non-deterministic; the reasons are recomputed instead of
		// captured during filtering, so a provider that flips reports no real reason.
		const { router } = await loadRouter()
		let checks = 0
		router.registerProvider(
			createMockProvider({
				name: 'flaky',
				capabilities: ['quote'],
				isEnabled: () => {
					checks += 1
					return checks > 1
				},
			}),
		)

		const err = await rejection(router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true }))

		expect(err.message).toBe(
			'No providers available for "quote". Providers exist but are not enabled:\n  flaky: unknown',
		)
	})

	it('does not execute any provider when none are available', async () => {
		const { router } = await loadRouter()
		const off = createRecordingProvider('off', AAPL_YAHOO, { isEnabled: () => false })
		router.registerProvider(off.provider)

		await rejection(router.route('quote', 'get', { symbol: 'AAPL' }))

		expect(off.calls).toHaveLength(0)
	})
})

describe('route — caching', () => {
	it('serves an identical second call from cache without executing again', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		const first = await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(first).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: false })
		expect(second).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: true })
		expect(yahoo.calls).toHaveLength(1)
	})

	it('keeps serving the cached entry on further calls', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(yahoo.calls).toHaveLength(1)
	})

	it('re-executes for a different action', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'summary', { symbol: 'AAPL' })

		expect(second.cached).toBe(false)
		expect(yahoo.calls.map((c) => c.action)).toEqual(['get', 'summary'])
	})

	it('re-executes for different args', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'MSFT' })

		expect(second.cached).toBe(false)
		expect(yahoo.calls).toHaveLength(2)
	})

	it('re-executes when an extra arg is added', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL', extended: true })

		expect(yahoo.calls).toHaveLength(2)
	})

	it('hits the same entry when the args are supplied in a different order', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL', range: '1d' })
		const second = await router.route('quote', 'get', { range: '1d', symbol: 'AAPL' })

		expect(second.cached).toBe(true)
		expect(yahoo.calls).toHaveLength(1)
	})

	it('keeps separate entries per category', async () => {
		const { router } = await loadRouter()
		const both = createRecordingProvider('yahoo', AAPL_YAHOO, {
			capabilities: ['quote', 'crypto'],
			priority: { quote: 1, crypto: 1 },
		})
		router.registerProvider(both.provider)

		await router.route('quote', 'get', { symbol: 'BTC' })
		const second = await router.route('crypto', 'get', { symbol: 'BTC' })

		expect(second.cached).toBe(false)
		expect(both.calls.map((c) => c.category)).toEqual(['quote', 'crypto'])
	})

	it('lets an args key named "action" shadow the action in the cache key', async () => {
		// NOTE: suspected bug — the cache key is built as `{ action, ...args }`, so an
		// arg literally called `action` overwrites the action and two different
		// actions collide on one cache entry.
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { action: 'shadow' })
		const second = await router.route('quote', 'summary', { action: 'shadow' })

		expect(second).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: true })
		expect(yahoo.calls).toHaveLength(1)
	})

	it('stores the entry under the winning provider name', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } }).provider,
		)

		await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(cache.get('yahoo', 'quote', { action: 'get', symbol: 'AAPL' })).toEqual(AAPL_YAHOO)
		expect(cache.size()).toBe(1)
	})

	it('caches only the data, so a cached hit reports the provider name as source', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async <T>() =>
					({
						data: AAPL_YAHOO as unknown as T,
						source: 'yahoo-v8',
						cached: false,
					}) as ProviderResult<T>,
			}),
		)

		const first = await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(first.source).toBe('yahoo-v8')
		expect(second).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: true })
	})

	it('serves a cached entry written by a fallback provider', async () => {
		const { router } = await loadRouter()
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'yahoo 502'),
				priority: { quote: 1 },
			}),
		)
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(finnhub.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(second).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: true })
		expect(finnhub.calls).toHaveLength(1)
	})

	it('serves an entry primed under another provider on an unforced route', async () => {
		const { router, cache } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } })
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(yahoo.provider)
		router.registerProvider(finnhub.provider)
		cache.set('finnhub', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_FINNHUB)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: true })
		expect(yahoo.calls).toHaveLength(0)
	})

	it('consults cached providers in registration order, not priority order', async () => {
		// NOTE: suspected bug — the cache lookup iterates the raw registry, so a
		// stale entry from a low-priority source wins over the preferred source's
		// own cached entry.
		const { router, cache } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'low', priority: { quote: 50 } }))
		router.registerProvider(createMockProvider({ name: 'high', priority: { quote: 1 } }))
		cache.set('low', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_FINNHUB)
		cache.set('high', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_YAHOO)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'low', cached: true })
	})

	it('serves a cached entry from a provider disabled in config', async () => {
		// NOTE: suspected bug — the cache lookup filters on capability and
		// isEnabled() but not on config.disabledSources, so `omd config disable
		// binance` still returns binance data while its cache entry lives.
		writeConfig({ disabledSources: ['binance'] })
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)
		const coingecko = createRecordingProvider('coingecko', BTC_COINGECKO, {
			capabilities: ['crypto'],
			priority: { crypto: 2 },
		})
		router.registerProvider(coingecko.provider)
		cache.set('binance', 'crypto', { action: 'get', symbol: 'BTC' }, BTC_BINANCE)

		const result = await router.route('crypto', 'get', { symbol: 'BTC' })

		expect(result).toEqual({ data: BTC_BINANCE, source: 'binance', cached: true })
		expect(coingecko.calls).toHaveLength(0)
	})

	it('ignores the cached entry of a provider that is not enabled', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'off', priority: { quote: 1 }, isEnabled: () => false }),
		)
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 2 } })
		router.registerProvider(yahoo.provider)
		cache.set('off', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_FINNHUB)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: false })
		expect(yahoo.calls).toHaveLength(1)
	})

	it('ignores the cached entry of a provider that lacks the capability', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createMockProvider({ name: 'binance', capabilities: ['crypto'], priority: { crypto: 1 } }),
		)
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)
		cache.set('binance', 'quote', { action: 'get', symbol: 'AAPL' }, BTC_BINANCE)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result.source).toBe('yahoo')
	})

	it('consults only the forced source when --source is set', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } })
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(yahoo.provider)
		router.registerProvider(finnhub.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const forced = await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'finnhub' })

		expect(forced).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: false })
		expect(yahoo.calls).toHaveLength(1)
		expect(finnhub.calls).toHaveLength(1)
	})

	it('serves the forced source from its own cache entry', async () => {
		const { router } = await loadRouter()
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(createMockProvider({ name: 'yahoo', priority: { quote: 1 } }))
		router.registerProvider(finnhub.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'finnhub' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'finnhub' })

		expect(second).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: true })
		expect(finnhub.calls).toHaveLength(1)
	})

	it('serves a cached entry for a source that is not even available', async () => {
		// NOTE: suspected bug — the cache is consulted before the source is
		// validated, so `--source polygon` returns data instead of the
		// 'Source "polygon" not available' error while an entry survives.
		const { router, cache } = await loadRouter()
		router.registerProvider(createMockProvider({ name: 'yahoo' }))
		cache.set('polygon', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_FINNHUB)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'polygon' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'polygon', cached: true })
	})

	it('bypasses the cache read when noCache is set', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true })

		expect(second.cached).toBe(false)
		expect(yahoo.calls).toHaveLength(2)
	})

	it('bypasses the cache write when noCache is set', async () => {
		const { router, cache } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true })

		expect(cache.size()).toBe(0)
		expect(cache.get('yahoo', 'quote', { action: 'get', symbol: 'AAPL' })).toBeUndefined()
	})

	it('re-executes after two noCache calls, proving nothing was ever written', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true })
		await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true })
		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(yahoo.calls).toHaveLength(3)
	})

	it('leaves an existing cache entry intact when noCache is set', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: true })
		const third = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(third.cached).toBe(true)
		expect(yahoo.calls).toHaveLength(2)
	})

	it('bypasses both cache halves for a forced source', async () => {
		const { router, cache } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)
		cache.set('yahoo', 'quote', { action: 'get', symbol: 'AAPL' }, AAPL_FINNHUB)

		const result = await router.route(
			'quote',
			'get',
			{ symbol: 'AAPL' },
			{ source: 'yahoo', noCache: true },
		)

		expect(result).toEqual({ data: AAPL_YAHOO, source: 'yahoo', cached: false })
		expect(yahoo.calls).toHaveLength(1)
	})

	it('treats noCache: false the same as omitting it', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: false })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' }, { noCache: false })

		expect(second.cached).toBe(true)
		expect(yahoo.calls).toHaveLength(1)
	})

	it('still serves the cache one millisecond before the category TTL expires', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		await router.route('quote', 'get', { symbol: 'AAPL' })
		vi.setSystemTime(new Date('2024-06-15T12:00:29.999Z'))
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(second.cached).toBe(true)
		expect(yahoo.calls).toHaveLength(1)
	})

	it('re-executes exactly at the 30s quote TTL boundary', async () => {
		const { router } = await loadRouter()
		const yahoo = createRecordingProvider('yahoo', AAPL_YAHOO)
		router.registerProvider(yahoo.provider)
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		await router.route('quote', 'get', { symbol: 'AAPL' })
		vi.setSystemTime(new Date('2024-06-15T12:00:30.000Z'))
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(second.cached).toBe(false)
		expect(yahoo.calls).toHaveLength(2)
	})

	it('holds a macro result far longer than a quote result', async () => {
		const { router } = await loadRouter()
		const fred = createRecordingProvider('fred', CPI_SERIES, {
			capabilities: ['macro'],
			priority: { macro: 1 },
		})
		router.registerProvider(fred.provider)
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))

		await router.route('macro', 'series', { seriesId: 'CPIAUCSL' })
		vi.setSystemTime(new Date('2024-06-15T12:30:00Z'))
		const second = await router.route('macro', 'series', { seriesId: 'CPIAUCSL' })

		expect(second).toEqual({ data: CPI_SERIES, source: 'fred', cached: true })
		expect(fred.calls).toHaveLength(1)
	})

	it('re-executes a provider whose payload is undefined', async () => {
		// NOTE: suspected bug — the cache hit is decided by the truthiness of the
		// stored value, so an entry holding undefined is indistinguishable from a
		// miss and the provider is re-executed on every call.
		const { router, cache } = await loadRouter()
		let runs = 0
		router.registerProvider(
			createMockProvider({
				name: 'yahoo',
				execute: async <T>() => {
					runs += 1
					return { data: undefined as T, source: 'yahoo', cached: false } as ProviderResult<T>
				},
			}),
		)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(cache.size()).toBe(1)
		expect(second.cached).toBe(false)
		expect(runs).toBe(2)
	})

	it('re-executes a provider whose payload is a falsy primitive', async () => {
		// NOTE: same truthiness bug — a legitimate `0` payload never reads back.
		const { router } = await loadRouter()
		const zero = createRecordingProvider('fred', 0, {
			capabilities: ['macro'],
			priority: { macro: 1 },
		})
		router.registerProvider(zero.provider)

		await router.route('macro', 'series', { seriesId: 'CPIAUCSL' })
		const second = await router.route('macro', 'series', { seriesId: 'CPIAUCSL' })

		expect(second).toEqual({ data: 0, source: 'fred', cached: false })
		expect(zero.calls).toHaveLength(2)
	})

	it('re-executes a provider whose payload is null', async () => {
		const { router } = await loadRouter()
		const nulled = createRecordingProvider('yahoo', null)
		router.registerProvider(nulled.provider)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		const second = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(second.cached).toBe(false)
		expect(nulled.calls).toHaveLength(2)
	})

	it('caches an empty array result and serves it back', async () => {
		const { router } = await loadRouter()
		const empty = createRecordingProvider('sec-edgar', [], {
			capabilities: ['filing'],
			priority: { filing: 1 },
		})
		router.registerProvider(empty.provider)

		await router.route('filing', 'list', { symbol: 'AAPL', form: '10-K' })
		const second = await router.route('filing', 'list', { symbol: 'AAPL', form: '10-K' })

		expect(second).toEqual({ data: [], source: 'sec-edgar', cached: true })
		expect(empty.calls).toHaveLength(1)
	})

	it('keeps cache entries separate per provider for the same request', async () => {
		const { router, cache } = await loadRouter()
		router.registerProvider(
			createRecordingProvider('yahoo', AAPL_YAHOO, { priority: { quote: 1 } }).provider,
		)
		router.registerProvider(
			createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } }).provider,
		)

		await router.route('quote', 'get', { symbol: 'AAPL' })
		await router.route('quote', 'get', { symbol: 'AAPL' }, { source: 'finnhub' })

		expect(cache.size()).toBe(2)
		expect(cache.get('yahoo', 'quote', { action: 'get', symbol: 'AAPL' })).toEqual(AAPL_YAHOO)
		expect(cache.get('finnhub', 'quote', { action: 'get', symbol: 'AAPL' })).toEqual(AAPL_FINNHUB)
	})

	it('starts with an empty cache in every fresh module generation', async () => {
		const first = await loadRouter()
		first.router.registerProvider(createRecordingProvider('yahoo', AAPL_YAHOO).provider)
		await first.router.route('quote', 'get', { symbol: 'AAPL' })
		expect(first.cache.size()).toBe(1)

		const second = await loadRouter()

		expect(second.cache.size()).toBe(0)
	})
})

describe('route — end-to-end routing scenarios', () => {
	it('walks a realistic three-provider quote chain', async () => {
		writeConfig({ disabledSources: ['alpha-vantage'] })
		const { router } = await loadRouter()
		const alphaVantage = createRecordingProvider('alpha-vantage', AAPL_FINNHUB, {
			priority: { quote: 0 },
		})
		router.registerProvider(alphaVantage.provider)
		router.registerProvider(
			createMockProvider({
				...createFailingProvider('yahoo', 'Yahoo Finance request failed: 429'),
				priority: { quote: 1 },
			}),
		)
		const finnhub = createRecordingProvider('finnhub', AAPL_FINNHUB, { priority: { quote: 2 } })
		router.registerProvider(finnhub.provider)
		router.registerProvider(
			createMockProvider({ name: 'fred', capabilities: ['macro'], priority: { macro: 1 } }),
		)

		const result = await router.route('quote', 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: AAPL_FINNHUB, source: 'finnhub', cached: false })
		expect(alphaVantage.calls).toHaveLength(0)
		expect(names(router.getProvidersForCategory('quote'))).toEqual(['yahoo', 'finnhub'])
	})

	it.each(ALL_CATEGORIES)('routes %s to the provider that declares it', async (category) => {
		const { router } = await loadRouter()
		const provider = createRecordingProvider(
			'omni',
			{ ok: category },
			{
				capabilities: [category],
				priority: { [category]: 1 } as Partial<Record<DataCategory, number>>,
			},
		)
		router.registerProvider(provider.provider)

		const result = await router.route(category, 'get', { symbol: 'AAPL' })

		expect(result).toEqual({ data: { ok: category }, source: 'omni', cached: false })
		expect(provider.calls).toEqual([{ category, action: 'get', args: { symbol: 'AAPL' } }])
	})
})
