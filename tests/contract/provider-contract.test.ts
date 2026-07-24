import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alphaVantage } from '../../src/providers/alpha-vantage.js'
import { binance } from '../../src/providers/binance.js'
import { coingecko } from '../../src/providers/coingecko.js'
import { finnhub } from '../../src/providers/finnhub.js'
import { fred } from '../../src/providers/fred.js'
import { secEdgar } from '../../src/providers/sec-edgar.js'
import type { DataCategory, Provider } from '../../src/providers/types.js'
import { worldBank } from '../../src/providers/world-bank.js'
import { yahoo } from '../../src/providers/yahoo-finance.js'
import { type FetchMock, expectNoUnmatched, mockFetch } from '../helpers/mock-fetch.js'
import { type TempHome, clearConfigEnv, freshImport, makeTempHome } from '../helpers/modules.js'
import { ALL_CATEGORIES, createMockProvider } from '../helpers/providers.js'

/**
 * Cross-provider contract suite. Everything here is table driven off `PROVIDERS`,
 * and `PROVIDERS` is itself checked against the contents of `src/providers/`, so
 * a newly added provider is covered the moment its module lands.
 *
 * Two rules keep this file deterministic:
 *   1. The statically imported provider singletons are only used for assertions
 *      that never read config — shape checks and "unsupported operation" paths.
 *      `src/core/config.ts` resolves its config path at module load, so the
 *      top-level generation would read the developer's real `~/.omd/config.json`.
 *   2. Anything that touches config or the router (isEnabled, missing-key errors,
 *      the registry) pulls a fresh module generation through `freshImport` while
 *      `$HOME` points at a throwaway directory and every key env var is cleared.
 *
 * Nothing here touches the network: every test that can reach I/O installs a
 * `mockFetch` that throws on any request.
 */

type RouterModule = typeof import('../../src/core/router.js')
type RegistryModule = typeof import('../../src/providers/registry.js')
type BinanceModule = typeof import('../../src/providers/binance.js')
type CoingeckoModule = typeof import('../../src/providers/coingecko.js')
type FinnhubModule = typeof import('../../src/providers/finnhub.js')

interface ProviderCase {
	/** File under src/providers/ that exports this provider. */
	file: string
	provider: Provider
}

const PROVIDERS: ProviderCase[] = [
	{ file: 'sec-edgar.ts', provider: secEdgar },
	{ file: 'yahoo-finance.ts', provider: yahoo },
	{ file: 'binance.ts', provider: binance },
	{ file: 'coingecko.ts', provider: coingecko },
	{ file: 'fred.ts', provider: fred },
	{ file: 'finnhub.ts', provider: finnhub },
	{ file: 'alpha-vantage.ts', provider: alphaVantage },
	{ file: 'world-bank.ts', provider: worldBank },
]

/** The names `registerAllProviders()` is expected to put in the registry, in order. */
const REGISTERED_NAMES = [
	'sec-edgar',
	'yahoo',
	'binance',
	'coingecko',
	'fred',
	'finnhub',
	'alphavantage',
	'worldbank',
]

/** Every env var the router's help text must know how to spell as a config key. */
const MAPPED_KEY_ENV_VARS = [
	'COINGECKO_API_KEY',
	'FRED_API_KEY',
	'FINNHUB_API_KEY',
	'ALPHA_VANTAGE_API_KEY',
]

/** An env var no provider declares, used to observe the router's raw fallback. */
const UNMAPPED_KEY_ENV_VAR = 'DEFINITELY_NOT_A_MAPPED_API_KEY'

const KEYED_PROVIDERS = PROVIDERS.filter((c) => c.provider.requiresKey)
const KEYLESS_PROVIDERS = PROVIDERS.filter((c) => !c.provider.requiresKey)

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

const UNSUPPORTED_ACTION = 'definitely-not-a-real-action'
const UNSUPPORTED_CATEGORY = 'definitely-not-a-real-category' as DataCategory

