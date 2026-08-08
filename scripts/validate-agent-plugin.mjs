#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const MCP_REGISTRY_SCHEMA =
	'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
const PLUGIN_FIELDS = new Set([
	'$schema',
	'name',
	'version',
	'description',
	'author',
	'homepage',
	'repository',
	'license',
	'keywords',
	'extensions',
])
const SKILL_FIELDS = new Set([
	'name',
	'description',
	'license',
	'compatibility',
	'metadata',
	'allowed-tools',
])

function fail(message) {
	throw new Error(`Agent Plugin validation failed: ${message}`)
}

function readJson(relativePath) {
	const path = join(ROOT, relativePath)
	if (!existsSync(path)) fail(`${relativePath} is missing`)
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(
			`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

function assertObject(value, label) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} must be an object`)
	}
}

function assertString(value, label, { nonEmpty = true } = {}) {
	if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) {
		fail(`${label} must be a non-empty string`)
	}
}

function assertExactFields(object, allowed, label) {
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) fail(`${label} contains unsupported field ${JSON.stringify(key)}`)
	}
}

function validatePluginManifest(plugin) {
	assertObject(plugin, 'plugin.json')
	assertExactFields(plugin, PLUGIN_FIELDS, 'plugin.json')
	if (plugin.$schema !== PLUGIN_SCHEMA) fail('plugin.json uses the wrong canonical schema')
	assertString(plugin.name, 'plugin.json name')
	if (plugin.name.length > 64) fail('plugin.json name exceeds 64 characters')
	if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(plugin.name)) {
		fail('plugin.json name violates Agent Plugins naming rules')
	}
	for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
		if (plugin[field] !== undefined) assertString(plugin[field], `plugin.json ${field}`)
	}
	if (plugin.author !== undefined) {
		assertObject(plugin.author, 'plugin.json author')
		assertExactFields(plugin.author, new Set(['name', 'email', 'url']), 'plugin.json author')
		for (const [key, value] of Object.entries(plugin.author)) {
			assertString(value, `plugin.json author.${key}`, { nonEmpty: false })
		}
	}
	if (plugin.keywords !== undefined) {
		if (
			!Array.isArray(plugin.keywords) ||
			plugin.keywords.some((value) => typeof value !== 'string')
		) {
			fail('plugin.json keywords must be an array of strings')
		}
	}
	if (plugin.extensions !== undefined) assertObject(plugin.extensions, 'plugin.json extensions')
}

function validatePortableMcp(config) {
	assertObject(config, 'mcp.json')
	assertExactFields(config, new Set(['$schema', 'mcpServers']), 'mcp.json')
	if (config.$schema !== MCP_SCHEMA) fail('mcp.json uses the wrong canonical schema')
	assertObject(config.mcpServers, 'mcp.json mcpServers')
	if (Object.keys(config.mcpServers).length === 0) fail('mcp.json must declare at least one server')
	for (const [name, server] of Object.entries(config.mcpServers)) {
		assertObject(server, `mcp.json server ${name}`)
		assertExactFields(
			server,
			new Set(['type', 'command', 'args', 'env', 'cwd']),
			`mcp.json server ${name}`,
		)
		if (server.type !== 'stdio') fail(`mcp.json server ${name} must use stdio`)
		assertString(server.command, `mcp.json server ${name} command`)
		if (server.command.includes(' '))
			fail(`mcp.json server ${name} command must be one executable token`)
		if (server.command.startsWith('.') && !server.command.startsWith('./')) {
			fail(`mcp.json server ${name} plugin-relative command must start with ./`)
		}
		if (server.args !== undefined) {
			if (!Array.isArray(server.args) || server.args.some((value) => typeof value !== 'string')) {
				fail(`mcp.json server ${name} args must be an array of strings`)
			}
		}
		if (server.env !== undefined) {
			assertObject(server.env, `mcp.json server ${name} env`)
			for (const [key, value] of Object.entries(server.env)) {
				assertString(key, `mcp.json server ${name} env key`)
				assertString(value, `mcp.json server ${name} env.${key}`, { nonEmpty: false })
				if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
					fail(`mcp.json server ${name} must not override reserved ${key}`)
				}
			}
		}
		if (server.cwd !== undefined) {
			assertString(server.cwd, `mcp.json server ${name} cwd`)
			if (
				!(
					server.cwd.startsWith('./') ||
					server.cwd.startsWith('${PLUGIN_ROOT}') ||
					server.cwd.startsWith('${PLUGIN_DATA}')
				)
			) {
				fail(`mcp.json server ${name} cwd is not plugin- or data-rooted`)
			}
		}
	}
}

