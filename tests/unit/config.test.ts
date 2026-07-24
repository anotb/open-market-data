import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OmdConfig } from '../../src/core/config.js'
import { type TempHome, clearConfigEnv, freshImport, makeTempHome } from '../helpers/modules.js'

/**
 * src/core/config.ts resolves `~/.omd/config.json` at MODULE LOAD and runs its
 * built-in `.env` loader as an import side effect, then memoizes the resolved
 * config. So every test here:
 *   1. points $HOME at a throwaway dir (makeTempHome) and cwd at an empty dir,
 *   2. wipes the provider key env vars (clearConfigEnv),
 *   3. re-imports the module through freshImport so it re-resolves both.
 * Nothing in this file touches the real home directory, the repo working
 * directory, the network, or the wall clock.
 */

type ConfigModule = typeof import('../../src/core/config.js')

const CONFIG_MODULE = '../../src/core/config.js'

/** env var -> config key, plus a distinct env value and file value per key. */
const KEYS: [envVar: string, configKey: keyof OmdConfig, envValue: string, fileValue: string][] = [
	[
		'FRED_API_KEY',
		'fredApiKey',
		'env0f1e2d3c4b5a69788796a5b4c3d2e1f0',
		'file2d3c4b5a69788796a5b4c3d2e1f00f',
	],
	['COINGECKO_API_KEY', 'coingeckoApiKey', 'CG-envDemo1234567890abcd', 'CG-fileDemo1234567890abc'],
	['FINNHUB_API_KEY', 'finnhubApiKey', 'cenv7b9r01qhq0c1k2m0', 'cfile7b9r01qhq0c1k2mg'],
	['ALPHA_VANTAGE_API_KEY', 'alphaVantageApiKey', 'ENVDEMOKEY123456', 'FILEDEMOKEY12345'],
	[
		'EDGAR_USER_AGENT',
		'edgarUserAgent',
		'Env Research env@example.com',
		'File Corp file@example.com',
	],
]

/** A realistic on-disk config, shaped like one `omd config set` would leave. */
const FILE_CONFIG = {
	fredApiKey: 'file2d3c4b5a69788796a5b4c3d2e1f00f',
	coingeckoApiKey: 'CG-fileDemo1234567890abc',
	finnhubApiKey: 'cfile7b9r01qhq0c1k2mg',
	alphaVantageApiKey: 'FILEDEMOKEY12345',
	edgarUserAgent: 'File Corp file@example.com',
	defaultFormat: 'json',
	disabledSources: ['binance', 'coingecko'],
}

let home: TempHome
let cwdDir: string
let restoreConfigEnv: () => void
let envBefore: Record<string, string | undefined>
const originalCwd = process.cwd()

beforeEach(() => {
	envBefore = { ...process.env }
	restoreConfigEnv = clearConfigEnv()
	home = makeTempHome()
	cwdDir = mkdtempSync(join(tmpdir(), 'omd-test-cwd-'))
	process.chdir(cwdDir)
})

afterEach(() => {
	process.chdir(originalCwd)
	rmSync(cwdDir, { recursive: true, force: true })
	home.cleanup()
	restoreConfigEnv()
	// The .env tests inject arbitrary names into process.env; sweep anything new.
	for (const key of Object.keys(process.env)) {
		if (!(key in envBefore)) delete process.env[key]
	}
})

/** Fresh module generation that sees the current $HOME and cwd. */
function importConfig(): Promise<ConfigModule> {
	return freshImport<ConfigModule>(CONFIG_MODULE)
}

function writeConfigRaw(raw: string, mode = 0o600): void {
	mkdirSync(join(home.dir, '.omd'), { recursive: true })
	writeFileSync(home.configFile, raw, { mode })
}

function writeConfigJson(value: unknown): void {
	writeConfigRaw(JSON.stringify(value, null, 2))
}

function readSavedConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(home.configFile, 'utf-8'))
}

function permissionsOf(path: string): string {
	return (statSync(path).mode & 0o777).toString(8)
}

function writeEnvFile(contents: string): void {
	writeFileSync(join(cwdDir, '.env'), contents)
}

