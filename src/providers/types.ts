export type DataCategory =
	| 'search'
	| 'quote'
	| 'financials'
	| 'filing'
	| 'insiders'
	| 'macro'
	| 'crypto'
	| 'history'
	| 'options'
	| 'earnings'
	| 'dividends'

export interface RateLimitConfig {
	maxRequests: number
	windowMs: number
}

export interface ProviderResult<T = unknown> {
	data: T
	source: string
	cached: boolean
}

export interface Provider {
	name: string
	requiresKey: boolean
	keyEnvVar?: string
	capabilities: DataCategory[]
	priority: Partial<Record<DataCategory, number>>
	rateLimits: RateLimitConfig
	isEnabled(): boolean
	execute<T = unknown>(
		category: DataCategory,
		action: string,
		args: Record<string, unknown>,
	): Promise<ProviderResult<T>>
}
