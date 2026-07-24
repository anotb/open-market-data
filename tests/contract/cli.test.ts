import { type ExecFileException, execFile, execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFIG_ENV_VARS } from '../helpers/modules.js'

/**
 * End-to-end contract tests for the built CLI (`node dist/cli.js`).
 *
 * Every invocation is hermetic and offline:
 *   - $HOME points at a throwaway directory, so the CLI reads/writes
 *     `<temp>/.omd/config.json` and never the developer's real config;
 *   - the child's cwd is that same temp directory, so `config.ts`'s built-in
 *     `.env` loader cannot pick up a stray `.env` from the repo;
 *   - every provider key env var is stripped from the child env.
 *
 * Only commands that fail fast or print locally are exercised. Anything that
 * would reach a provider is deliberately avoided — e.g. `omd macro GDP` with no
 * FRED key falls through to the keyless World Bank provider and would hit the
 * network, so the macro tests disable `worldbank` in the temp config first.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
	version: string
}

/** Spawning node + loading the provider graph costs ~250ms; be generous. */
const SPAWN_TIMEOUT = 30_000

/** Env vars the child must never inherit: provider keys, plus vitest loaders. */
const STRIPPED_ENV = new Set<string>([...CONFIG_ENV_VARS, 'NODE_OPTIONS'])

/** Every provider registered by `registerAllProviders`, in registration order. */
const PROVIDER_NAMES = [
	'sec-edgar',
	'yahoo',
	'binance',
	'coingecko',
	'fred',
	'finnhub',
	'alphavantage',
	'worldbank',
]

/** Top-level commands `omd --help` must advertise, in registration order. */
const TOP_LEVEL_COMMANDS = [
	'search',
	'quote',
	'financials',
	'history',
	'options',
	'earnings',
	'dividends',
	'filing',
	'insiders',
	'macro',
	'crypto',
	'sources',
	'config',
]

interface CliResult {
	stdout: string
	stderr: string
	code: number
	/** stdout + stderr, for assertions that do not care which stream carried it. */
	output: string
}

interface RunOptions {
	home?: string
	env?: Record<string, string>
}

const tempHomes: string[] = []
let sharedHome = ''

/** Creates a throwaway $HOME, optionally seeded with `~/.omd/config.json`. */
function makeHome(config?: Record<string, unknown>): string {
	return makeHomeWithRawConfig(config === undefined ? undefined : JSON.stringify(config, null, 2))
}

/** Same, but writes the config file byte-for-byte (used for malformed JSON). */
function makeHomeWithRawConfig(raw?: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'omd-cli-home-'))
	tempHomes.push(dir)
	if (raw !== undefined) {
		mkdirSync(join(dir, '.omd'), { recursive: true })
		writeFileSync(join(dir, '.omd', 'config.json'), raw)
	}
	return dir
}

function configFileFor(home: string): string {
	return join(home, '.omd', 'config.json')
}

function runCli(args: string[], options: RunOptions = {}): Promise<CliResult> {
	const home = options.home ?? sharedHome
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (!STRIPPED_ENV.has(key)) env[key] = value
	}
	env.HOME = home
	env.USERPROFILE = home
	for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value

	return new Promise<CliResult>((resolvePromise, rejectPromise) => {
		execFile(
			process.execPath,
			[CLI_PATH, ...args],
			{ cwd: home, env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const failure = error as (ExecFileException & { code?: number | string }) | null
				if (failure?.signal) {
					rejectPromise(new Error(`omd ${args.join(' ')} was killed by ${failure.signal}`))
					return
				}
				const code = failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0
				resolvePromise({ stdout, stderr, code, output: stdout + stderr })
			},
		)
	})
}

function newestMtimeMs(dir: string): number {
	let newest = 0
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs)
	}
	return newest
}

/** `| a | b |` -> `['a', 'b']` */
function splitTableRow(line: string): string[] {
	return line
		.split('|')
		.slice(1, -1)
		.map((cell) => cell.trim())
}