describe('getConfigPath', () => {
	it('points at .omd/config.json inside the home directory', async () => {
		const config = await importConfig()

		expect(config.getConfigPath()).toBe(join(home.dir, '.omd', 'config.json'))
		expect(config.getConfigPath()).toBe(home.configFile)
	})

	it('is the exact file loadConfig reads and saveConfig writes', async () => {
		const config = await importConfig()

		// The read half: a value planted at getConfigPath() comes back out of loadConfig().
		mkdirSync(join(home.dir, '.omd'), { recursive: true })
		writeFileSync(config.getConfigPath(), JSON.stringify({ fredApiKey: 'planted-key' }))
		expect(config.loadConfig().fredApiKey).toBe('planted-key')

		// The write half: saveConfig lands on that same path.
		config.saveConfig({ fredApiKey: 'roundtrip-key' })

		expect(existsSync(config.getConfigPath())).toBe(true)
		expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf-8')).fredApiKey).toBe(
			'roundtrip-key',
		)
	})

	it('does not depend on the current working directory', async () => {
		const fromTempCwd = await importConfig()

		const nested = join(cwdDir, 'nested')
		mkdirSync(nested)
		process.chdir(nested)
		// A second generation resolves the path from scratch under a different cwd.
		// Anchoring CONFIG_DIR on process.cwd() instead of homedir() would move it.
		const fromNestedCwd = await importConfig()

		expect(fromNestedCwd.getConfigPath()).toBe(fromTempCwd.getConfigPath())
		expect(fromNestedCwd.getConfigPath()).toBe(join(home.dir, '.omd', 'config.json'))
	})

	it('follows $HOME as it was at import time, not as it is later', async () => {
		const config = await importConfig()
		const atImport = config.getConfigPath()

		process.env.HOME = join(cwdDir, 'somewhere-else')

		expect(config.getConfigPath()).toBe(atImport)
	})

	it('resolves a different path for a home set before import', async () => {
		const other = mkdtempSync(join(tmpdir(), 'omd-other-home-'))
		process.env.HOME = other

		const config = await importConfig()

		expect(config.getConfigPath()).toBe(join(other, '.omd', 'config.json'))
		rmSync(other, { recursive: true, force: true })
	})
})

describe('loadConfig — environment variables', () => {
	it('returns a config with no keys at all when nothing is set', async () => {
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
		expect(Object.keys(config.loadConfig())).toEqual([])
	})

	it.each(KEYS)('reads %s into %s', async (envVar, configKey, envValue) => {
		process.env[envVar] = envValue
		const config = await importConfig()

		expect(config.loadConfig()[configKey]).toBe(envValue)
	})

	it.each(KEYS)('lets %s override the file value of %s', async (envVar, configKey, envValue) => {
		writeConfigJson(FILE_CONFIG)
		process.env[envVar] = envValue
		const config = await importConfig()

		expect(config.loadConfig()[configKey]).toBe(envValue)
	})

	it.each(KEYS)(
		'falls back to the file value when %s is unset',
		async (_envVar, configKey, _envValue, fileValue) => {
			writeConfigJson(FILE_CONFIG)
			const config = await importConfig()

			expect(config.loadConfig()[configKey]).toBe(fileValue)
		},
	)

	it.each(KEYS)(
		'ignores an empty %s so the file value survives',
		async (envVar, configKey, _envValue, fileValue) => {
			// NOTE: suspected bug — the truthiness guard means `FRED_API_KEY=` cannot
			// be used to blank out a key that is present in the config file.
			writeConfigJson(FILE_CONFIG)
			process.env[envVar] = ''
			const config = await importConfig()

			expect(config.loadConfig()[configKey]).toBe(fileValue)
		},
	)

	it.each(KEYS)('drops the key entirely when %s is empty and no file exists', async (envVar) => {
		process.env[envVar] = ''
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})

	it('accepts a whitespace-only env var as a real key', async () => {
		// NOTE: suspected bug — values are never trimmed, so a stray space in the
		// shell export silently becomes the API key sent upstream.
		writeConfigJson(FILE_CONFIG)
		process.env.FRED_API_KEY = '   '
		const config = await importConfig()

		expect(config.loadConfig().fredApiKey).toBe('   ')
	})

	it('overrides only the keys whose env var is set', async () => {
		writeConfigJson(FILE_CONFIG)
		process.env.FINNHUB_API_KEY = 'cenv7b9r01qhq0c1k2m0'
		const config = await importConfig()

		const loaded = config.loadConfig()
		expect(loaded.finnhubApiKey).toBe('cenv7b9r01qhq0c1k2m0')
		expect(loaded.fredApiKey).toBe(FILE_CONFIG.fredApiKey)
		expect(loaded.coingeckoApiKey).toBe(FILE_CONFIG.coingeckoApiKey)
		expect(loaded.alphaVantageApiKey).toBe(FILE_CONFIG.alphaVantageApiKey)
		expect(loaded.edgarUserAgent).toBe(FILE_CONFIG.edgarUserAgent)
	})

	it('resolves every key from the environment at once', async () => {
		for (const [envVar, , envValue] of KEYS) process.env[envVar] = envValue
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({
			fredApiKey: 'env0f1e2d3c4b5a69788796a5b4c3d2e1f0',
			coingeckoApiKey: 'CG-envDemo1234567890abcd',
			finnhubApiKey: 'cenv7b9r01qhq0c1k2m0',
			alphaVantageApiKey: 'ENVDEMOKEY123456',
			edgarUserAgent: 'Env Research env@example.com',
		})
	})

	it('ignores env vars that are not part of the config contract', async () => {
		process.env.OMD_API_KEY = 'not-a-real-setting'
		process.env.FRED_API = 'close-but-wrong'
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})
})

