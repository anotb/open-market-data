import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
	canRequest,
	consumeToken,
	getRemaining,
	resetBucket,
} from '../src/core/rate-limiter.js'
import * as cache from '../src/core/cache.js'
import type { DataCategory, Provider, ProviderResult, RateLimitConfig } from '../src/providers/types.js'

// Helper to create a mock provider
function createMockProvider(overrides: Partial<Provider> & { name: string }): Provider {
	return {
		requiresKey: false,
		capabilities: ['quote'] as DataCategory[],
		priority: { quote: 1 },
		rateLimits: { maxRequests: 100, windowMs: 60_000 },
		isEnabled: () => true,
		execute: async <T>(_cat: DataCategory, _action: string, _args: Record<string, unknown>) =>
			({ data: { price: 42 } as unknown as T, source: overrides.name, cached: false }) as ProviderResult<T>,
		...overrides,
	}
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

describe('rate-limiter: exhaustion and recovery', () => {
	const config: RateLimitConfig = { maxRequests: 3, windowMs: 1000 }

	beforeEach(() => {
		resetBucket('exhaust-test')
		vi.restoreAllMocks()
	})

	it('canRequest returns false when all tokens are consumed', () => {
		for (let i = 0; i < 3; i++) consumeToken('exhaust-test', config)
		expect(canRequest('exhaust-test', config)).toBe(false)
		expect(getRemaining('exhaust-test', config)).toBe(0)
	})

	it('consumeToken returns false when tokens are exhausted', () => {
		for (let i = 0; i < 3; i++) {
			expect(consumeToken('exhaust-test', config)).toBe(true)
		}
		expect(consumeToken('exhaust-test', config)).toBe(false)
		expect(consumeToken('exhaust-test', config)).toBe(false)
	})

	it('tokens refill after the window elapses', () => {
		// Use fake timers so we can advance time precisely
		vi.useFakeTimers()

		for (let i = 0; i < 3; i++) consumeToken('exhaust-test', config)
		expect(canRequest('exhaust-test', config)).toBe(false)

		// Advance past the full window (1000ms)
		vi.advanceTimersByTime(1001)

		expect(canRequest('exhaust-test', config)).toBe(true)
		expect(getRemaining('exhaust-test', config)).toBeGreaterThanOrEqual(3)

		vi.useRealTimers()
	})

	it('tokens partially refill proportional to elapsed time', () => {
		vi.useFakeTimers()

		for (let i = 0; i < 3; i++) consumeToken('exhaust-test', config)
		expect(getRemaining('exhaust-test', config)).toBe(0)

		// Advance half the window — should refill ~1.5 tokens (floor = 1)
		vi.advanceTimersByTime(500)
		expect(getRemaining('exhaust-test', config)).toBe(1)

		vi.useRealTimers()
	})
})

// ─── Router ──────────────────────────────────────────────────────────────────

describe('router: fallback behavior', () => {
	// We re-import the router module fresh for each describe block so the
	// module-level providers array starts clean.
	let registerProvider: typeof import('../src/core/router.js').registerProvider
	let route: typeof import('../src/core/router.js').route
	let getProviders: typeof import('../src/core/router.js').getProviders

	beforeEach(async () => {
		vi.resetModules()
		cache.clear()
		const mod = await import('../src/core/router.js')
		registerProvider = mod.registerProvider
		route = mod.route
		getProviders = mod.getProviders
	})

	it('falls back to the next provider when the first throws', async () => {
		const failProvider = createMockProvider({
			name: 'fail-provider',
			priority: { quote: 1 },
			execute: async () => {
				throw new Error('API down')
			},
		})
		const okProvider = createMockProvider({
			name: 'ok-provider',
			priority: { quote: 2 },
			execute: async <T>() =>
				({ data: { price: 99 } as unknown as T, source: 'ok-provider', cached: false }) as ProviderResult<T>,
		})

		registerProvider(failProvider)
		registerProvider(okProvider)

		const result = await route('quote', 'price', { symbol: 'AAPL' })
		expect(result.source).toBe('ok-provider')
		expect(result.data).toEqual({ price: 99 })
	})

	it('throws when all providers fail', async () => {
		const p1 = createMockProvider({
			name: 'bad-1',
			execute: async () => { throw new Error('fail-1') },
		})
		const p2 = createMockProvider({
			name: 'bad-2',
			execute: async () => { throw new Error('fail-2') },
		})

		registerProvider(p1)
		registerProvider(p2)

		await expect(route('quote', 'price', { symbol: 'AAPL' })).rejects.toThrow(
			/All providers failed/,
		)
	})
})

describe('router: --source flag', () => {
	let registerProvider: typeof import('../src/core/router.js').registerProvider
	let route: typeof import('../src/core/router.js').route

	beforeEach(async () => {
		vi.resetModules()
		cache.clear()
		const mod = await import('../src/core/router.js')
		registerProvider = mod.registerProvider
		route = mod.route
	})

	it('uses only the specified source when --source is set', async () => {
		const alpha = createMockProvider({
			name: 'alpha',
			priority: { quote: 1 },
			execute: async <T>() =>
				({ data: { origin: 'alpha' } as unknown as T, source: 'alpha', cached: false }) as ProviderResult<T>,
		})
		const beta = createMockProvider({
			name: 'beta',
			priority: { quote: 2 },
			execute: async <T>() =>
				({ data: { origin: 'beta' } as unknown as T, source: 'beta', cached: false }) as ProviderResult<T>,
		})

		registerProvider(alpha)
		registerProvider(beta)

		const result = await route('quote', 'price', { symbol: 'X' }, { source: 'beta' })
		expect(result.source).toBe('beta')
		expect(result.data).toEqual({ origin: 'beta' })
	})

	it('throws when specified source is not available', async () => {
		const alpha = createMockProvider({
			name: 'alpha',
			capabilities: ['quote'],
		})
		registerProvider(alpha)

		await expect(
			route('quote', 'price', { symbol: 'X' }, { source: 'nonexistent' }),
		).rejects.toThrow(/Source "nonexistent" not available/)
	})
})

describe('router: no providers', () => {
	let route: typeof import('../src/core/router.js').route

	beforeEach(async () => {
		vi.resetModules()
		cache.clear()
		const mod = await import('../src/core/router.js')
		route = mod.route
	})

	it('throws when no providers are registered for a category', async () => {
		await expect(
			route('quote', 'price', { symbol: 'X' }),
		).rejects.toThrow(/No providers available/)
	})
})

describe('router: caching', () => {
	let registerProvider: typeof import('../src/core/router.js').registerProvider
	let route: typeof import('../src/core/router.js').route

	beforeEach(async () => {
		vi.resetModules()
		cache.clear()
		const mod = await import('../src/core/router.js')
		registerProvider = mod.registerProvider
		route = mod.route
	})

	it('returns cached result without calling provider execute a second time', async () => {
		const executeSpy = vi.fn(async <T>() =>
			({ data: { price: 200 } as unknown as T, source: 'spy-provider', cached: false }) as ProviderResult<T>,
		)
		const provider = createMockProvider({
			name: 'spy-provider',
			execute: executeSpy,
		})
		registerProvider(provider)

		const first = await route('quote', 'price', { symbol: 'AAPL' })
		expect(first.data).toEqual({ price: 200 })
		expect(first.cached).toBe(false)
		expect(executeSpy).toHaveBeenCalledTimes(1)

		const second = await route('quote', 'price', { symbol: 'AAPL' })
		expect(second.data).toEqual({ price: 200 })
		expect(second.cached).toBe(true)
		expect(second.source).toBe('spy-provider')
		// execute should NOT have been called again
		expect(executeSpy).toHaveBeenCalledTimes(1)
	})

	it('bypasses cache when noCache option is set', async () => {
		const executeSpy = vi.fn(async <T>() =>
			({ data: { price: 300 } as unknown as T, source: 'no-cache-provider', cached: false }) as ProviderResult<T>,
		)
		const provider = createMockProvider({
			name: 'no-cache-provider',
			execute: executeSpy,
		})
		registerProvider(provider)

		await route('quote', 'price', { symbol: 'AAPL' })
		await route('quote', 'price', { symbol: 'AAPL' }, { noCache: true })
		expect(executeSpy).toHaveBeenCalledTimes(2)
	})
})

// ─── Cache ───────────────────────────────────────────────────────────────────

describe('cache: TTL expiration', () => {
	beforeEach(() => {
		cache.clear()
		vi.restoreAllMocks()
	})

	it('returns undefined after TTL expires', () => {
		vi.useFakeTimers()

		cache.set('prov', 'quote', { symbol: 'AAPL' }, { price: 100 })
		expect(cache.get('prov', 'quote', { symbol: 'AAPL' })).toEqual({ price: 100 })

		// quote TTL is 30_000ms
		vi.advanceTimersByTime(30_001)
		expect(cache.get('prov', 'quote', { symbol: 'AAPL' })).toBeUndefined()

		vi.useRealTimers()
	})

	it('returns value before TTL expires', () => {
		vi.useFakeTimers()

		cache.set('prov', 'quote', { symbol: 'MSFT' }, { price: 50 })
		vi.advanceTimersByTime(29_000)
		expect(cache.get('prov', 'quote', { symbol: 'MSFT' })).toEqual({ price: 50 })

		vi.useRealTimers()
	})
})

describe('cache: eviction', () => {
	beforeEach(() => {
		cache.clear()
	})

	it('evicts oldest entries when exceeding MAX_ENTRIES (500)', () => {
		vi.useFakeTimers()

		// Fill cache to the limit
		for (let i = 0; i < 501; i++) {
			// Advance time by 1ms per entry so each has a different expiresAt
			vi.advanceTimersByTime(1)
			cache.set('prov', 'financials', { id: i }, { val: i })
		}

		// Size should be capped at MAX_ENTRIES
		expect(cache.size()).toBeLessThanOrEqual(500)

		// The oldest entry (id=0) should have been evicted
		expect(cache.get('prov', 'financials', { id: 0 })).toBeUndefined()
		// The newest entry should still be present
		expect(cache.get('prov', 'financials', { id: 500 })).toEqual({ val: 500 })

		vi.useRealTimers()
	})
})

// ─── Provider Registration ──────────────────────────────────────────────────

describe('router: duplicate provider registration', () => {
	let registerProvider: typeof import('../src/core/router.js').registerProvider
	let getProviders: typeof import('../src/core/router.js').getProviders

	beforeEach(async () => {
		vi.resetModules()
		cache.clear()
		const mod = await import('../src/core/router.js')
		registerProvider = mod.registerProvider
		getProviders = mod.getProviders
	})

	it('is idempotent — registering the same name twice does not duplicate', () => {
		const provider = createMockProvider({ name: 'dup-test' })
		registerProvider(provider)
		registerProvider(provider)

		const all = getProviders()
		const matches = all.filter((p) => p.name === 'dup-test')
		expect(matches).toHaveLength(1)
	})

	it('uses the first registered instance when duplicates are attempted', async () => {
		const first = createMockProvider({
			name: 'same-name',
			execute: async <T>() =>
				({ data: { version: 1 } as unknown as T, source: 'same-name', cached: false }) as ProviderResult<T>,
		})
		const second = createMockProvider({
			name: 'same-name',
			execute: async <T>() =>
				({ data: { version: 2 } as unknown as T, source: 'same-name', cached: false }) as ProviderResult<T>,
		})

		registerProvider(first)
		registerProvider(second)

		const mod = await import('../src/core/router.js')
		const result = await mod.route('quote', 'price', { symbol: 'X' })
		expect(result.data).toEqual({ version: 1 })
	})
})