/**
 * The exact rejection message each provider produces for an empty action on the
 * first category it declares. Trailing spaces are real: `binance` and
 * `coingecko` interpolate the bare action, so an empty one leaves the message
 * dangling. Pinned in full because this is a user-visible surface.
 */
const EMPTY_ACTION_MESSAGES: Record<string, string> = {
	'sec-edgar': 'SEC EDGAR does not support search/',
	yahoo: '[yahoo] Unsupported operation: search/',
	binance: 'Binance does not support action: ',
	coingecko: 'CoinGecko crypto does not support action: ',
	fred: 'FRED provider does not support macro/',
	finnhub: '[finnhub] Unsupported operation: search/',
	alphavantage: '[alphavantage] Unsupported operation: search/',
	worldbank: '[worldbank] Provider does not support macro/',
}

const PROVIDER_DIR = fileURLToPath(new URL('../../src/providers/', import.meta.url))

/** (provider, category) pairs — one per declared capability, across all providers. */
const CAPABILITY_PAIRS = PROVIDERS.flatMap(({ file, provider }) =>
	provider.capabilities.map((category) => ({ file, provider, category })),
)

/**
 * A key-requiring provider plus a request it does support, so the missing-key
 * path can be exercised without guessing at an action.
 */
interface KeyedCase {
	name: string
	envVar: string
	configKey: string
	category: DataCategory
	action: string
	args: Record<string, unknown>
	load(): Promise<Provider>
}

const KEYED_CASES: KeyedCase[] = [
	{
		name: 'coingecko',
		envVar: 'COINGECKO_API_KEY',
		configKey: 'coingeckoApiKey',
		category: 'crypto',
		action: 'quote',
		args: { symbol: 'BTC' },
		load: async () => (await import('../../src/providers/coingecko.js')).coingecko,
	},
	{
		name: 'fred',
		envVar: 'FRED_API_KEY',
		configKey: 'fredApiKey',
		category: 'macro',
		action: 'get',
		args: { seriesId: 'CPIAUCSL' },
		load: async () => (await import('../../src/providers/fred.js')).fred,
	},
	{
		name: 'finnhub',
		envVar: 'FINNHUB_API_KEY',
		configKey: 'finnhubApiKey',
		category: 'quote',
		action: 'get',
		args: { symbol: 'AAPL' },
		load: async () => (await import('../../src/providers/finnhub.js')).finnhub,
	},
	{
		name: 'alphavantage',
		envVar: 'ALPHA_VANTAGE_API_KEY',
		configKey: 'alphaVantageApiKey',
		category: 'quote',
		action: 'get',
		args: { symbol: 'AAPL' },
		load: async () => (await import('../../src/providers/alpha-vantage.js')).alphaVantage,
	},
]

let home: TempHome
let restoreConfigEnv: () => void
let fx: FetchMock | null = null

beforeEach(() => {
	restoreConfigEnv = clearConfigEnv()
	home = makeTempHome()
})

afterEach(() => {
	fx?.restore()
	fx = null
	home.cleanup()
	restoreConfigEnv()
})

/** Installs a fetch mock that rejects everything, so any I/O is visible and offline. */
function forbidNetwork(): FetchMock {
	fx = mockFetch([])
	return fx
}

/** One fresh generation of the router plus the registry that feeds it. */
async function loadRegistry(): Promise<{ router: RouterModule; registry: RegistryModule }> {
	const router = await freshImport<RouterModule>('../../src/core/router.js')
	const registry: RegistryModule = await import('../../src/providers/registry.js')
	return { router, registry }
}

/** A fresh generation with `registerAllProviders()` already applied. */
async function loadRegistered(): Promise<{ router: RouterModule; providers: Provider[] }> {
	const { router, registry } = await loadRegistry()
	registry.registerAllProviders()
	return { router, providers: router.getProviders() }
}

function byName(providers: Provider[], name: string): Provider {
	const found = providers.find((p) => p.name === name)
	if (!found) throw new Error(`provider "${name}" is not registered`)
	return found
}

const names = (providers: Provider[]): string[] => providers.map((p) => p.name)