describe('loadConfig — config file', () => {
	it('returns the env-only config when the file does not exist', async () => {
		process.env.FRED_API_KEY = 'env-only-key'
		const config = await importConfig()

		expect(existsSync(home.configFile)).toBe(false)
		expect(config.loadConfig()).toEqual({ fredApiKey: 'env-only-key' })
	})

	it('returns the env-only config when the .omd directory does not exist', async () => {
		const config = await importConfig()

		expect(existsSync(join(home.dir, '.omd'))).toBe(false)
		expect(config.loadConfig()).toEqual({})
	})

	it('keeps non-key fields from the file', async () => {
		writeConfigJson(FILE_CONFIG)
		process.env.FRED_API_KEY = 'env0f1e2d3c4b5a69788796a5b4c3d2e1f0'
		const config = await importConfig()

		const loaded = config.loadConfig()
		expect(loaded.defaultFormat).toBe('json')
		expect(loaded.disabledSources).toEqual(['binance', 'coingecko'])
	})

	it('keeps unknown forward-compatible fields from the file', async () => {
		writeConfigJson({ defaultFormat: 'plain', futureSetting: { retries: 3 } })
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({
			defaultFormat: 'plain',
			futureSetting: { retries: 3 },
		})
	})

	it('does not validate defaultFormat coming from the file', async () => {
		// NOTE: suspected bug — the file is trusted as-is, so a typo'd format
		// escapes the OmdConfig union and reaches the formatter unchecked.
		writeConfigJson({ defaultFormat: 'xml' })
		const config = await importConfig()

		expect(config.loadConfig().defaultFormat).toBe('xml')
	})

	it('swallows malformed JSON instead of throwing', async () => {
		writeConfigRaw('{ "fredApiKey": "abc", }')
		const config = await importConfig()

		expect(() => config.loadConfig()).not.toThrow()
		expect(config.loadConfig()).toEqual({})
	})

	it('still applies env vars when the file is malformed', async () => {
		writeConfigRaw('this is not json at all')
		process.env.FRED_API_KEY = 'env-survives'
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({ fredApiKey: 'env-survives' })
	})

	it('treats an empty file as no config', async () => {
		writeConfigRaw('')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})

	it('treats a truncated file as no config', async () => {
		writeConfigRaw('{"fredApiKey": "abc"')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})

	it('treats a file containing JSON null as no config', async () => {
		writeConfigRaw('null')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})

	it('treats a file containing a bare number as no config', async () => {
		writeConfigRaw('42')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({})
	})

	it('spreads a JSON array file into numeric keys', async () => {
		// NOTE: suspected bug — no shape validation, so a hand-edited file holding
		// an array silently becomes a config object of index keys.
		writeConfigRaw('["binance", "coingecko"]')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({ 0: 'binance', 1: 'coingecko' })
	})

	it('swallows a read error when the config path is a directory', async () => {
		mkdirSync(home.configFile, { recursive: true })
		process.env.FRED_API_KEY = 'env-despite-eisdir'
		const config = await importConfig()

		expect(() => config.loadConfig()).not.toThrow()
		expect(config.loadConfig()).toEqual({ fredApiKey: 'env-despite-eisdir' })
	})

	it('reads a file with no api keys at all', async () => {
		writeConfigJson({ defaultFormat: 'markdown', disabledSources: [] })
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({ defaultFormat: 'markdown', disabledSources: [] })
	})

	it('keeps a file key whose value is an empty string', async () => {
		writeConfigJson({ fredApiKey: '', defaultFormat: 'json' })
		const config = await importConfig()

		expect(config.loadConfig().fredApiKey).toBe('')
	})
})

