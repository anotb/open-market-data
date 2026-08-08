import type { DataCategory, Provider } from '../providers/types.js'
import { type OmdConfig, loadConfig } from './config.js'

export type ProviderHealthStatus = 'ok' | 'not-configured' | 'disabled' | 'unavailable' | 'error'

export interface ProviderHealthResult {
	name: string
	status: ProviderHealthStatus
	checkedAt: string
	latencyMs: number
	enabled: boolean
	requiresKey: boolean
	keyEnvVar?: string
	capabilities: DataCategory[]
	probe?: string
	source?: string
	message?: string
	recommendedAction?: string
}

export interface ProviderHealthOptions {
	timeoutMs?: number
	config?: OmdConfig
	now?: () => Date
}

interface ProviderProbe {
	description: string
	category: DataCategory
	action: string
	args: Record<string, unknown>
	validate(data: unknown): boolean
}

const PROVIDER_PROBES: Readonly<Record<string, ProviderProbe>> = {
	'sec-edgar': {
		description: 'recent AAPL filing',
		category: 'filing',
		action: 'list',
		args: { symbol: 'AAPL', limit: 1 },
		validate: nonEmptyArray,
	},
	yahoo: {
		description: 'AAPL quote',
		category: 'quote',
		action: 'get',
		args: { symbol: 'AAPL' },
		validate: positivePrice,
	},
	binance: {
		description: 'BTC/USDT quote',
		category: 'crypto',
		action: 'quote',
		args: { symbol: 'BTC' },
		validate: positivePrice,
	},
	coingecko: {
		description: 'BTC quote',
		category: 'crypto',
		action: 'quote',
		args: { symbol: 'BTC' },
		validate: positivePrice,
	},
	fred: {
		description: 'latest US GDP observation',
		category: 'macro',
		action: 'get',
		args: { seriesId: 'GDP', limit: 1 },
		validate: macroSeriesWithData,
	},
	finnhub: {
		description: 'AAPL quote',
		category: 'quote',
		action: 'get',
		args: { symbol: 'AAPL' },
		validate: positivePrice,
	},
	alphavantage: {
		description: 'IBM quote',
		category: 'quote',
		action: 'get',
		args: { symbol: 'IBM' },
		validate: positivePrice,
	},
	worldbank: {
		description: 'latest US GDP observation',
		category: 'macro',
		action: 'get',
		args: { seriesId: 'NY.GDP.MKTP.CD', country: 'US', limit: 1 },
		validate: macroSeriesWithData,
	},
}

export async function checkProviderHealth(
	providers: readonly Provider[],
	options: ProviderHealthOptions = {},
): Promise<ProviderHealthResult[]> {
	const config = options.config ?? loadConfig()
	const disabled = new Set(config.disabledSources ?? [])
	const now = options.now ?? (() => new Date())
	const timeoutMs = normalizeTimeout(options.timeoutMs)

	const results = await Promise.all(
		providers.map((provider) => checkProvider(provider, disabled, timeoutMs, now)),
	)
	return results.sort((a, b) => a.name.localeCompare(b.name))
}

