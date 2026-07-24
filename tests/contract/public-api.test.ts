import { describe, expect, it } from 'vitest'
import * as publicApi from '../../src/index.js'

/**
 * src/index.ts is the published library surface — `open-market-data` ships it as
 * the package `exports` entry, so anything reachable from here is a compatibility
 * promise to downstream consumers.
 *
 * These tests pin the surface deliberately: adding an export should require
 * updating this file, and removing one should fail loudly rather than quietly
 * breaking an embedder. Type-only exports are erased at runtime and so cannot be
 * asserted here; they are covered by `tsc` via tsconfig.test.json.
 */

const EXPECTED_FUNCTIONS = [
	'route',
	'registerProvider',
	'getProviders',
	'getProvidersForCategory',
	'loadConfig',
	'saveConfig',
	'getConfigPath',
] as const

const EXPECTED_NAMESPACES = ['cache', 'rateLimiter', 'formatter'] as const

describe('public API surface', () => {
	it('exports exactly the documented runtime members and nothing more', () => {
		expect(Object.keys(publicApi).sort()).toEqual(
			[...EXPECTED_FUNCTIONS, ...EXPECTED_NAMESPACES].sort(),
		)
	})

	it.each(EXPECTED_FUNCTIONS)('exports %s as a callable function', (name) => {
		expect(typeof publicApi[name]).toBe('function')
	})

	it.each(EXPECTED_NAMESPACES)('exports %s as a namespace object', (name) => {
		expect(publicApi[name]).toBeTypeOf('object')
		expect(publicApi[name]).not.toBeNull()
	})
})

describe('re-exported namespaces expose their full modules', () => {
	it('cache exposes get, set, clear, and size', () => {
		expect(Object.keys(publicApi.cache).sort()).toEqual(['clear', 'get', 'set', 'size'])
	})

	it('rateLimiter exposes the bucket operations', () => {
		expect(Object.keys(publicApi.rateLimiter).sort()).toEqual([
			'canRequest',
			'consumeToken',
			'getRemaining',
			'resetBucket',
		])
	})

	it('formatter exposes every formatting helper', () => {
		expect(Object.keys(publicApi.formatter).sort()).toEqual([
			'formatCurrency',
			'formatKeyValue',
			'formatNumber',
			'formatPercent',
			'formatTable',
		])
	})
})

describe('re-exports are the same bindings as their source modules', () => {
	it('router functions are identical to the router module exports', async () => {
		const router = await import('../../src/core/router.js')
		expect(publicApi.route).toBe(router.route)
		expect(publicApi.registerProvider).toBe(router.registerProvider)
		expect(publicApi.getProviders).toBe(router.getProviders)
		expect(publicApi.getProvidersForCategory).toBe(router.getProvidersForCategory)
	})

	it('config functions are identical to the config module exports', async () => {
		const config = await import('../../src/core/config.js')
		expect(publicApi.loadConfig).toBe(config.loadConfig)
		expect(publicApi.saveConfig).toBe(config.saveConfig)
		expect(publicApi.getConfigPath).toBe(config.getConfigPath)
	})

	it('does not re-export resetConfigCache, which is test-only plumbing', () => {
		expect(publicApi).not.toHaveProperty('resetConfigCache')
	})

	// NOTE: the library surface exposes both `registerProvider` and `rateLimiter`,
	// so an embedder can register a provider carrying an arbitrary RateLimitConfig.
	// That is the only route by which a windowMs of 0 can reach the limiter — see
	// tests/unit/rate-limiter.test.ts for the NaN behaviour it produces.
	it('exposes the provider-registration and rate-limiter surface together', () => {
		expect(typeof publicApi.registerProvider).toBe('function')
		expect(typeof publicApi.rateLimiter.consumeToken).toBe('function')
	})
})