describe('loadConfig — caching', () => {
	it('returns the very same object on repeated calls', async () => {
		writeConfigJson(FILE_CONFIG)
		const config = await importConfig()

		expect(config.loadConfig()).toBe(config.loadConfig())
	})

	it('ignores file edits made after the first read', async () => {
		writeConfigJson({ fredApiKey: 'first-value' })
		const config = await importConfig()
		expect(config.loadConfig().fredApiKey).toBe('first-value')

		writeConfigJson({ fredApiKey: 'second-value' })

		expect(config.loadConfig().fredApiKey).toBe('first-value')
	})

	it('ignores env var changes made after the first read', async () => {
		process.env.FRED_API_KEY = 'first-env'
		const config = await importConfig()
		expect(config.loadConfig().fredApiKey).toBe('first-env')

		process.env.FRED_API_KEY = 'second-env'

		expect(config.loadConfig().fredApiKey).toBe('first-env')
	})

	it('re-reads the file after resetConfigCache', async () => {
		writeConfigJson({ fredApiKey: 'first-value' })
		const config = await importConfig()
		config.loadConfig()

		writeConfigJson({ fredApiKey: 'second-value' })
		config.resetConfigCache()

		expect(config.loadConfig().fredApiKey).toBe('second-value')
	})

	it('re-reads the environment after resetConfigCache', async () => {
		const config = await importConfig()
		expect(config.loadConfig()).toEqual({})

		process.env.EDGAR_USER_AGENT = 'Late Bind late@example.com'
		config.resetConfigCache()

		expect(config.loadConfig().edgarUserAgent).toBe('Late Bind late@example.com')
	})

	it('picks up a config file created after the first read', async () => {
		const config = await importConfig()
		expect(config.loadConfig()).toEqual({})

		writeConfigJson({ defaultFormat: 'plain' })
		config.resetConfigCache()

		expect(config.loadConfig()).toEqual({ defaultFormat: 'plain' })
	})

	it('forgets a config file deleted after the first read', async () => {
		writeConfigJson({ defaultFormat: 'plain' })
		const config = await importConfig()
		expect(config.loadConfig().defaultFormat).toBe('plain')

		rmSync(home.configFile)
		config.resetConfigCache()

		expect(config.loadConfig()).toEqual({})
	})

	it('hands out a fresh object after resetConfigCache', async () => {
		writeConfigJson(FILE_CONFIG)
		const config = await importConfig()
		const first = config.loadConfig()

		config.resetConfigCache()

		expect(config.loadConfig()).not.toBe(first)
		expect(config.loadConfig()).toEqual(first)
	})

	it('is safe to reset before anything has been loaded, and twice in a row', async () => {
		writeConfigJson({ defaultFormat: 'json' })
		const config = await importConfig()

		config.resetConfigCache()
		config.resetConfigCache()

		expect(config.loadConfig()).toEqual({ defaultFormat: 'json' })
	})

	it('exposes the mutable cache to callers', async () => {
		// NOTE: suspected bug — loadConfig returns the cached object itself, so any
		// caller that mutates it rewrites the config for the whole process.
		writeConfigJson({ fredApiKey: 'from-file' })
		const config = await importConfig()
		const loaded = config.loadConfig() as Record<string, unknown>

		loaded.fredApiKey = 'mutated-by-caller'

		expect(config.loadConfig().fredApiKey).toBe('mutated-by-caller')
		expect(readSavedConfig().fredApiKey).toBe('from-file')
	})
})