async function checkProvider(
	provider: Provider,
	disabled: ReadonlySet<string>,
	timeoutMs: number,
	now: () => Date,
): Promise<ProviderHealthResult> {
	const checkedAt = now().toISOString()
	const common = {
		name: provider.name,
		checkedAt,
		enabled: provider.isEnabled(),
		requiresKey: provider.requiresKey,
		...(provider.keyEnvVar ? { keyEnvVar: provider.keyEnvVar } : {}),
		capabilities: [...provider.capabilities],
	}

	if (disabled.has(provider.name)) {
		return {
			...common,
			status: 'disabled',
			latencyMs: 0,
			message: 'Disabled in open-market-data configuration.',
			recommendedAction: `Remove "${provider.name}" from disabledSources to enable this provider.`,
		}
	}

	if (!common.enabled) {
		return {
			...common,
			status: provider.requiresKey ? 'not-configured' : 'unavailable',
			latencyMs: 0,
			message: provider.requiresKey
				? `Provider is not configured${provider.keyEnvVar ? `; set ${provider.keyEnvVar}` : ''}.`
				: 'Provider is unavailable in this environment.',
			recommendedAction: provider.requiresKey
				? provider.keyEnvVar
					? `Set ${provider.keyEnvVar} or save the corresponding key with "omd config set".`
					: 'Configure the provider credential, then run the health check again.'
				: 'Check runtime support and provider availability, then try again.',
		}
	}

	const probe = PROVIDER_PROBES[provider.name]
	if (!probe) {
		return {
			...common,
			status: 'unavailable',
			latencyMs: 0,
			message: 'No built-in health probe is defined for this provider.',
			recommendedAction:
				'Use provider_status to inspect capabilities or add a bounded health probe.',
		}
	}

	const started = Date.now()
	try {
		const result = await withTimeout(
			provider.execute(probe.category, probe.action, { ...probe.args }),
			timeoutMs,
			provider.name,
		)
		const latencyMs = Date.now() - started
		if (!probe.validate(result.data)) {
			return {
				...common,
				status: 'error',
				latencyMs,
				probe: probe.description,
				source: result.source,
				message: 'The provider responded, but the probe returned no usable data.',
				recommendedAction:
					'Retry once; if the response remains invalid, report the provider and probe details.',
			}
		}
		return {
			...common,
			status: 'ok',
			latencyMs,
			probe: probe.description,
			source: result.source,
		}
	} catch (error) {
		const message = compactMessage(error)
		const status = classifyError(message)
		return {
			...common,
			status,
			latencyMs: Date.now() - started,
			probe: probe.description,
			message,
			recommendedAction: actionForFailure(status, provider, message),
		}
	}
}

function actionForFailure(
	status: ProviderHealthStatus,
	provider: Provider,
	message: string,
): string {
	if (status === 'not-configured') {
		return provider.keyEnvVar
			? `Set ${provider.keyEnvVar} or save the corresponding key with "omd config set".`
			: 'Configure the provider credential, then run the health check again.'
	}
	if (status === 'unavailable') {
		if (/451|geo-restricted/i.test(message)) {
			return 'Use an available fallback provider or retry from a supported region.'
		}
		if (/429|rate limit/i.test(message)) {
			return 'Wait for the provider quota to recover, configure a key when supported, or use a fallback.'
		}
		return 'Retry later and use an available fallback provider in the meantime.'
	}
	return 'Retry once; if the failure persists, report the provider and probe details.'
}

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined) return 15_000
	if (!Number.isFinite(value)) return 15_000
	return Math.max(1_000, Math.min(60_000, Math.trunc(value)))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`[${name}] Health probe timed out after ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

function classifyError(message: string): ProviderHealthStatus {
	if (/not configured|not set|missing api key|requires .*key/i.test(message)) {
		return 'not-configured'
	}
	if (
		/geo-restricted|http 451|rate limit|http 429|timed out|timeout|temporarily|fetch failed|network|econn|enotfound/i.test(
			message,
		)
	) {
		return 'unavailable'
	}
	return 'error'
}

function positivePrice(data: unknown): boolean {
	return (
		isRecord(data) &&
		typeof data.price === 'number' &&
		Number.isFinite(data.price) &&
		data.price > 0
	)
}

function nonEmptyArray(data: unknown): boolean {
	return Array.isArray(data) && data.length > 0
}

function macroSeriesWithData(data: unknown): boolean {
	return isRecord(data) && nonEmptyArray(data.data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error)
	const compact = raw.replace(/\s+/g, ' ').trim() || 'Unknown provider error'
	return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}

export function providerHealthProbeNames(): readonly string[] {
	return Object.keys(PROVIDER_PROBES)
}
