/**
 * Helpers for testing modules that hold process-lifetime state.
 *
 * Several modules in this codebase memoize at module scope — `config.ts` caches
 * the resolved config, `sec-edgar.ts` caches the ticker map and a
 * "warned once" flag, `binance.ts` latches geo-restriction, and `router.ts`
 * keeps a module-level provider array. Tests that need a clean slate must
 * re-import the module through `freshImport`.
 *
 * NOTE: `vi.resetModules()` clears the whole registry, so a freshly imported
 * module gets *fresh copies of its dependencies too*. A module imported at the
 * top of your test file is a different instance from one returned by
 * `freshImport`. Import everything you need to interact with through
 * `freshImport` within a single test, or state will not line up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

/** Resets the module registry and imports a fresh copy of `specifier`. */
export async function freshImport<T = Record<string, unknown>>(specifier: string): Promise<T> {
	vi.resetModules()
	return (await import(specifier)) as T
}

/**
 * Imports fresh copies of several modules that share one registry generation,
 * so they see each other's state. Pass specifiers relative to `tests/helpers/`.
 */
export async function freshImportAll<T extends Record<string, string>>(
	specifiers: T,
): Promise<{ [K in keyof T]: Record<string, unknown> }> {
	vi.resetModules()
	const out = {} as { [K in keyof T]: Record<string, unknown> }
	for (const [key, specifier] of Object.entries(specifiers)) {
		out[key as keyof T] = (await import(specifier)) as Record<string, unknown>
	}
	return out
}

export interface TempHome {
	dir: string
	/** Path to the config file `config.ts` would read inside this home. */
	configFile: string
	cleanup(): void
}

/**
 * Points `$HOME` at a throwaway directory. `os.homedir()` honours `$HOME` on
 * POSIX, so `config.ts` reads/writes `<temp>/.omd/config.json` instead of the
 * real user config — tests never touch the developer's machine.
 */
export function makeTempHome(): TempHome {
	const dir = mkdtempSync(join(tmpdir(), 'omd-test-home-'))
	const previous = process.env.HOME
	process.env.HOME = dir
	return {
		dir,
		configFile: join(dir, '.omd', 'config.json'),
		cleanup() {
			if (previous === undefined) delete process.env.HOME
			else process.env.HOME = previous
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

/** Every env var the config layer reads. Useful for wiping between tests. */
export const CONFIG_ENV_VARS = [
	'FRED_API_KEY',
	'COINGECKO_API_KEY',
	'FINNHUB_API_KEY',
	'ALPHA_VANTAGE_API_KEY',
	'EDGAR_USER_AGENT',
] as const

/** Deletes all provider-key env vars, returning a function that restores them. */
export function clearConfigEnv(): () => void {
	const saved: Record<string, string | undefined> = {}
	for (const key of CONFIG_ENV_VARS) {
		saved[key] = process.env[key]
		delete process.env[key]
	}
	return () => {
		for (const key of CONFIG_ENV_VARS) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key] as string
		}
	}
}