describe('saveConfig', () => {
	it('creates the .omd directory and the config file', async () => {
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'brand-new-key' })

		expect(statSync(join(home.dir, '.omd')).isDirectory()).toBe(true)
		expect(readSavedConfig()).toEqual({ fredApiKey: 'brand-new-key' })
	})

	it('writes a newly created config file with 0600 permissions', async () => {
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'secret-key' })

		expect(permissionsOf(home.configFile)).toBe('600')
	})

	it('leaves the permissions of an existing config file untouched', async () => {
		// NOTE: suspected bug — writeFileSync only applies `mode` when it creates
		// the file, so a world-readable config.json stays world-readable after
		// `omd config set` writes new secrets into it.
		writeConfigRaw(JSON.stringify({ defaultFormat: 'json' }), 0o644)
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'secret-key' })

		expect(permissionsOf(home.configFile)).toBe('644')
	})

	it('writes human-editable pretty-printed JSON', async () => {
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'a-key', defaultFormat: 'json' })

		const raw = readFileSync(home.configFile, 'utf-8')
		expect(raw.startsWith('{\n  "')).toBe(true)
		expect(raw).toContain('\n  "defaultFormat": "json"')
	})

	it('merges into the existing file instead of replacing it', async () => {
		writeConfigJson({ fredApiKey: 'keep-me', defaultFormat: 'plain' })
		const config = await importConfig()

		config.saveConfig({ coingeckoApiKey: 'CG-newlyAdded1234567890ab' })

		expect(readSavedConfig()).toEqual({
			fredApiKey: 'keep-me',
			defaultFormat: 'plain',
			coingeckoApiKey: 'CG-newlyAdded1234567890ab',
		})
	})

	it('overwrites a key that already exists on disk', async () => {
		writeConfigJson({ fredApiKey: 'old-key' })
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'new-key' })

		expect(readSavedConfig().fredApiKey).toBe('new-key')
	})

	it('preserves non-key fields it was not asked to change', async () => {
		writeConfigJson({ disabledSources: ['binance'], defaultFormat: 'markdown' })
		const config = await importConfig()

		config.saveConfig({ edgarUserAgent: 'Saver saver@example.com' })

		expect(readSavedConfig()).toEqual({
			disabledSources: ['binance'],
			defaultFormat: 'markdown',
			edgarUserAgent: 'Saver saver@example.com',
		})
	})

	it('accumulates across consecutive saves', async () => {
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'one' })
		config.saveConfig({ finnhubApiKey: 'two' })
		config.saveConfig({ defaultFormat: 'plain' })

		expect(readSavedConfig()).toEqual({
			fredApiKey: 'one',
			finnhubApiKey: 'two',
			defaultFormat: 'plain',
		})
	})

	it('writes the file even when given nothing to change', async () => {
		writeConfigJson({ fredApiKey: 'unchanged' })
		const config = await importConfig()

		config.saveConfig({})

		expect(readSavedConfig()).toEqual({ fredApiKey: 'unchanged' })
	})

	it('creates an empty config file when saving nothing with no prior config', async () => {
		const config = await importConfig()

		config.saveConfig({})

		expect(readSavedConfig()).toEqual({})
	})

	it('refreshes the cache so the next read sees the new value', async () => {
		writeConfigJson({ fredApiKey: 'old-key' })
		const config = await importConfig()
		expect(config.loadConfig().fredApiKey).toBe('old-key')

		config.saveConfig({ fredApiKey: 'new-key' })

		expect(config.loadConfig().fredApiKey).toBe('new-key')
	})

	it('survives a cache reset because the value really reached disk', async () => {
		const config = await importConfig()

		config.saveConfig({ defaultFormat: 'plain', disabledSources: ['binance'] })
		config.resetConfigCache()

		expect(config.loadConfig()).toEqual({ defaultFormat: 'plain', disabledSources: ['binance'] })
	})

	it('round-trips array and nested values through JSON', async () => {
		const config = await importConfig()

		config.saveConfig({ disabledSources: ['binance', 'coingecko', 'fred'] })
		config.resetConfigCache()

		expect(config.loadConfig().disabledSources).toEqual(['binance', 'coingecko', 'fred'])
	})

	it('deletes a key from the file when handed an explicit undefined', async () => {
		// NOTE: suspected bug — `{ ...existing, ...config }` lets an undefined value
		// win, and JSON.stringify then drops the key, so an accidental undefined
		// silently erases a stored key.
		writeConfigJson({ fredApiKey: 'about-to-vanish', defaultFormat: 'json' })
		const config = await importConfig()

		config.saveConfig({ fredApiKey: undefined })

		expect(readSavedConfig()).toEqual({ defaultFormat: 'json' })
	})

	it('persists env-derived secrets into the file', async () => {
		// NOTE: suspected bug — saveConfig merges over loadConfig(), which already
		// folded in the environment, so `omd config set defaultFormat json` copies
		// FRED_API_KEY and friends out of the environment and onto disk.
		process.env.FRED_API_KEY = 'env0f1e2d3c4b5a69788796a5b4c3d2e1f0'
		process.env.EDGAR_USER_AGENT = 'Env Research env@example.com'
		const config = await importConfig()

		config.saveConfig({ defaultFormat: 'json' })

		expect(readSavedConfig()).toEqual({
			fredApiKey: 'env0f1e2d3c4b5a69788796a5b4c3d2e1f0',
			edgarUserAgent: 'Env Research env@example.com',
			defaultFormat: 'json',
		})
	})

	it('keeps the env var winning after a save of the same key', async () => {
		process.env.FRED_API_KEY = 'env-wins'
		const config = await importConfig()

		config.saveConfig({ fredApiKey: 'saved-to-file' })

		expect(readSavedConfig().fredApiKey).toBe('saved-to-file')
		expect(config.loadConfig().fredApiKey).toBe('saved-to-file')

		config.resetConfigCache()
		expect(config.loadConfig().fredApiKey).toBe('env-wins')
	})

	it('recovers a corrupt config file by overwriting it with valid JSON', async () => {
		writeConfigRaw('{ broken')
		const config = await importConfig()

		config.saveConfig({ defaultFormat: 'markdown' })

		expect(readSavedConfig()).toEqual({ defaultFormat: 'markdown' })
	})

	it('propagates a write error and leaves the cache untouched', async () => {
		// A regular file where the .omd directory belongs: existsSync() is happy,
		// the write is not.
		writeFileSync(join(home.dir, '.omd'), 'not a directory')
		const config = await importConfig()

		expect(() => config.saveConfig({ fredApiKey: 'never-lands' })).toThrow(/ENOTDIR/)
		expect(config.loadConfig().fredApiKey).toBeUndefined()
	})
})

