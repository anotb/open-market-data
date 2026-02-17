import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Load .env file if present (minimal dotenv — no dependency needed)
function loadEnvFile(): void {
	const envPath = resolve(process.cwd(), '.env')
	if (!existsSync(envPath)) return
	try {
		const content = readFileSync(envPath, 'utf-8')
		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const eqIdx = trimmed.indexOf('=')
			if (eqIdx === -1) continue
			const key = trimmed.slice(0, eqIdx).trim()
			let val = trimmed.slice(eqIdx + 1).trim()
			// Strip surrounding quotes (single or double)
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1)
			}
			// Don't override existing env vars
			if (process.env[key] === undefined) {
				process.env[key] = val
			}
		}
	} catch {
		// Ignore read errors
	}
}

loadEnvFile()

export interface OmdConfig {
	fredApiKey?: string
	coingeckoApiKey?: string
	finnhubApiKey?: string
	alphaVantageApiKey?: string
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
		finnhubApiKey: process.env.FINNHUB_API_KEY,
		alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
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
		...(fromEnv.finnhubApiKey && { finnhubApiKey: fromEnv.finnhubApiKey }),
		...(fromEnv.alphaVantageApiKey && { alphaVantageApiKey: fromEnv.alphaVantageApiKey }),
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
	writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 })
	cached = merged
}

export function resetConfigCache(): void {
	cached = null
}

export function getConfigPath(): string {
	return CONFIG_FILE
}
