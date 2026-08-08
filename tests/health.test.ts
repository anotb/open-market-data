import { describe, expect, it, vi } from 'vitest'
import { checkProviderHealth } from '../src/core/health.js'
import type { Provider, ProviderResult } from '../src/providers/types.js'

function provider(name: string, overrides: Partial<Provider> = {}): Provider {
	return {
		name,
		requiresKey: false,
		capabilities: ['quote'],
		priority: { quote: 1 },
		rateLimits: { maxRequests: 100, windowMs: 60_000 },
		isEnabled: () => true,
		execute: async <T>() =>
			({ data: { price: 100 } as T, source: name, cached: false }) as ProviderResult<T>,
		...overrides,
	}
}

describe('provider health checks', () => {
	it('probes healthy providers and returns deterministic sorted results', async () => {
		const results = await checkProviderHealth([provider('yahoo'), provider('binance')], {
			config: {},
			now: () => new Date('2026-08-07T12:00:00.000Z'),
		})

		expect(results.map((result) => result.name)).toEqual(['binance', 'yahoo'])
		expect(results.every((result) => result.status === 'ok')).toBe(true)
		expect(results[0]).toMatchObject({
			checkedAt: '2026-08-07T12:00:00.000Z',
			probe: 'BTC/USDT quote',
		})
	})

	it('reports missing optional credentials without attempting a request', async () => {
		const execute = vi.fn()
		const results = await checkProviderHealth(
			[
				provider('fred', {
					requiresKey: true,
					keyEnvVar: 'FRED_API_KEY',
					isEnabled: () => false,
					execute,
				}),
			],
			{ config: {} },
		)

		expect(results[0]).toMatchObject({
			status: 'not-configured',
			keyEnvVar: 'FRED_API_KEY',
			recommendedAction: expect.stringContaining('FRED_API_KEY'),
		})
		expect(execute).not.toHaveBeenCalled()
	})

	it('honors disabledSources before probing', async () => {
		const execute = vi.fn()
		const results = await checkProviderHealth([provider('yahoo', { execute })], {
			config: { disabledSources: ['yahoo'] },
		})

		expect(results[0]).toMatchObject({
			status: 'disabled',
			recommendedAction: expect.stringContaining('disabledSources'),
		})
		expect(execute).not.toHaveBeenCalled()
	})

	it('distinguishes regional or transient unavailability from invalid data', async () => {
		const unavailable = provider('binance', {
			execute: async () => {
				throw new Error('Binance is geo-restricted in your region (HTTP 451)')
			},
		})
		const malformed = provider('yahoo', {
			execute: async <T>() =>
				({ data: { price: 0 } as T, source: 'yahoo', cached: false }) as ProviderResult<T>,
		})

		const results = await checkProviderHealth([malformed, unavailable], { config: {} })
		expect(results.find((result) => result.name === 'binance')).toMatchObject({
			status: 'unavailable',
			recommendedAction: expect.stringContaining('fallback'),
		})
		expect(results.find((result) => result.name === 'yahoo')).toMatchObject({
			status: 'error',
			recommendedAction: expect.stringContaining('Retry'),
		})
	})
})