/** Parses a markdown table into one record per data row, keyed by header. */
function parseMarkdownTable(text: string): Record<string, string>[] {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('|'))
	if (lines.length < 2) return []
	const headers = splitTableRow(lines[0])
	return lines.slice(2).map((line) => {
		const cells = splitTableRow(line)
		const row: Record<string, string> = {}
		headers.forEach((header, i) => {
			row[header] = cells[i] ?? ''
		})
		return row
	})
}

/** Names listed under the `Commands:` section of a commander help screen. */
function parseCommandNames(help: string): string[] {
	const section = help.split(/^Commands:$/m)[1]
	if (!section) return []
	return section
		.split('\n')
		.map((line) => /^ {2}(\S+)/.exec(line)?.[1])
		.filter((name): name is string => name !== undefined)
}

beforeAll(() => {
	sharedHome = makeHome()
	const builtAt = existsSync(CLI_PATH) ? statSync(CLI_PATH).mtimeMs : 0
	if (builtAt <= newestMtimeMs(join(REPO_ROOT, 'src'))) {
		execFileSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'pipe' })
	}
	expect(existsSync(CLI_PATH)).toBe(true)
}, 300_000)

afterAll(() => {
	for (const dir of tempHomes) rmSync(dir, { recursive: true, force: true })
})

describe('omd --version', { timeout: SPAWN_TIMEOUT }, () => {
	it('prints the version from package.json on stdout and exits 0', async () => {
		const result = await runCli(['--version'])

		expect(result.code).toBe(0)
		expect(result.stdout.trim()).toBe(PKG.version)
		expect(result.stderr).toBe('')
	})

	it('prints a semver-shaped version, not an empty string', async () => {
		const result = await runCli(['--version'])

		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
	})

	it('accepts the -V short flag (-v is taken by --verbose)', async () => {
		const long = await runCli(['--version'])
		const short = await runCli(['-V'])

		expect(short.code).toBe(0)
		expect(short.stdout).toBe(long.stdout)
	})
})

describe('omd --help', { timeout: SPAWN_TIMEOUT }, () => {
	it('exits 0 and writes the help screen to stdout', async () => {
		const result = await runCli(['--help'])

		expect(result.code).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toContain('Usage: omd [options] [command]')
		expect(result.stdout).toContain('Unified CLI for free financial data APIs')
	})

	it('lists every top-level command in registration order', async () => {
		const result = await runCli(['--help'])

		expect(parseCommandNames(result.stdout)).toEqual([...TOP_LEVEL_COMMANDS, 'help'])
	})

	it('describes each main command', async () => {
		const result = await runCli(['--help'])

		expect(result.stdout).toContain('Search for companies, tickers, or assets')
		expect(result.stdout).toContain('Get stock/asset quotes')
		expect(result.stdout).toContain('Macroeconomic data from FRED')
		expect(result.stdout).toContain('Cryptocurrency market data')
		expect(result.stdout).toContain('List data sources, capabilities, and status')
		expect(result.stdout).toContain('Manage configuration')
	})

	it('documents every global option', async () => {
		const result = await runCli(['--help'])

		for (const flag of [
			'--json',
			'--plain',
			'-v, --verbose',
			'-s, --source <source>',
			'--no-cache',
		]) {
			expect(result.stdout).toContain(flag)
		}
	})

	it('shows per-command help via `help <command>`', async () => {
		const result = await runCli(['help', 'macro'])

		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Usage: omd macro [options] [command]')
		expect(parseCommandNames(result.stdout)).toEqual(['search', 'get', 'help'])
	})

	it('prints help on stderr and exits 1 when invoked with no arguments', async () => {
		const result = await runCli([])

		expect(result.code).toBe(1)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('Usage: omd [options] [command]')
	})
})

