import type { DataCategory, Provider, ProviderResult } from '../providers/types.js'
import * as cache from './cache.js'
import { loadConfig } from './config.js'
import { canRequest } from './rate-limiter.js'

const providers: Provider[] = []

export function registerProvider(provider: Provider): void {
	// Prevent duplicate registration
	if (providers.some((p) => p.name === provider.name)) return
	providers.push(provider)
}

export function getProviders(): Provider[] {
	return [...providers]
}

export function getProvidersForCategory(category: DataCategory): Provider[] {
	const config = loadConfig()
	const disabled = new Set(config.disabledSources ?? [])

	return providers
		.filter((p) => p.capabilities.includes(category))
		.filter((p) => p.isEnabled())
		.filter((p) => !disabled.has(p.name))
		.sort((a, b) => {
			const pa = a.priority[category] ?? 99
			const pb = b.priority[category] ?? 99
			if (pa !== pb) return pa - pb
			// Prefer providers with rate limit headroom
			const aOk = canRequest(a.name, a.rateLimits) ? 0 : 1
			const bOk = canRequest(b.name, b.rateLimits) ? 0 : 1
			return aOk - bOk
		})
}

export interface RouteOptions {
	source?: string
	noCache?: boolean
}

export async function route<T = unknown>(
	category: DataCategory,
	action: string,
	args: Record<string, unknown>,
	options: RouteOptions = {},
): Promise<ProviderResult<T>> {
	// Check cache first
	if (!options.noCache) {
		const cacheKey = { action, ...args }
		// Try provider-specific cache if source forced
		if (options.source) {
			const cached_data = cache.get<T>(options.source, category, cacheKey)
			if (cached_data) return { data: cached_data, source: options.source, cached: true }
		} else {
			// Try any provider's cache
			for (const p of providers) {
				const cached_data = cache.get<T>(p.name, category, cacheKey)
				if (cached_data) return { data: cached_data, source: p.name, cached: true }
			}
		}
	}

	let candidates = getProvidersForCategory(category)

	if (options.source) {
		candidates = candidates.filter((p) => p.name === options.source)
		if (candidates.length === 0) {
			throw new Error(`Source "${options.source}" not available for category "${category}"`)
		}
	}

	if (candidates.length === 0) {
		throw new Error(`No providers available for category "${category}"`)
	}

	const errors: Error[] = []
	for (const provider of candidates) {
		try {
			const result = await provider.execute<T>(category, action, args)
			// Cache the result
			if (!options.noCache) {
				cache.set(provider.name, category, { action, ...args }, result.data)
			}
			return result
		} catch (err) {
			errors.push(err instanceof Error ? err : new Error(String(err)))
			// Continue to next provider (fallback)
		}
	}

	const sources = candidates.map((p) => p.name).join(', ')
	const lastError = errors[errors.length - 1]
	throw new Error(
		`All providers failed for ${category}/${action} (tried: ${sources}): ${lastError?.message}`,
	)
}