describe('.env loader', () => {
	it('sets a plain KEY=value pair into process.env', async () => {
		writeEnvFile('OMD_TEST_PLAIN=plain-value\n')
		await importConfig()

		expect(process.env.OMD_TEST_PLAIN).toBe('plain-value')
	})

	it('strips surrounding double quotes', async () => {
		writeEnvFile('OMD_TEST_DQ="double quoted"\n')
		await importConfig()

		expect(process.env.OMD_TEST_DQ).toBe('double quoted')
	})

	it('strips surrounding single quotes', async () => {
		writeEnvFile("OMD_TEST_SQ='single quoted'\n")
		await importConfig()

		expect(process.env.OMD_TEST_SQ).toBe('single quoted')
	})

	it('strips quotes after trimming the surrounding whitespace', async () => {
		writeEnvFile('OMD_TEST_PADQ=   "padded and quoted"   \n')
		await importConfig()

		expect(process.env.OMD_TEST_PADQ).toBe('padded and quoted')
	})

	it('leaves mismatched quotes in place', async () => {
		writeEnvFile('OMD_TEST_MIX="mismatched\'\n')
		await importConfig()

		expect(process.env.OMD_TEST_MIX).toBe('"mismatched\'')
	})

	it('leaves an unterminated leading quote in place', async () => {
		writeEnvFile('OMD_TEST_OPEN="unterminated\n')
		await importConfig()

		expect(process.env.OMD_TEST_OPEN).toBe('"unterminated')
	})

	it('keeps quotes that only appear inside the value', async () => {
		writeEnvFile('OMD_TEST_INNER=say "hello" now\n')
		await importConfig()

		expect(process.env.OMD_TEST_INNER).toBe('say "hello" now')
	})

	it('collapses a value that is a single quote character to an empty string', async () => {
		// NOTE: suspected bug — off-by-one: for a one-character value the same
		// character satisfies both startsWith and endsWith, so `KEY="` becomes ''.
		writeEnvFile('OMD_TEST_LONE="\n')
		await importConfig()

		expect(process.env.OMD_TEST_LONE).toBe('')
	})

	it('skips lines that start with a hash', async () => {
		writeEnvFile('# OMD_TEST_COMMENTED=nope\nOMD_TEST_REAL=yes\n')
		await importConfig()

		expect(process.env.OMD_TEST_COMMENTED).toBeUndefined()
		expect(process.env.OMD_TEST_REAL).toBe('yes')
	})

	it('skips indented comment lines', async () => {
		writeEnvFile('    # OMD_TEST_INDENTED=nope\nOMD_TEST_REAL=yes\n')
		await importConfig()

		expect(process.env.OMD_TEST_INDENTED).toBeUndefined()
		expect(process.env.OMD_TEST_REAL).toBe('yes')
	})

	it('does not strip trailing inline comments', async () => {
		// NOTE: suspected bug — only whole-line comments are handled, so a trailing
		// `# note` ends up inside the API key.
		writeEnvFile('OMD_TEST_INLINE=value # trailing note\n')
		await importConfig()

		expect(process.env.OMD_TEST_INLINE).toBe('value # trailing note')
	})

	it('skips blank and whitespace-only lines', async () => {
		writeEnvFile('\n\n   \n\t\nOMD_TEST_AFTER_BLANK=ok\n\n')
		await importConfig()

		expect(process.env.OMD_TEST_AFTER_BLANK).toBe('ok')
	})

	it('skips a line with no equals sign', async () => {
		writeEnvFile('OMD_TEST_NO_EQUALS\nOMD_TEST_AFTER=ok\n')
		await importConfig()

		expect(process.env.OMD_TEST_NO_EQUALS).toBeUndefined()
		expect(process.env.OMD_TEST_AFTER).toBe('ok')
	})

	it('keeps equals signs that appear inside the value', async () => {
		writeEnvFile('OMD_TEST_B64=YWJjZGVmZ2g=\nOMD_TEST_QS=https://x.test/v1?a=1&b=2\n')
		await importConfig()

		expect(process.env.OMD_TEST_B64).toBe('YWJjZGVmZ2g=')
		expect(process.env.OMD_TEST_QS).toBe('https://x.test/v1?a=1&b=2')
	})

	it('trims whitespace around the key and the value but not inside the value', async () => {
		writeEnvFile('   OMD_TEST_PAD   =    padded  value    \n')
		await importConfig()

		expect(process.env.OMD_TEST_PAD).toBe('padded  value')
	})

	it('accepts an empty value', async () => {
		writeEnvFile('OMD_TEST_BLANK=\n')
		await importConfig()

		expect(process.env.OMD_TEST_BLANK).toBe('')
	})

	it('parses the last line even without a trailing newline', async () => {
		writeEnvFile('OMD_TEST_FIRST=one\nOMD_TEST_LAST=two')
		await importConfig()

		expect(process.env.OMD_TEST_LAST).toBe('two')
	})

	it('handles CRLF line endings', async () => {
		writeEnvFile('OMD_TEST_CRLF_A=alpha\r\nOMD_TEST_CRLF_B=beta\r\n')
		await importConfig()

		expect(process.env.OMD_TEST_CRLF_A).toBe('alpha')
		expect(process.env.OMD_TEST_CRLF_B).toBe('beta')
	})

	it('lets the first occurrence of a duplicated key win', async () => {
		writeEnvFile('OMD_TEST_DUP=first\nOMD_TEST_DUP=second\n')
		await importConfig()

		expect(process.env.OMD_TEST_DUP).toBe('first')
	})

	it('never overrides a variable that is already set', async () => {
		process.env.OMD_TEST_PRESET = 'from-process'
		writeEnvFile('OMD_TEST_PRESET=from-dotenv\n')
		await importConfig()

		expect(process.env.OMD_TEST_PRESET).toBe('from-process')
	})

	it('never overrides a variable that is already set to an empty string', async () => {
		process.env.OMD_TEST_PRESET_EMPTY = ''
		writeEnvFile('OMD_TEST_PRESET_EMPTY=from-dotenv\n')
		await importConfig()

		expect(process.env.OMD_TEST_PRESET_EMPTY).toBe('')
	})

	it('does not understand the export prefix', async () => {
		// NOTE: suspected bug — a copy-pasted `export FOO=bar` line produces a
		// variable literally named "export FOO", so FOO is never set.
		writeEnvFile('export OMD_TEST_EXPORTED=exported\n')
		await importConfig()

		expect(process.env.OMD_TEST_EXPORTED).toBeUndefined()
		expect(process.env['export OMD_TEST_EXPORTED']).toBe('exported')
	})

	it('keeps parsing after a line that begins with an equals sign', async () => {
		// NOTE: the loader does not actually skip `=orphan` — it derives an empty key
		// and runs `process.env[''] = 'orphan'`, which Node itself discards. What the
		// product controls is that the loader neither aborts on the line nor invents a
		// name to file the orphaned value under.
		writeEnvFile('=orphan\nOMD_TEST_AFTER_ORPHAN=ok\n')
		await importConfig()

		expect(Object.keys(process.env).filter((key) => process.env[key] === 'orphan')).toEqual([])
		expect(process.env.OMD_TEST_AFTER_ORPHAN).toBe('ok')
	})

	it('parses a realistic multi-line file', async () => {
		writeEnvFile(
			[
				'# open-market-data credentials',
				'',
				'FRED_API_KEY=abcdef0123456789abcdef0123456789',
				'COINGECKO_API_KEY="CG-dotenvDemo123456789ab"',
				"EDGAR_USER_AGENT='Dotenv Research dotenv@example.com'",
				'',
				'# FINNHUB_API_KEY=disabled-for-now',
			].join('\n'),
		)
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({
			fredApiKey: 'abcdef0123456789abcdef0123456789',
			coingeckoApiKey: 'CG-dotenvDemo123456789ab',
			edgarUserAgent: 'Dotenv Research dotenv@example.com',
		})
	})

	it('is silent when no .env exists', async () => {
		const config = await importConfig()

		expect(existsSync(join(cwdDir, '.env'))).toBe(false)
		expect(config.loadConfig()).toEqual({})
	})

	it('is silent when .env cannot be read', async () => {
		mkdirSync(join(cwdDir, '.env'))
		process.env.FRED_API_KEY = 'unaffected'
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({ fredApiKey: 'unaffected' })
	})

	it('reads .env from the current working directory, not the package root', async () => {
		// Two .env files: one in the ancestor directory, one in the cwd. Only the
		// cwd's may be read, and the loader must not walk up to find the other.
		writeEnvFile('OMD_TEST_ANCESTOR_ONLY=ancestor\n')
		const nested = join(cwdDir, 'nested')
		mkdirSync(nested)
		writeFileSync(join(nested, '.env'), 'OMD_TEST_CWD_ONLY=loaded\n')
		process.chdir(nested)

		await importConfig()

		expect(process.env.OMD_TEST_CWD_ONLY).toBe('loaded')
		expect(process.env.OMD_TEST_ANCESTOR_ONLY).toBeUndefined()
	})
})