describe('unknown input', { timeout: SPAWN_TIMEOUT }, () => {
	it('exits non-zero and names the unknown command', async () => {
		const result = await runCli(['frobnicate'])

		expect(result.code).toBe(1)
		expect(result.stdout).toBe('')
		expect(result.stderr).toMatch(/unknown command/i)
		expect(result.stderr).toContain('frobnicate')
	})

	it('exits non-zero for an unknown global option', async () => {
		const result = await runCli(['--totally-bogus', 'sources'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/unknown option/i)
		expect(result.stderr).toContain('--totally-bogus')
	})

	it('exits non-zero for an unknown option on a subcommand', async () => {
		const result = await runCli(['sources', '--totally-bogus'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/unknown option/i)
	})

	it('exits non-zero for an unknown config subcommand', async () => {
		const result = await runCli(['config', 'bogus'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/unknown command/i)
	})

	it('rejects extra positional arguments', async () => {
		const result = await runCli(['sources', 'extra'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/too many arguments/i)
	})

	it('rejects a command that is missing its required argument', async () => {
		const result = await runCli(['quote'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/missing required argument/i)
		expect(result.stderr).toContain('symbols')
	})

	it('rejects `search` with no query', async () => {
		const result = await runCli(['search'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/missing required argument/i)
		expect(result.stderr).toContain('query')
	})
})

describe('omd sources', { timeout: SPAWN_TIMEOUT }, () => {
	it('exits 0 and lists all eight providers as a markdown table', async () => {
		const result = await runCli(['sources'])

		expect(result.code).toBe(0)
		expect(result.stderr).toBe('')
		const rows = parseMarkdownTable(result.stdout)
		expect(rows.map((row) => row.Source)).toEqual(PROVIDER_NAMES)
	})

	it('marks keyless providers enabled and keyed providers disabled when no key is set', async () => {
		const result = await runCli(['sources'], { home: makeHome() })

		const rows = parseMarkdownTable(result.stdout)
		const byName = new Map(rows.map((row) => [row.Source, row]))
		for (const name of ['sec-edgar', 'yahoo', 'binance', 'worldbank']) {
			expect(byName.get(name)).toMatchObject({ Status: 'enabled', 'API Key': 'none' })
		}
		for (const name of ['coingecko', 'fred', 'finnhub', 'alphavantage']) {
			expect(byName.get(name)).toMatchObject({ Status: 'disabled', 'API Key': 'missing' })
		}
	})

	it('reports each provider category list and rate-limit window', async () => {
		const result = await runCli(['sources'])

		const byName = new Map(parseMarkdownTable(result.stdout).map((row) => [row.Source, row]))
		// windowMs < 2000 -> "sec", < 120_000 -> "min", otherwise "day"
		expect(byName.get('sec-edgar')).toMatchObject({
			Categories: 'search, financials, filing, insiders',
			'Rate Limit': '10/sec',
		})
		expect(byName.get('binance')).toMatchObject({ Categories: 'crypto', 'Rate Limit': '1200/min' })
		expect(byName.get('alphavantage')?.['Rate Limit']).toBe('25/day')
		expect(byName.get('yahoo')?.Categories).toBe(
			'search, quote, financials, history, options, earnings, dividends',
		)
	})

	it('flips a keyed provider to enabled when its env var is present', async () => {
		const result = await runCli(['sources'], {
			home: makeHome(),
			env: { FRED_API_KEY: 'env0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
		})

		const byName = new Map(parseMarkdownTable(result.stdout).map((row) => [row.Source, row]))
		expect(byName.get('fred')).toMatchObject({ Status: 'enabled', 'API Key': 'configured' })
		expect(byName.get('coingecko')?.Status).toBe('disabled')
	})

	it('flips a keyed provider to enabled when the key is in the config file', async () => {
		const home = makeHome({ coingeckoApiKey: 'CG-fileDemo1234567890abc' })
		const result = await runCli(['sources'], { home })

		const byName = new Map(parseMarkdownTable(result.stdout).map((row) => [row.Source, row]))
		expect(byName.get('coingecko')).toMatchObject({ Status: 'enabled', 'API Key': 'configured' })
	})

	it('still reports a config-disabled provider as enabled', async () => {
		// NOTE: suspected bug — `sources` only consults `provider.isEnabled()` and
		// ignores `config.disabledSources`, which the router *does* honour. A user
		// who disabled worldbank still sees it listed as "enabled" here, while
		// routing refuses to use it (see the macro test below).
		const home = makeHome({ disabledSources: ['worldbank'] })
		const result = await runCli(['sources'], { home })

		const byName = new Map(parseMarkdownTable(result.stdout).map((row) => [row.Source, row]))
		expect(byName.get('worldbank')?.Status).toBe('enabled')
	})

	it('survives a malformed config file', async () => {
		const home = makeHomeWithRawConfig('{ this is not json')
		const result = await runCli(['sources'], { home })

		expect(result.code).toBe(0)
		expect(parseMarkdownTable(result.stdout)).toHaveLength(PROVIDER_NAMES.length)
	})
})

describe('global output flags', { timeout: SPAWN_TIMEOUT }, () => {
	it('accepts --json and emits parseable JSON', async () => {
		const result = await runCli(['--json', 'sources'])

		expect(result.code).toBe(0)
		const parsed = JSON.parse(result.stdout) as Record<string, string>[]
		expect(parsed.map((row) => row.Source)).toEqual(PROVIDER_NAMES)
		expect(parsed[0]).toHaveProperty('Rate Limit')
	})

	it('accepts --json after the subcommand too', async () => {
		const before = await runCli(['--json', 'sources'])
		const after = await runCli(['sources', '--json'])

		expect(after.code).toBe(0)
		expect(after.stdout).toBe(before.stdout)
	})

	it('accepts --plain and emits tab-separated values', async () => {
		const result = await runCli(['--plain', 'sources'])

		expect(result.code).toBe(0)
		const lines = result.stdout.trim().split('\n')
		expect(lines[0].split('\t')).toEqual([
			'Source',
			'Status',
			'API Key',
			'Categories',
			'Rate Limit',
		])
		expect(lines).toHaveLength(PROVIDER_NAMES.length + 1)
		expect(lines[1].split('\t')[0]).toBe('sec-edgar')
		expect(result.stdout).not.toContain('|')
	})

	it('lets --json win when both --json and --plain are given', async () => {
		const result = await runCli(['--json', '--plain', 'sources'])

		expect(result.code).toBe(0)
		expect(() => JSON.parse(result.stdout)).not.toThrow()
	})

	it('defaults to the markdown table when no format flag is given', async () => {
		const result = await runCli(['sources'])

		expect(result.stdout.trimStart().startsWith('| Source')).toBe(true)
	})

	it('accepts --no-cache and --verbose, and neither changes a byte of the output', async () => {
		// NOTE: two confirmed bugs, neither of which is observable from outside the
		// process, so this test pins the part that is: both flags parse and are
		// inert.
		//   1. `.option('--no-cache', ...)` (src/cli.ts:35) makes commander store the
		//      negated flag as `opts.cache` — true by default, false when given —
		//      while every command builds its RouteOptions from `opts.noCache`
		//      (e.g. src/commands/search.ts:18), which is never populated. `route()`
		//      therefore always takes its cache path; the flag cannot bypass it.
		//      A cache hit cannot be shown here: the cache is in-process and only a
		//      successful (networked) route ever fills it.
		//   2. `--verbose` is parsed but no command forwards it into the provider
		//      args, so the `args.verbose` branches in yahoo-finance.ts are dead from
		//      the CLI and the flag prints nothing extra.
		const plain = await runCli(['sources'])
		const flagged = await runCli(['--no-cache', '--verbose', 'sources'])

		expect(flagged.code).toBe(0)
		expect(flagged.stderr).toBe('')
		expect(flagged.stdout).toBe(plain.stdout)
		expect(parseMarkdownTable(flagged.stdout)).toHaveLength(PROVIDER_NAMES.length)
	})
})

describe('omd --source', { timeout: SPAWN_TIMEOUT }, () => {
	it('fails when the forced source does not exist', async () => {
		const result = await runCli(['--source', 'nosuchsource', 'quote', 'AAPL'])

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Source "nosuchsource" not available for category "quote"')
	})

	it('fails when the forced source lacks the requested capability', async () => {
		const result = await runCli(['-s', 'binance', 'quote', 'AAPL'])

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Source "binance" not available for category "quote"')
	})

	it('fails when the forced source cannot serve the category', async () => {
		const result = await runCli(['--source', 'yahoo', 'filing', 'AAPL'])

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Source "yahoo" not available for category "filing"')
	})
})

describe('omd macro', { timeout: SPAWN_TIMEOUT }, () => {
	/** worldbank is keyless and serves `macro`; disabling it keeps the run offline. */
	const macroHome = () => makeHome({ disabledSources: ['worldbank'] })

	it('exits non-zero and points at `omd config set fredApiKey` with no key', async () => {
		const result = await runCli(['macro', 'GDP'], { home: macroHome() })

		expect(result.code).toBe(1)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('omd config set fredApiKey')
		expect(result.stderr).toContain('FRED_API_KEY')
		expect(result.stderr).toMatch(/No providers available for "macro"/)
	})

	it('explains why each macro provider is unavailable', async () => {
		const result = await runCli(['macro', 'UNRATE'], { home: macroHome() })

		expect(result.stderr).toContain('fred: requires FRED_API_KEY')
		expect(result.stderr).toContain('worldbank: disabled in config')
	})

	it('prefixes the routing failure with `Error:`', async () => {
		const result = await runCli(['macro', 'CPIAUCSL'], { home: macroHome() })

		expect(result.stderr.startsWith('Error: ')).toBe(true)
	})

	it('fails when fred is forced but unconfigured', async () => {
		// NOTE: suspected bug (minor) — forcing an unconfigured source skips the
		// router's helpful "run: omd config set ..." hint entirely.
		const result = await runCli(['--source', 'fred', 'macro', 'GDP'])

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Source "fred" not available for category "macro"')
		expect(result.stderr).not.toContain('omd config set fredApiKey')
	})

	it('prints macro help and exits 0 when no series id is given', async () => {
		const result = await runCli(['macro'])

		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Usage: omd macro [options] [command]')
		expect(result.stdout).toContain('Get time series data')
	})
})

describe('omd crypto', { timeout: SPAWN_TIMEOUT }, () => {
	it('exits non-zero and mentions CoinGecko for `crypto top` with no key', async () => {
		const result = await runCli(['crypto', 'top'], { home: makeHome() })

		expect(result.code).toBe(1)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('CoinGecko')
		expect(result.stderr).toContain('omd config set coingeckoApiKey')
	})

	it('gives the same guidance when a limit argument is supplied', async () => {
		const result = await runCli(['crypto', 'top', '5'], { home: makeHome() })

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('omd config set coingeckoApiKey')
	})

	it('gives the same guidance when coingecko is forced but unconfigured', async () => {
		// The underlying failure is `Source "coingecko" not available ...`, but the
		// command reports the missing key instead — the actionable message.
		const result = await runCli(['--source', 'coingecko', 'crypto', 'top'], { home: makeHome() })

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Market rankings require CoinGecko')
	})

	it('prints crypto help and exits 0 when no symbol is given', async () => {
		const result = await runCli(['crypto'])

		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Usage: omd crypto [options] [command] [symbol]')
		expect(parseCommandNames(result.stdout)).toEqual(['top', 'history'])
	})
})

describe('omd config', { timeout: SPAWN_TIMEOUT }, () => {
	it('prints a config path inside the temp HOME', async () => {
		const home = makeHome()
		const result = await runCli(['config', 'path'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout.trim()).toBe(configFileFor(home))
		expect(result.stdout.trim().startsWith(home)).toBe(true)
	})

	it('shows an empty config for a fresh home', async () => {
		const home = makeHome()
		const result = await runCli(['config', 'show'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout).toContain(`Config file: ${configFileFor(home)}`)
		expect(result.stdout.trim().endsWith('{}')).toBe(true)
	})

	it('writes a key to the config file without echoing the secret', async () => {
		const home = makeHome()
		const result = await runCli(
			['config', 'set', 'fredApiKey', 'abcdef0123456789abcdef0123456789'],
			{
				home,
			},
		)

		expect(result.code).toBe(0)
		expect(result.stdout.trim()).toBe('Set fredApiKey = ***')
		expect(result.stdout).not.toContain('abcdef0123456789abcdef0123456789')
		const saved = JSON.parse(readFileSync(configFileFor(home), 'utf-8')) as Record<string, string>
		expect(saved).toEqual({ fredApiKey: 'abcdef0123456789abcdef0123456789' })
	})

	it('creates the config file without group or world permissions', async () => {
		const home = makeHome()
		await runCli(['config', 'set', 'fredApiKey', 'perm-check-key'], { home })

		expect(statSync(configFileFor(home)).mode & 0o077).toBe(0)
	})

	it('echoes non-secret values verbatim', async () => {
		const home = makeHome()
		const result = await runCli(
			['config', 'set', 'edgarUserAgent', 'Test Suite test@example.com'],
			{
				home,
			},
		)

		expect(result.code).toBe(0)
		expect(result.stdout.trim()).toBe('Set edgarUserAgent = Test Suite test@example.com')
	})

	it('merges successive sets instead of overwriting the file', async () => {
		const home = makeHome()
		await runCli(['config', 'set', 'fredApiKey', 'fred-key-value'], { home })
		await runCli(['config', 'set', 'coingeckoApiKey', 'CG-key-value'], { home })

		const saved = JSON.parse(readFileSync(configFileFor(home), 'utf-8')) as Record<string, string>
		expect(saved).toEqual({ fredApiKey: 'fred-key-value', coingeckoApiKey: 'CG-key-value' })
	})

	it('masks configured secrets in `config show`', async () => {
		const home = makeHome()
		await runCli(['config', 'set', 'fredApiKey', 'super-secret-fred-key'], { home })
		const result = await runCli(['config', 'show'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout).toContain('"fredApiKey": "***configured***"')
		expect(result.stdout).not.toContain('super-secret-fred-key')
	})

	it('makes a newly set key visible to `sources`', async () => {
		const home = makeHome()
		await runCli(['config', 'set', 'finnhubApiKey', 'cfile7b9r01qhq0c1k2mg'], { home })
		const result = await runCli(['sources'], { home })

		const byName = new Map(parseMarkdownTable(result.stdout).map((row) => [row.Source, row]))
		expect(byName.get('finnhub')).toMatchObject({ Status: 'enabled', 'API Key': 'configured' })
	})

	it('rejects an unknown config key and lists the valid ones', async () => {
		const home = makeHome()
		const result = await runCli(['config', 'set', 'bogusKey', 'value'], { home })

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Invalid key: bogusKey')
		expect(result.stderr).toContain('fredApiKey')
		expect(result.stderr).toContain('defaultFormat')
		expect(existsSync(configFileFor(home))).toBe(false)
	})

	it('rejects `config set` with a missing value argument', async () => {
		const result = await runCli(['config', 'set', 'fredApiKey'])

		expect(result.code).toBe(1)
		expect(result.stderr).toMatch(/missing required argument/i)
		expect(result.stderr).toContain('value')
	})

	it('lets an env var override the value stored in the config file', async () => {
		const home = makeHome({ edgarUserAgent: 'File Agent file@example.com' })
		const result = await runCli(['config', 'show'], {
			home,
			env: { EDGAR_USER_AGENT: 'Env Agent env@example.com' },
		})

		expect(result.stdout).toContain('Env Agent env@example.com')
		expect(result.stdout).not.toContain('File Agent file@example.com')
	})

	it('ignores a malformed config file instead of crashing', async () => {
		const home = makeHomeWithRawConfig('not json{')
		const result = await runCli(['config', 'show'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout.trim().endsWith('{}')).toBe(true)
	})

	it('prints config help and exits 1 when no subcommand is given', async () => {
		const result = await runCli(['config'])

		expect(result.code).toBe(1)
		expect(parseCommandNames(result.output)).toEqual(['show', 'set', 'path', 'help'])
	})

	it('emits a non-JSON preamble from `config show` even under --json', async () => {
		// NOTE: suspected bug — `config show` ignores the global format flag, so
		// `omd --json config show` cannot be piped into a JSON parser.
		const home = makeHome()
		const result = await runCli(['--json', 'config', 'show'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout.startsWith('Config file:')).toBe(true)
		expect(() => JSON.parse(result.stdout)).toThrow()
	})

	it('ignores a stored defaultFormat when rendering output', async () => {
		// NOTE: suspected bug — `defaultFormat` is an accepted config key, but the
		// preAction hook only ever looks at the CLI flags, so the stored value is
		// inert: output stays markdown.
		const home = makeHome({ defaultFormat: 'plain' })
		const result = await runCli(['sources'], { home })

		expect(result.code).toBe(0)
		expect(result.stdout.trimStart().startsWith('| Source')).toBe(true)
	})
})
