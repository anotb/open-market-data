import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OmdConfig {
	fredApiKey?: string
	coingeckoApiKey?: string
	edgarUserAgent?: string
	defaultFormat?: 'markdown' | 'json' | 'plain'
	disabledSources?: string[]
}

const CONFIG_DIR = join(homedir(), '.omd')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

let cached: OmdConfig | null = null

export function loadConfig(): OmdConfig {
	if (cached) return cached

	// Env vars take priority
	const fromEnv: OmdConfig = {
		fredApiKey: process.env.FRED_API_KEY,
		coingeckoApiKey: process.env.COINGECKO_API_KEY,
		edgarUserAgent: process.env.EDGAR_USER_AGENT,
	}

	// Merge with file config
	let fromFile: OmdConfig = {}
	if (existsSync(CONFIG_FILE)) {
		try {
			fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
		} catch {
			// Ignore malformed config
		}
	}

	cached = {
		...fromFile,
		// Env vars override file
		...(fromEnv.fredApiKey && { fredApiKey: fromEnv.fredApiKey }),
		...(fromEnv.coingeckoApiKey && { coingeckoApiKey: fromEnv.coingeckoApiKey }),
		...(fromEnv.edgarUserAgent && { edgarUserAgent: fromEnv.edgarUserAgent }),
	}

	return cached
}

export function saveConfig(config: Partial<OmdConfig>): void {
	const existing = loadConfig()
	const merged = { ...existing, ...config }

	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true })
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2))
	cached = merged
}

export function resetConfigCache(): void {
	cached = null
}

export function getConfigPath(): string {
	return CONFIG_FILE
}