function parseSkillFrontmatter(path) {
	const content = readFileSync(path, 'utf8')
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
	if (!match) fail('SKILL.md must start with YAML frontmatter')
	const fields = new Map()
	let currentMap = null
	for (const rawLine of match[1].split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
		const indent = rawLine.match(/^\s*/)?.[0].length ?? 0
		const line = rawLine.trim()
		const separator = line.indexOf(':')
		if (separator < 1) fail(`SKILL.md contains unsupported YAML line: ${line}`)
		const key = line.slice(0, separator).trim()
		const value = line.slice(separator + 1).trim()
		if (indent === 0) {
			if (!SKILL_FIELDS.has(key))
				fail(`SKILL.md contains unsupported frontmatter field ${JSON.stringify(key)}`)
			if (fields.has(key)) fail(`SKILL.md repeats frontmatter field ${JSON.stringify(key)}`)
			if (key === 'metadata') {
				if (value !== '') fail('SKILL.md metadata must be a mapping')
				currentMap = new Map()
				fields.set(key, currentMap)
			} else {
				currentMap = null
				fields.set(key, unquote(value))
			}
		} else {
			if (indent !== 2 || currentMap === null)
				fail('SKILL.md only permits one metadata mapping level')
			if (value === '') fail(`SKILL.md metadata.${key} must be a string`)
			currentMap.set(key, unquote(value))
		}
	}
	return fields
}

function unquote(value) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1)
	}
	return value
}

function validateSkill() {
	const skillPath = join(ROOT, 'skills', 'open-market-data', 'SKILL.md')
	if (!existsSync(skillPath)) fail('skills/open-market-data/SKILL.md is missing')
	const fields = parseSkillFrontmatter(skillPath)
	if (fields.get('name') !== 'open-market-data')
		fail('SKILL.md name must match its parent directory')
	const description = fields.get('description')
	assertString(description, 'SKILL.md description')
	if (description.length > 1024) fail('SKILL.md description exceeds 1024 characters')
	const compatibility = fields.get('compatibility')
	if (compatibility !== undefined) {
		assertString(compatibility, 'SKILL.md compatibility')
		if (compatibility.length > 500) fail('SKILL.md compatibility exceeds 500 characters')
	}
	const metadata = fields.get('metadata')
	if (metadata !== undefined) {
		if (!(metadata instanceof Map)) fail('SKILL.md metadata must be a string-to-string mapping')
		for (const [key, value] of metadata) {
			assertString(key, 'SKILL.md metadata key')
			assertString(value, `SKILL.md metadata.${key}`, { nonEmpty: false })
		}
	}
	return fields
}

function validateCodexCompatibility(manifest, mcpConfig) {
	assertObject(manifest, '.codex-plugin/plugin.json')
	for (const field of ['name', 'version', 'description'])
		assertString(manifest[field], `.codex-plugin/plugin.json ${field}`)
	for (const field of ['skills', 'mcpServers']) {
		assertString(manifest[field], `.codex-plugin/plugin.json ${field}`)
		if (!manifest[field].startsWith('./'))
			fail(`.codex-plugin/plugin.json ${field} must start with ./`)
		const target = join(ROOT, manifest[field])
		if (!existsSync(target)) fail(`.codex-plugin/plugin.json ${field} target does not exist`)
	}
	assertObject(mcpConfig, '.mcp.json')
	const server = mcpConfig['open-market-data']
	assertObject(server, '.mcp.json open-market-data')
	assertString(server.command, '.mcp.json command')
	if (!Array.isArray(server.args) || server.args.some((value) => typeof value !== 'string')) {
		fail('.mcp.json args must be an array of strings')
	}
}

function validateMarketplace(marketplace) {
	assertObject(marketplace, '.agents/plugins/marketplace.json')
	assertString(marketplace.name, 'marketplace name')
	if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
		fail('marketplace must contain the open-market-data entry')
	}
	const entry = marketplace.plugins[0]
	assertObject(entry, 'marketplace plugin entry')
	if (entry.name !== 'open-market-data') fail('marketplace plugin name mismatch')
	assertObject(entry.source, 'marketplace source')
	if (entry.source.source !== 'npm' || entry.source.package !== 'open-market-data') {
		fail('marketplace source must install the published open-market-data npm package')
	}
	assertObject(entry.policy, 'marketplace policy')
	if (!['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'].includes(entry.policy.installation)) {
		fail('marketplace installation policy is invalid')
	}
	if (!['ON_INSTALL', 'ON_USE'].includes(entry.policy.authentication)) {
		fail('marketplace authentication policy is invalid')
	}
	assertString(entry.category, 'marketplace category')
}