/** Captures the rejection so a test can assert on the exact message. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise
	} catch (err) {
		return err as Error
	}
	throw new Error('expected the promise to reject, but it resolved')
}

// --- per-provider shape contract -------------------------------------------

describe.each(PROVIDERS)('provider contract — $file', ({ provider }) => {
	it('exposes a non-empty name', () => {
		expect(provider.name.length).toBeGreaterThan(0)
	})

	it('names itself with a lower-case slug', () => {
		expect(provider.name).toMatch(SLUG)
	})

	it('declares requiresKey as a boolean', () => {
		expect(typeof provider.requiresKey).toBe('boolean')
	})

	it('declares keyEnvVar if and only if it requires a key', () => {
		expect(provider.keyEnvVar !== undefined).toBe(provider.requiresKey)
	})

	it('declares at least one capability', () => {
		expect(provider.capabilities.length).toBeGreaterThan(0)
	})

	it('declares only categories the CLI knows about', () => {
		expect(provider.capabilities.filter((c) => !ALL_CATEGORIES.includes(c))).toEqual([])
	})

	it('declares no duplicate capabilities', () => {
		expect([...new Set(provider.capabilities)]).toEqual(provider.capabilities)
	})

	it('ranks only categories it can actually serve', () => {
		const ranked = Object.keys(provider.priority) as DataCategory[]
		expect(ranked.filter((c) => !provider.capabilities.includes(c))).toEqual([])
	})

	it('ranks every capability it declares', () => {
		expect(provider.capabilities.filter((c) => provider.priority[c] === undefined)).toEqual([])
	})

	it('uses positive finite priority values', () => {
		const bad = Object.entries(provider.priority).filter(
			([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0,
		)
		expect(bad).toEqual([])
	})

	it('budgets a positive, finite number of requests per window', () => {
		expect(provider.rateLimits.maxRequests).toBeGreaterThan(0)
		expect(Number.isFinite(provider.rateLimits.maxRequests)).toBe(true)
	})

	it('declares a positive, finite rate-limit window', () => {
		expect(provider.rateLimits.windowMs).toBeGreaterThan(0)
		expect(Number.isFinite(provider.rateLimits.windowMs)).toBe(true)
	})

	it('exposes isEnabled and execute as functions', () => {
		expect(typeof provider.isEnabled).toBe('function')
		expect(typeof provider.execute).toBe('function')
	})
})

// --- the provider set as a whole -------------------------------------------

describe('the provider set', () => {
	it('has a contract case for every module in src/providers', () => {
		const modules = readdirSync(PROVIDER_DIR)
			.filter((f) => f.endsWith('.ts'))
			.filter((f) => f !== 'types.ts' && f !== 'registry.ts')
			.sort()

		expect(modules).toEqual(PROVIDERS.map((c) => c.file).sort())
	})

	it('gives every provider a unique name', () => {
		const all = PROVIDERS.map((c) => c.provider.name)

		expect([...new Set(all)]).toEqual(all)
	})

	it('declares no category outside ALL_CATEGORIES', () => {
		const declared = PROVIDERS.flatMap((c) => c.provider.capabilities)

		expect(declared.filter((c) => !ALL_CATEGORIES.includes(c))).toEqual([])
	})

	it('covers every category in ALL_CATEGORIES with at least one provider', () => {
		const declared = new Set(PROVIDERS.flatMap((c) => c.provider.capabilities))

		expect(declared).toEqual(new Set(ALL_CATEGORIES))
	})

	it.each(ALL_CATEGORIES)('has at least one provider capable of %s', (category) => {
		const capable = PROVIDERS.filter((c) => c.provider.capabilities.includes(category))

		expect(capable.length).toBeGreaterThan(0)
	})

	it('contains both key-requiring and key-free providers', () => {
		expect(KEYED_PROVIDERS.length).toBeGreaterThan(0)
		expect(KEYLESS_PROVIDERS.length).toBeGreaterThan(0)
	})

	it.each(KEYED_PROVIDERS)(
		'$provider.name names its env var in SCREAMING_SNAKE_CASE',
		({ provider }) => {
			expect(provider.keyEnvVar).toMatch(SCREAMING_SNAKE_CASE)
		},
	)

	it.each(KEYLESS_PROVIDERS)('$provider.name declares no key env var', ({ provider }) => {
		expect(provider.keyEnvVar).toBeUndefined()
	})

	it('requires a key for exactly the env vars the router can explain', async () => {
		const declared = KEYED_PROVIDERS.map((c) => c.provider.keyEnvVar as string)
		const router = await freshImport<RouterModule>('../../src/core/router.js')
		// Disabled stand-ins — one per declared env var, plus one the router cannot
		// know about — so the assertion reads the router's own env-var -> config-key
		// map instead of a second copy of it maintained in this file.
		for (const [i, keyEnvVar] of [...declared, UNMAPPED_KEY_ENV_VAR].entries()) {
			router.registerProvider(
				createMockProvider({
					name: `stub-${i}`,
					capabilities: ['quote'],
					requiresKey: true,
					keyEnvVar,
					isEnabled: () => false,
				}),
			)
		}

		const err = await rejection(router.route('quote', 'get', {}, { noCache: true }))

		// An env var the router has no mapping for is echoed back raw as the config
		// key — that is the shape a declared env var must never have.
		expect(err.message).toContain(
			`requires ${UNMAPPED_KEY_ENV_VAR} (run: omd config set ${UNMAPPED_KEY_ENV_VAR} <key>)`,
		)
		const unexplained = declared.filter((envVar) =>
			err.message.includes(`omd config set ${envVar} <key>`),
		)
		expect(unexplained).toEqual([])
		expect(new Set(declared)).toEqual(new Set(MAPPED_KEY_ENV_VARS))
	})

	it('gives each key-requiring provider a distinct env var', () => {
		const declared = KEYED_PROVIDERS.map((c) => c.provider.keyEnvVar)

		expect([...new Set(declared)]).toEqual(declared)
	})
})

// --- isEnabled() ------------------------------------------------------------

describe('isEnabled()', () => {
	it.each(REGISTERED_NAMES)('%s returns a boolean without throwing', async (name) => {
		const { providers } = await loadRegistered()
		const provider = byName(providers, name)

		expect(typeof provider.isEnabled()).toBe('boolean')
	})

	it('issues no network request for any provider', async () => {
		const { providers } = await loadRegistered()
		const mock = forbidNetwork()

		for (const provider of providers) {
			expect(typeof provider.isEnabled()).toBe('boolean')
		}

		expect(mock.callCount()).toBe(0)
		expectNoUnmatched(mock)
	})

	it.each(KEYLESS_PROVIDERS.map((c) => c.provider.name))(
		'%s is enabled with no API keys configured',
		async (name) => {
			const { providers } = await loadRegistered()

			expect(byName(providers, name).isEnabled()).toBe(true)
		},
	)

	it.each(KEYED_PROVIDERS.map((c) => c.provider.name))(
		'%s is disabled with no API key configured',
		async (name) => {
			const { providers } = await loadRegistered()

			expect(byName(providers, name).isEnabled()).toBe(false)
		},
	)

	it.each(KEYED_CASES)('$name turns itself on once $envVar is set', async ({ name, envVar }) => {
		process.env[envVar] = 'contract-test-key'
		const { providers } = await loadRegistered()

		expect(byName(providers, name).isEnabled()).toBe(true)
	})
})

// --- execute() on operations a provider does not support --------------------

describe('execute() — unsupported operations', () => {
	it.each(CAPABILITY_PAIRS)(
		'$provider.name rejects with an Error for $category with an unknown action',
		async ({ provider, category }) => {
			forbidNetwork()

			const err = await rejection(provider.execute(category, UNSUPPORTED_ACTION, {}))

			expect(err).toBeInstanceOf(Error)
		},
	)

	it.each(CAPABILITY_PAIRS)(
		'$provider.name names the unknown action it rejected for $category',
		async ({ provider, category }) => {
			forbidNetwork()

			const err = await rejection(provider.execute(category, UNSUPPORTED_ACTION, {}))

			expect(err.message).toContain(UNSUPPORTED_ACTION)
		},
	)

	it.each(CAPABILITY_PAIRS)(
		'$provider.name issues no request for an unknown $category action',
		async ({ provider, category }) => {
			const mock = forbidNetwork()

			await rejection(provider.execute(category, UNSUPPORTED_ACTION, {}))

			expect(mock.callCount()).toBe(0)
			expectNoUnmatched(mock)
		},
	)

	it.each(PROVIDERS)(
		'$provider.name rejects an unknown category paired with an unknown action',
		async ({ provider }) => {
			const mock = forbidNetwork()

			const err = await rejection(provider.execute(UNSUPPORTED_CATEGORY, UNSUPPORTED_ACTION, {}))

			expect(err).toBeInstanceOf(Error)
			expect(err.message).toContain(UNSUPPORTED_ACTION)
			expect(mock.callCount()).toBe(0)
		},
	)

	it.each(PROVIDERS)(
		'$provider.name rejects an empty action for a category it serves',
		async ({ provider }) => {
			const mock = forbidNetwork()
			const category = provider.capabilities[0]

			const err = await rejection(provider.execute(category, '', {}))

			expect(err.message).toBe(EMPTY_ACTION_MESSAGES[provider.name])
			expect(mock.callCount()).toBe(0)
		},
	)
})

// --- key-requiring providers with nothing configured ------------------------

describe('execute() — key-requiring providers with no key', () => {
	it.each(KEYED_CASES)(
		'$name rejects $category/$action with a message naming $envVar',
		async ({ envVar, category, action, args, load }) => {
			await freshImport('../../src/core/config.js')
			const provider = await load()
			forbidNetwork()

			const err = await rejection(provider.execute(category, action, args))

			expect(err.message).toContain(envVar)
		},
	)

	it.each(KEYED_CASES)(
		'$name tells the user which config key to set for $category/$action',
		async ({ configKey, category, action, args, load }) => {
			await freshImport('../../src/core/config.js')
			const provider = await load()
			forbidNetwork()

			const err = await rejection(provider.execute(category, action, args))

			expect(err.message).toContain(`omd config set ${configKey}`)
		},
	)

	it.each(KEYED_CASES)(
		'$name issues no request for $category/$action while unconfigured',
		async ({ category, action, args, load }) => {
			await freshImport('../../src/core/config.js')
			const provider = await load()
			const mock = forbidNetwork()

			await rejection(provider.execute(category, action, args))

			expect(mock.callCount()).toBe(0)
			expectNoUnmatched(mock)
		},
	)
})

// --- the keyEnvVar -> config-key mapping the router prints ------------------

describe('router help text for key-requiring providers', () => {
	it.each(KEYED_CASES)(
		'points a user at `omd config set $configKey` when only $name can serve $category',
		async ({ name, envVar, configKey, category, action, args }) => {
			const router = await freshImport<RouterModule>('../../src/core/router.js')
			const provider = await KEYED_CASES.filter((c) => c.name === name)[0].load()
			router.registerProvider(provider)

			const err = await rejection(router.route(category, action, args, { noCache: true }))

			expect(err.message).toBe(
				`No providers available for "${category}". Providers exist but are not enabled:\n  ${name}: requires ${envVar} (run: omd config set ${configKey} <key>)`,
			)
		},
	)

	it.each(KEYED_CASES)(
		'never falls back to the raw env var name for $name',
		async ({ name, envVar, category, action, args }) => {
			const router = await freshImport<RouterModule>('../../src/core/router.js')
			const provider = await KEYED_CASES.filter((c) => c.name === name)[0].load()
			router.registerProvider(provider)

			const err = await rejection(router.route(category, action, args, { noCache: true }))

			expect(err.message).not.toContain(`omd config set ${envVar}`)
		},
	)
})

// --- registerAllProviders() -------------------------------------------------

describe('registerAllProviders', () => {
	it('registers exactly eight providers', async () => {
		const { providers } = await loadRegistered()

		expect(providers).toHaveLength(8)
	})

	it('registers the expected names in the documented order', async () => {
		const { providers } = await loadRegistered()

		expect(names(providers)).toEqual(REGISTERED_NAMES)
	})

	it('registers the same names the contract table covers', async () => {
		const { providers } = await loadRegistered()

		expect(new Set(names(providers))).toEqual(new Set(PROVIDERS.map((c) => c.provider.name)))
	})

	it('registers no duplicate names', async () => {
		const { providers } = await loadRegistered()

		expect([...new Set(names(providers))]).toHaveLength(providers.length)
	})

	it('registers the exported provider singletons themselves', async () => {
		const { router, registry } = await loadRegistry()
		registry.registerAllProviders()
		const registered = router.getProviders()

		expect(registered[0]).toBe((await import('../../src/providers/sec-edgar.js')).secEdgar)
		expect(registered[1]).toBe((await import('../../src/providers/yahoo-finance.js')).yahoo)
		expect(registered[2]).toBe((await import('../../src/providers/binance.js')).binance)
		expect(registered[3]).toBe((await import('../../src/providers/coingecko.js')).coingecko)
		expect(registered[4]).toBe((await import('../../src/providers/fred.js')).fred)
		expect(registered[5]).toBe((await import('../../src/providers/finnhub.js')).finnhub)
		expect(registered[6]).toBe((await import('../../src/providers/alpha-vantage.js')).alphaVantage)
		expect(registered[7]).toBe((await import('../../src/providers/world-bank.js')).worldBank)
	})

	it('is idempotent when called twice', async () => {
		const { router, registry } = await loadRegistry()

		registry.registerAllProviders()
		registry.registerAllProviders()

		expect(names(router.getProviders())).toEqual(REGISTERED_NAMES)
	})

	it('is idempotent when called many times', async () => {
		const { router, registry } = await loadRegistry()

		for (let i = 0; i < 5; i++) registry.registerAllProviders()

		expect(router.getProviders()).toHaveLength(8)
	})

	it('keeps the same provider instances across repeated registration', async () => {
		const { router, registry } = await loadRegistry()
		registry.registerAllProviders()
		const first = router.getProviders()

		registry.registerAllProviders()

		const second = router.getProviders()
		expect(second).toHaveLength(first.length)
		// Element-wise identity: a duplicate registration must not swap in a
		// distinct-but-equivalent object, which deep equality would not notice.
		for (const [i, provider] of first.entries()) expect(second[i]).toBe(provider)
	})

	it('starts from an empty registry in every fresh module generation', async () => {
		const before = await loadRegistered()
		expect(before.providers).toHaveLength(8)

		const { router } = await loadRegistry()

		expect(router.getProviders()).toEqual([])
	})

	it('does not overwrite a provider already registered under the same name', async () => {
		const { router, registry } = await loadRegistry()
		const stub = createMockProvider({ name: 'yahoo', capabilities: ['quote'] })
		router.registerProvider(stub)

		registry.registerAllProviders()

		expect(router.getProviders()).toHaveLength(8)
		expect(byName(router.getProviders(), 'yahoo')).toBe(stub)
	})

	it.each(ALL_CATEGORIES)('registers at least one provider capable of %s', async (category) => {
		const { providers } = await loadRegistered()

		expect(providers.filter((p) => p.capabilities.includes(category)).length).toBeGreaterThan(0)
	})

	it.each(ALL_CATEGORIES)('leaves %s routable with zero API keys configured', async (category) => {
		const { router } = await loadRegistered()

		expect(router.getProvidersForCategory(category).length).toBeGreaterThan(0)
	})

	it.each([
		['search', ['sec-edgar', 'yahoo']],
		['quote', ['yahoo']],
		['financials', ['sec-edgar', 'yahoo']],
		['filing', ['sec-edgar']],
		['insiders', ['sec-edgar']],
		['macro', ['worldbank']],
		['crypto', ['binance']],
		['history', ['yahoo']],
		['options', ['yahoo']],
		['earnings', ['yahoo']],
		['dividends', ['yahoo']],
	] as [DataCategory, string[]][])(
		'offers %s from %j when no key is configured',
		async (category, expected) => {
			const { router } = await loadRegistered()

			expect(names(router.getProvidersForCategory(category))).toEqual(expected)
		},
	)
})

// --- known contract violations, asserted as they behave today ---------------

describe('category handling quirks', () => {
	it('binance performs I/O for a category it never declared', async () => {
		// NOTE: suspected bug — binance.execute() switches on `action` alone and
		// ignores `category`, so a crypto ticker request is issued for a category
		// the provider does not advertise instead of rejecting as unsupported.
		const { binance: fresh } = await freshImport<BinanceModule>('../../src/providers/binance.js')
		// 503 (not 451) so the module-scope geo-restriction latch stays clear.
		fx = mockFetch([{ match: '/api/v3/ticker/24hr', respond: { status: 503, text: 'nope' } }])

		const err = await rejection(fresh.execute('macro', 'quote', { symbol: 'BTC' }))

		expect(fresh.capabilities).not.toContain('macro')
		expect(err.message).toBe('Binance API error 503: nope')
		expect(fx.urls()).toEqual(['https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'])
	})

	it('binance omits the category from its unsupported-action message', async () => {
		// NOTE: same root cause — the message cannot name the category because
		// execute() never looks at it.
		const { binance: fresh } = await freshImport<BinanceModule>('../../src/providers/binance.js')
		forbidNetwork()

		const err = await rejection(fresh.execute('crypto', UNSUPPORTED_ACTION, {}))

		expect(err.message).toBe(`Binance does not support action: ${UNSUPPORTED_ACTION}`)
		expect(err.message).not.toContain('crypto')
	})

	it('coingecko funnels an undeclared category into its crypto branch', async () => {
		// NOTE: suspected bug — anything that is not `search` is treated as
		// `crypto`, so a macro request gets as far as the API-key check rather
		// than being rejected as an unsupported category.
		const { coingecko: fresh } = await freshImport<CoingeckoModule>(
			'../../src/providers/coingecko.js',
		)
		const mock = forbidNetwork()

		const err = await rejection(fresh.execute('macro', 'quote', { symbol: 'BTC' }))

		expect(fresh.capabilities).not.toContain('macro')
		expect(err.message).toContain('CoinGecko API key not configured')
		expect(mock.callCount()).toBe(0)
	})

	it('coingecko blames the crypto branch when an undeclared category is used', async () => {
		const { coingecko: fresh } = await freshImport<CoingeckoModule>(
			'../../src/providers/coingecko.js',
		)
		forbidNetwork()

		const err = await rejection(fresh.execute('macro', UNSUPPORTED_ACTION, {}))

		expect(err.message).toBe(`CoinGecko crypto does not support action: ${UNSUPPORTED_ACTION}`)
	})

	it('finnhub answers history/get without declaring the history capability', async () => {
		// NOTE: suspected bug — finnhub.execute() implements 'history/get', but
		// 'history' is missing from `capabilities`, so the router can never route
		// history to it and the branch is dead code.
		const { finnhub: fresh } = await freshImport<FinnhubModule>('../../src/providers/finnhub.js')
		const mock = forbidNetwork()

		const err = await rejection(fresh.execute('history', 'get', { symbol: 'AAPL' }))

		expect(fresh.capabilities).not.toContain('history')
		expect(err.message).toContain('FINNHUB_API_KEY not set')
		expect(err.message).not.toContain('Unsupported operation')
		expect(mock.callCount()).toBe(0)
	})

	it('never routes history to finnhub even when its key is configured', async () => {
		process.env.FINNHUB_API_KEY = 'contract-test-key'
		const { router, providers } = await loadRegistered()

		expect(byName(providers, 'finnhub').isEnabled()).toBe(true)
		expect(names(router.getProvidersForCategory('history'))).not.toContain('finnhub')
	})
})
