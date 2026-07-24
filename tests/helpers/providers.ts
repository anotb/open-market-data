/**
 * Factories for building stand-in providers, so router/registry tests can
 * exercise routing behaviour without touching a real data source.
 */
import type {
	DataCategory,
	Provider,
	ProviderResult,
	RateLimitConfig,
} from '../../src/providers/types.js'

const DEFAULT_RATE_LIMITS: RateLimitConfig = { maxRequests: 100, windowMs: 60_000 }

/**
 * Builds a Provider whose `execute` resolves to a fixed payload. Override any
 * field — including `execute` — through `overrides`.
 */
export function createMockProvider(overrides: Partial<Provider> & { name: string }): Provider {
	const name = overrides.name
	return {
		requiresKey: false,
		capabilities: ['quote'] as DataCategory[],
		priority: { quote: 1 },
		rateLimits: DEFAULT_RATE_LIMITS,
		isEnabled: () => true,
		execute: async <T>() =>
			({ data: { price: 42 } as unknown as T, source: name, cached: false }) as ProviderResult<T>,
		...overrides,
	}
}

/** A provider whose `execute` always rejects with `message`. */
export function createFailingProvider(name: string, message = 'provider failed'): Provider {
	return createMockProvider({
		name,
		execute: async () => {
			throw new Error(message)
		},
	})
}

/**
 * A provider that records every `execute` call, so tests can assert on
 * fallback order, argument pass-through, and cache hit/miss behaviour.
 */
export interface RecordingProvider {
	provider: Provider
	calls: Array<{ category: DataCategory; action: string; args: Record<string, unknown> }>
}

export function createRecordingProvider(
	name: string,
	data: unknown = { price: 42 },
	overrides: Partial<Provider> = {},
): RecordingProvider {
	const calls: RecordingProvider['calls'] = []
	const provider = createMockProvider({
		name,
		...overrides,
		execute: async <T>(category: DataCategory, action: string, args: Record<string, unknown>) => {
			calls.push({ category, action, args })
			return { data: data as T, source: name, cached: false } as ProviderResult<T>
		},
	})
	return { provider, calls }
}

/** Every category the CLI knows about — handy for exhaustiveness checks. */
export const ALL_CATEGORIES: DataCategory[] = [
	'search',
	'quote',
	'financials',
	'filing',
	'insiders',
	'macro',
	'crypto',
	'history',
	'options',
	'earnings',
	'dividends',
]
