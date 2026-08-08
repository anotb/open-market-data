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
	// Resolve availability before consulting the cache so disabled or
	// unconfigured providers can never leak stale values back into a request.
	let candidates = getProvidersForCategory(category)

	if (options.source) {
		const requested = providers.find(
			(provider) => provider.name === options.source && provider.capabilities.includes(category),
		)
		if (!requested) {
			throw new Error(`Source "${options.source}" not available for category "${category}"`)
		}
		const config = loadConfig()
		if (new Set(config.disabledSources ?? []).has(requested.name)) {
			throw new Error(`Source "${requested.name}" is disabled in configuration`)
		}
		if (!requested.isEnabled()) {
			if (requested.keyEnvVar) {
				throw new Error(
					`Source "${requested.name}" is not configured; set ${requested.keyEnvVar} or run "omd config set" with the provider key`,
				)
			}
			throw new Error(`Source "${requested.name}" is unavailable in this environment`)
		}
		candidates = candidates.filter((p) => p.name === options.source)
	}

	// Check only caches belonging to providers that are currently eligible.
	if (!options.noCache) {
		const cacheKey = { action, ...args }
		for (const provider of candidates) {
			const cachedData = cache.get<T>(provider.name, category, cacheKey)
			if (cachedData !== undefined) {
				return { data: cachedData, source: provider.name, cached: true }
			}
		}
	}

	if (candidates.length === 0) {
		// Build helpful error with reasons why providers are unavailable
		const capable = providers.filter((p) => p.capabilities.includes(category))
		const config = loadConfig()
		const disabledSet = new Set(config.disabledSources ?? [])
		if (capable.length > 0) {
			const reasons = capable.map((p) => {
				if (!p.isEnabled()) {
					if (p.keyEnvVar) {
						const configKeyMap: Record<string, string> = {
							COINGECKO_API_KEY: 'coingeckoApiKey',
							FRED_API_KEY: 'fredApiKey',
							FINNHUB_API_KEY: 'finnhubApiKey',
							ALPHA_VANTAGE_API_KEY: 'alphaVantageApiKey',
						}
						const configKey = configKeyMap[p.keyEnvVar] ?? p.keyEnvVar
						return `${p.name}: requires ${p.keyEnvVar} (run: omd config set ${configKey} <key>)`
					}
					return `${p.name}: disabled`
				}
				if (disabledSet.has(p.name)) return `${p.name}: disabled in config`
				return `${p.name}: unknown`
			})
			throw new Error(
				`No providers available for "${category}". Providers exist but are not enabled:\n  ${reasons.join('\n  ')}`,
			)
		}
		throw new Error(`No providers available for category "${category}"`)
	}

	const errors: Error[] = []
	for (const provider of candidates) {
		try {
			const result = await provider.execute<T>(category, action, args)
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
		`All providers failed for ${category}/${action} (tried: ${sources}): ${boundedErrorMessage(lastError)}`,
	)
}

function boundedErrorMessage(error: Error | undefined): string {
	const compact = (error?.message ?? 'Unknown provider error').replace(/\s+/g, ' ').trim()
	return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}