function validateMcpRegistry(server, packageJson) {
	assertObject(server, 'server.json')
	if (server.$schema !== MCP_REGISTRY_SCHEMA) fail('server.json uses the wrong canonical schema')
	assertString(server.name, 'server.json name')
	if (server.name !== packageJson.mcpName) fail('server.json name must match package.json mcpName')
	if (!Array.isArray(server.packages) || server.packages.length !== 1) {
		fail('server.json must declare one npm package')
	}
	const registryPackage = server.packages[0]
	assertObject(registryPackage, 'server.json package')
	if (
		registryPackage.registryType !== 'npm' ||
		registryPackage.identifier !== packageJson.name ||
		registryPackage.version !== packageJson.version
	) {
		fail('server.json npm package identity or version does not match package.json')
	}
	assertObject(registryPackage.transport, 'server.json package transport')
	if (registryPackage.transport.type !== 'stdio') {
		fail('server.json package transport must be stdio')
	}
	if (registryPackage.environmentVariables !== undefined) {
		if (!Array.isArray(registryPackage.environmentVariables)) {
			fail('server.json environmentVariables must be an array')
		}
		for (const variable of registryPackage.environmentVariables) {
			assertObject(variable, 'server.json environment variable')
			assertString(variable.name, 'server.json environment variable name')
			assertString(variable.description, `server.json ${variable.name} description`)
			if (typeof variable.isRequired !== 'boolean' || typeof variable.isSecret !== 'boolean') {
				fail(`server.json ${variable.name} must declare boolean isRequired and isSecret`)
			}
		}
	}
}

const packageJson = readJson('package.json')
const pluginJson = readJson('plugin.json')
const portableMcp = readJson('mcp.json')
const codexManifest = readJson('.codex-plugin/plugin.json')
const codexMcp = readJson('.mcp.json')
const serverJson = readJson('server.json')
const marketplace = readJson('.agents/plugins/marketplace.json')

validatePluginManifest(pluginJson)
validatePortableMcp(portableMcp)
const skillFields = validateSkill()
validateCodexCompatibility(codexManifest, codexMcp)
validateMarketplace(marketplace)
validateMcpRegistry(serverJson, packageJson)

const versions = new Map([
	['package.json', packageJson.version],
	['plugin.json', pluginJson.version],
	['.codex-plugin/plugin.json', codexManifest.version],
	['server.json', serverJson.version],
	['SKILL.md metadata', skillFields.get('metadata')?.get('version')],
])
const expectedVersion = packageJson.version
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
	fail(`package.json version ${JSON.stringify(expectedVersion)} is not semantic version syntax`)
}
for (const [label, version] of versions) {
	if (version !== expectedVersion)
		fail(`${label} version ${JSON.stringify(version)} does not match ${expectedVersion}`)
}
if (packageJson.name !== pluginJson.name || packageJson.name !== codexManifest.name) {
	fail('package and plugin names do not match')
}
if (marketplace.plugins[0].source.version !== `^${expectedVersion}`) {
	fail('marketplace npm range does not match package.json version')
}
if (!existsSync(join(ROOT, 'src', 'mcp-cli.ts'))) fail('src/mcp-cli.ts is missing')
for (const required of ['plugin.json', 'mcp.json', '.codex-plugin', '.mcp.json', 'skills']) {
	if (!packageJson.files.includes(required)) fail(`package.json files omits ${required}`)
}
const portableServer = portableMcp.mcpServers['open-market-data']
if (!portableServer.args.includes('${PLUGIN_ROOT}/dist/mcp-cli.js')) {
	fail('portable MCP server does not target the packaged MCP entry point')
}
if (!codexMcp['open-market-data'].args.includes('${PLUGIN_ROOT}/dist/mcp-cli.js')) {
	fail('Codex MCP server does not target the packaged MCP entry point')
}

console.log('Agent Plugin 1.0.0 and current ChatGPT/Codex compatibility manifests are valid.')