describe('.env and config precedence', () => {
	it('feeds .env values through to loadConfig', async () => {
		writeEnvFile('FRED_API_KEY=dotenv0123456789abcdef0123456789ab\n')
		const config = await importConfig()

		expect(config.loadConfig().fredApiKey).toBe('dotenv0123456789abcdef0123456789ab')
	})

	it('lets a .env value beat the config file', async () => {
		writeConfigJson(FILE_CONFIG)
		writeEnvFile('FRED_API_KEY=dotenv0123456789abcdef0123456789ab\n')
		const config = await importConfig()

		expect(config.loadConfig().fredApiKey).toBe('dotenv0123456789abcdef0123456789ab')
	})

	it('lets an exported shell variable beat the .env file', async () => {
		process.env.FRED_API_KEY = 'shell0123456789abcdef0123456789ab'
		writeEnvFile('FRED_API_KEY=dotenv0123456789abcdef0123456789ab\n')
		const config = await importConfig()

		expect(config.loadConfig().fredApiKey).toBe('shell0123456789abcdef0123456789ab')
	})

	it('leaves file-only settings alone when .env supplies keys', async () => {
		writeConfigJson({ defaultFormat: 'plain', disabledSources: ['binance'] })
		writeEnvFile('FINNHUB_API_KEY=cdotenv7b9r01qhq0c1k2m0\n')
		const config = await importConfig()

		expect(config.loadConfig()).toEqual({
			defaultFormat: 'plain',
			disabledSources: ['binance'],
			finnhubApiKey: 'cdotenv7b9r01qhq0c1k2m0',
		})
	})

	it('writes .env-derived keys to disk on the next saveConfig', async () => {
		// NOTE: suspected bug — same env-persistence path as above, reached simply
		// by having a .env in the project directory.
		writeEnvFile('COINGECKO_API_KEY=CG-dotenvDemo123456789ab\n')
		const config = await importConfig()

		config.saveConfig({ defaultFormat: 'markdown' })

		expect(readSavedConfig()).toEqual({
			coingeckoApiKey: 'CG-dotenvDemo123456789ab',
			defaultFormat: 'markdown',
		})
	})
})
