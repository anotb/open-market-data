import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const expectedVersion = JSON.parse(
	readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
).version
const live = process.argv.includes('--live')
const suppliedTarball = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
let createdTarball = false
let tarball
let temporaryProject

try {
	if (suppliedTarball) {
		tarball = resolve(suppliedTarball)
	} else {
		const output = run(commandShim('npm'), ['pack', '--silent'], repositoryRoot).stdout
		const filename = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
		assert(filename, 'npm pack did not report a tarball filename')
		tarball = resolve(repositoryRoot, filename)
		createdTarball = true
	}

	assert(existsSync(tarball), `Tarball does not exist: ${tarball}`)
	const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/)
	const requiredEntries = [
		'package/package.json',
		'package/dist/index.js',
		'package/dist/index.d.ts',
		'package/dist/cli.js',
		'package/dist/mcp-cli.js',
		'package/dist/package-cli.js',
		'package/dist/mcp/index.js',
		'package/dist/webmcp.js',
		'package/plugin.json',
		'package/mcp.json',
		'package/.mcp.json',
		'package/.codex-plugin/plugin.json',
		'package/skills/open-market-data/SKILL.md',
		'package/server.json',
		'package/README.md',
	]
	for (const entry of requiredEntries) {
		assert(entries.includes(entry), `Packed artifact is missing ${entry}`)
	}
	for (const entry of entries) {
		assert(
			!/(^|\/)(?:\.env(?:\.|$)|node_modules|src|tests|coverage|\.omd)(?:\/|$)/.test(entry),
			`Packed artifact contains development or secret-bearing path ${entry}`,
		)
	}

	temporaryProject = mkdtempSync(join(tmpdir(), 'open-market-data-package-smoke-'))
	writeFileSync(
		join(temporaryProject, 'package.json'),
		`${JSON.stringify({ name: 'open-market-data-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
	)
	run(
		commandShim('npm'),
		['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
		temporaryProject,
	)

	const installedPackageRoot = join(temporaryProject, 'node_modules', 'open-market-data')
	for (const manifestName of ['mcp.json', '.mcp.json']) {
		const manifest = JSON.parse(readFileSync(join(installedPackageRoot, manifestName), 'utf8'))
		const servers = manifest.mcpServers ?? manifest
		const server = servers['open-market-data']
		const resolvedArgs = server.args.map((argument) =>
			argument.replaceAll('${PLUGIN_ROOT}', installedPackageRoot),
		)
		for (const argument of resolvedArgs.filter((argument) =>
			argument.startsWith(installedPackageRoot),
		)) {
			assert(existsSync(argument), `${manifestName} resolves to missing runtime path ${argument}`)
		}
		if (server.cwd) {
			const resolvedCwd = server.cwd.replaceAll('${PLUGIN_ROOT}', installedPackageRoot)
			assert(existsSync(resolvedCwd), `${manifestName} resolves to missing cwd ${resolvedCwd}`)
		}
	}

	const binaryDirectory = join(temporaryProject, 'node_modules', '.bin')
	const omd = join(binaryDirectory, commandShim('omd'))
	const mcp = join(binaryDirectory, commandShim('omd-mcp'))
	const packageBinary = join(binaryDirectory, commandShim('open-market-data'))
	for (const binary of [omd, mcp, packageBinary]) {
		assert(existsSync(binary), `Installed binary is missing: ${binary}`)
	}

	assert(
		run(omd, ['--version'], temporaryProject).stdout.trim() === expectedVersion,
		'omd version mismatch',
	)
	const sourcesJson = JSON.parse(run(omd, ['--json', 'sources'], temporaryProject).stdout)
	assert(
		Array.isArray(sourcesJson) && sourcesJson.length === 8,
		'omd --json sources must list eight providers',
	)
	assert(
		run(omd, ['sources'], temporaryProject).stdout.includes('sec-edgar'),
		'human sources output is incomplete',
	)
	assert(
		run(omd, ['--plain', 'sources'], temporaryProject).stdout.includes('worldbank'),
		'plain sources output is incomplete',
	)
	const configJson = JSON.parse(run(omd, ['--json', 'config', 'show'], temporaryProject).stdout)
	assert(configJson.configFile && configJson.config, 'config show JSON framing failed')
	const configPathJson = JSON.parse(run(omd, ['--json', 'config', 'path'], temporaryProject).stdout)
	assert(configPathJson.configFile === configJson.configFile, 'config path JSON framing failed')
	assert(
		run(packageBinary, ['--version'], temporaryProject).stdout.trim() === expectedVersion,
		'package binary version mismatch',
	)
	assert(
		run(
			commandShim('npx'),
			['--no-install', 'open-market-data', '--version'],
			temporaryProject,
		).stdout.trim() === expectedVersion,
		'npx package binary behavior failed',
	)

	const sdkSmokePath = join(temporaryProject, 'sdk-smoke.mjs')
	writeFileSync(
		sdkSmokePath,
		`import { createOpenMarketDataClient, openMarketData } from 'open-market-data'
import * as mcp from 'open-market-data/mcp'
import * as webmcp from 'open-market-data/webmcp'
const client = createOpenMarketDataClient()
if (client.listTools().length !== 17) throw new Error('SDK tool catalog mismatch')
const status = await client.providers()
if (status.data.length !== 8) throw new Error('SDK provider auto-registration failed')
if (openMarketData.listTools().length !== 17) throw new Error('default SDK client mismatch')
if (typeof mcp.createMcpMessageHandler !== 'function') throw new Error('MCP export missing')
if (typeof webmcp.registerOpenMarketDataWebMcp !== 'function') throw new Error('WebMCP export missing')
`,
	)
	run(process.execPath, [sdkSmokePath], temporaryProject)

	const rpcInput = [
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		{
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'provider_status', arguments: {} },
		},
		{
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'stock_quotes', arguments: { symbols: [] } },
		},
	]
		.map((request) => JSON.stringify(request))
		.join('\n')
	const rpc = run(mcp, [], temporaryProject, `${rpcInput}\n`)
	const responses = rpc.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line))
	assert(responses.length === 4, `Expected four MCP responses, received ${responses.length}`)
	assert(
		responses[0].result?.serverInfo?.version === expectedVersion,
		'MCP server metadata mismatch',
	)
	assert(responses[1].result?.tools?.length === 17, 'MCP tools/list mismatch')
	assert(
		responses[2].result?.structuredContent?.data?.length === 8,
		'MCP provider_status call failed',
	)
	assert(responses[3].result?.isError === true, 'MCP malformed tool input was not rejected')
	assert(rpc.stderr === '', `MCP diagnostics corrupted a clean smoke run: ${rpc.stderr}`)
	if (live) runLivePackageSmoke({ temporaryProject, omd, mcp })

	process.stdout.write(
		`Package${live ? ' live' : ''} smoke passed: ${basename(tarball)} (${entries.length} entries)\n`,
	)
} finally {
	if (temporaryProject) rmSync(temporaryProject, { recursive: true, force: true })
	if (createdTarball && tarball && existsSync(tarball)) rmSync(tarball)
}

function run(command, args, cwd, input) {
	const usesWindowsCommandShim = process.platform === 'win32' && command.endsWith('.cmd')
	const executable = usesWindowsCommandShim ? (process.env.ComSpec ?? 'cmd.exe') : command
	const executableArgs = usesWindowsCommandShim ? ['/d', '/s', '/c', command, ...args] : args
	const result = spawnSync(executable, executableArgs, {
		cwd,
		encoding: 'utf8',
		input,
		maxBuffer: 10 * 1024 * 1024,
		timeout: 180_000,
	})
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed with exit ${result.status}: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
		)
	}
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function commandShim(command) {
	return process.platform === 'win32' ? `${command}.cmd` : command
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

function runLivePackageSmoke({ temporaryProject, omd, mcp }) {
	const search = run(
		omd,
		['--plain', '--source', 'yahoo', 'search', 'Microsoft'],
		temporaryProject,
	).stdout
	assert(search.includes('MSFT'), 'installed CLI live search did not return MSFT')

	const cliCases = [
		['--json', '--source', 'yahoo', '--no-cache', 'quote', 'AAPL'],
		[
			'--json',
			'--source',
			'sec-edgar',
			'--no-cache',
			'filing',
			'AAPL',
			'--type',
			'10-K',
			'--latest',
		],
		['--json', '--no-cache', 'crypto', 'BTC'],
		[
			'--json',
			'--source',
			'worldbank',
			'--no-cache',
			'macro',
			'get',
			'NY.GDP.MKTP.CD',
			'--country',
			'US',
			'--limit',
			'2',
		],
		['--json', 'doctor', 'yahoo'],
	]
	for (const args of cliCases) {
		const output = run(omd, args, temporaryProject).stdout
		assert(
			output.trim().startsWith('[') || output.trim().startsWith('{'),
			`CLI JSON framing failed: ${args.join(' ')}`,
		)
		JSON.parse(output)
	}

	const sdkLivePath = join(temporaryProject, 'sdk-live-smoke.mjs')
	writeFileSync(
		sdkLivePath,
		`import { createOpenMarketDataClient } from 'open-market-data'
const client = createOpenMarketDataClient()
const quote = await client.quotes(['AAPL'], { source: ' YAHOO ', noCache: true })
if (quote.meta.source !== 'yahoo' || quote.data[0]?.price <= 0) throw new Error('SDK quote failed')
const filings = await client.filings({ symbol: 'AAPL', type: '10-K', latest: true, limit: 1, source: 'sec-edgar', noCache: true })
if (filings.meta.source !== 'sec-edgar' || filings.data.length !== 1) throw new Error('SDK filing failed')
const crypto = await client.cryptoQuote({ symbol: 'BTC', noCache: true })
if (!crypto.meta.source || crypto.data.price <= 0) throw new Error('SDK crypto failed')
const macro = await client.macroSeries({ seriesId: 'NY.GDP.MKTP.CD', country: 'US', limit: 2, source: 'worldbank', noCache: true })
if (macro.meta.source !== 'worldbank' || macro.data.data.length === 0) throw new Error('SDK macro failed')
const snapshot = await client.snapshot({ symbol: 'AAPL', historyDays: 10, financialPeriods: 2, filingLimit: 2, noCache: true })
if (snapshot.data.quote?.price <= 0 || !snapshot.meta.sources?.length) throw new Error('SDK snapshot failed')
const health = await client.health({ sources: ['yahoo', 'sec-edgar', 'worldbank'] })
if (health.data.length !== 3 || health.data.some((item) => !item.probe)) throw new Error('SDK health failed')
for (const item of health.data.filter((entry) => entry.status !== 'ok')) {
  if (!item.message || !item.recommendedAction) throw new Error('SDK health guidance missing')
}
`,
	)
	run(process.execPath, [sdkLivePath], temporaryProject)

	const protocolVersion = 'io.modelcontextprotocol/protocolVersion'
	const clientInfo = 'io.modelcontextprotocol/clientInfo'
	const clientCapabilities = 'io.modelcontextprotocol/clientCapabilities'
	const modernParams = (fields = {}) => ({
		...fields,
		_meta: {
			[protocolVersion]: '2026-07-28',
			[clientInfo]: { name: 'package-live-smoke', version: '1.0.0' },
			[clientCapabilities]: {},
		},
	})
	const liveRequests = [
		{ jsonrpc: '2.0', id: 100, method: 'server/discover', params: modernParams() },
		{ jsonrpc: '2.0', id: 101, method: 'tools/list', params: modernParams() },
		{
			jsonrpc: '2.0',
			id: 102,
			method: 'tools/call',
			params: modernParams({
				name: 'stock_quotes',
				arguments: { symbols: ['AAPL'], source: 'yahoo', noCache: true },
			}),
		},
		{
			jsonrpc: '2.0',
			id: 103,
			method: 'tools/call',
			params: modernParams({
				name: 'sec_filings',
				arguments: {
					symbol: 'AAPL',
					type: '10-K',
					latest: true,
					limit: 1,
					source: 'sec-edgar',
					noCache: true,
				},
			}),
		},
		{
			jsonrpc: '2.0',
			id: 104,
			method: 'tools/call',
			params: modernParams({
				name: 'crypto_quote',
				arguments: { symbol: 'BTC', noCache: true },
			}),
		},
		{
			jsonrpc: '2.0',
			id: 105,
			method: 'tools/call',
			params: modernParams({
				name: 'macro_series',
				arguments: {
					seriesId: 'NY.GDP.MKTP.CD',
					country: 'US',
					limit: 2,
					source: 'worldbank',
					noCache: true,
				},
			}),
		},
		{
			jsonrpc: '2.0',
			id: 106,
			method: 'tools/call',
			params: modernParams({
				name: 'company_snapshot',
				arguments: {
					symbol: 'AAPL',
					historyDays: 10,
					financialPeriods: 2,
					filingLimit: 2,
					noCache: true,
				},
			}),
		},
		{
			jsonrpc: '2.0',
			id: 107,
			method: 'tools/call',
			params: modernParams({
				name: 'provider_health',
				arguments: { sources: ['yahoo', 'sec-edgar', 'worldbank'] },
			}),
		},
	]
	const liveRpc = run(
		mcp,
		[],
		temporaryProject,
		`${liveRequests.map((request) => JSON.stringify(request)).join('\n')}\n`,
	)
	const liveResponses = liveRpc.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line))
	assert(liveResponses.length === liveRequests.length, 'modern MCP response count mismatch')
	assert(
		liveResponses[0].result?.supportedVersions?.includes('2026-07-28'),
		'modern MCP discovery failed',
	)
	assert(liveResponses[1].result?.tools?.length === 17, 'modern MCP tools/list failed')
	for (const response of liveResponses.slice(2)) {
		assert(response.result?.isError !== true, `modern MCP tool call ${response.id} failed`)
		assert(
			response.result?.structuredContent?.meta,
			`modern MCP tool call ${response.id} lost metadata`,
		)
	}
}
