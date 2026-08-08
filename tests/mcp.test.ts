import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type AgentRuntime, createAgentExecutor } from '../src/agent/runtime.js'
import {
	type JsonRpcResponse,
	MODERN_MCP_PROTOCOL_VERSION,
	createMcpMessageHandler,
	runMcpStdioServer,
} from '../src/mcp/server.js'
import type { ProviderResult } from '../src/providers/types.js'
import type { QuoteResult } from '../src/types.js'

const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

function modernMeta(version = MODERN_MCP_PROTOCOL_VERSION): Record<string, unknown> {
	return {
		[PROTOCOL_VERSION]: version,
		[CLIENT_INFO]: { name: 'test-client', version: '1.0.0' },
		[CLIENT_CAPABILITIES]: {},
	}
}

function modernParams(input: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...input, _meta: modernMeta() }
}

function runtime(): AgentRuntime {
	return {
		route: async <T>(
			_category: Parameters<AgentRuntime['route']>[0],
			_action: string,
			args: Record<string, unknown>,
		): Promise<ProviderResult<T>> => ({
			data: {
				symbol: args.symbol ?? (args.symbols as string[] | undefined)?.[0] ?? 'AAPL',
				price: 100,
				change: 1,
				changePercent: 1,
				source: 'fake',
			} as T,
			source: 'fake',
			cached: false,
		}),
		getProviders: () => [],
		ensureProviders: () => undefined,
		now: () => new Date('2026-08-07T12:00:00.000Z'),
	}
}

function handler() {
	return createMcpMessageHandler({
		executor: createAgentExecutor(runtime()),
		serverVersion: '0.2.0-test',
	})
}

function response(value: JsonRpcResponse | JsonRpcResponse[] | undefined): JsonRpcResponse {
	expect(Array.isArray(value)).toBe(false)
	expect(value).toBeDefined()
	return value as JsonRpcResponse
}

describe('modern MCP handler', () => {
	it('discovers the server without a session handshake', async () => {
		const discovered = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 'discover',
				method: 'server/discover',
				params: modernParams(),
			}),
		)
		const result = discovered.result as Record<string, unknown>

		expect(result).toMatchObject({
			resultType: 'complete',
			supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
			capabilities: { tools: { listChanged: false } },
			ttlMs: 3_600_000,
			cacheScope: 'public',
			_meta: {
				[SERVER_INFO]: { name: 'open-market-data', version: '0.2.0-test' },
			},
		})
	})

	it('rejects the removed modern ping method while retaining legacy compatibility', async () => {
		const modernPing = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 'modern-ping',
				method: 'ping',
				params: modernParams(),
			}),
		)
		expect(modernPing.error).toMatchObject({ code: -32601 })

		const server = handler()
		await server.handle({
			jsonrpc: '2.0',
			id: 'initialize',
			method: 'initialize',
			params: { protocolVersion: '2025-11-25' },
		})
		const legacyPing = response(
			await server.handle({ jsonrpc: '2.0', id: 'legacy-ping', method: 'ping' }),
		)
		expect(legacyPing.result).toEqual({})
	})

	it('advertises a deterministic, cacheable tool list', async () => {
		const listed = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: modernParams(),
			}),
		)
		const result = listed.result as {
			resultType: string
			tools: Array<{ name: string; outputSchema?: Record<string, unknown> }>
			ttlMs: number
			cacheScope: string
		}

		expect(result.resultType).toBe('complete')
		expect(result.tools).toHaveLength(17)
		expect(result.tools.map((tool) => tool.name)).toContain('company_snapshot')
		expect(result.tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true)
		expect(result.ttlMs).toBeGreaterThan(0)
		expect(result.cacheScope).toBe('public')
	})

	it('returns modern structured content plus a text fallback', async () => {
		const called = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 'quote',
				method: 'tools/call',
				params: modernParams({
					name: 'stock_quotes',
					arguments: { symbols: ['AAPL'] },
				}),
			}),
		)
		const result = called.result as {
			resultType: string
			structuredContent: { data: QuoteResult[] }
			content: Array<{ type: string; text: string }>
			isError?: boolean
			_meta: Record<string, unknown>
		}

		expect(result.resultType).toBe('complete')
		expect(result.isError).not.toBe(true)
		expect(result.structuredContent.data[0].symbol).toBe('AAPL')
		expect(result.content).toEqual([expect.objectContaining({ type: 'text' })])
		expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
		expect(result._meta).toHaveProperty(SERVER_INFO)
	})

	it('returns actionable validation failures as bounded tool results', async () => {
		const called = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: modernParams({
					name: 'stock_quotes',
					arguments: { symbols: [] },
				}),
			}),
		)
		const result = called.result as {
			resultType: string
			isError: boolean
			content: Array<{ text: string }>
		}

		expect(result.resultType).toBe('complete')
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/at least 1/i)
	})

	it('uses protocol errors for unknown tools and malformed calls', async () => {
		const unknown = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: modernParams({ name: 'not_a_tool', arguments: {} }),
			}),
		)
		expect(unknown.error).toMatchObject({ code: -32602, message: 'Unknown tool: not_a_tool' })

		const malformed = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: modernParams({ name: 'stock_quotes', arguments: [] }),
			}),
		)
		expect(malformed.error).toMatchObject({ code: -32602 })
	})

	it('rejects missing metadata and unsupported modern versions precisely', async () => {
		const missing = response(
			await handler().handle({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
		)
		expect(missing.error).toMatchObject({ code: -32602 })

		const missingCapabilities = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/list',
				params: {
					_meta: {
						[PROTOCOL_VERSION]: MODERN_MCP_PROTOCOL_VERSION,
					},
				},
			}),
		)
		expect(missingCapabilities.error).toMatchObject({ code: -32602 })

		const unsupported = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/list',
				params: { _meta: modernMeta('1900-01-01') },
			}),
		)
		expect(unsupported.error).toMatchObject({
			code: -32022,
			data: {
				requested: '1900-01-01',
				supported: expect.arrayContaining(['2026-07-28', '2025-11-25']),
			},
		})
	})
})

describe('legacy MCP compatibility', () => {
	it('negotiates initialize and serves legacy-shaped results', async () => {
		const server = handler()
		const initialized = response(
			await server.handle({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-11-25' },
			}),
		)
		expect(initialized.result).toMatchObject({
			protocolVersion: '2025-11-25',
			serverInfo: { name: 'open-market-data', version: '0.2.0-test' },
			capabilities: { tools: { listChanged: false } },
		})

		const listed = response(await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
		const result = listed.result as { tools: Array<{ name: string }>; resultType?: string }
		expect(result.tools).toHaveLength(17)
		expect(result.resultType).toBeUndefined()
	})

	it('negotiates down when initialize requests a modern or unknown version', async () => {
		for (const requested of ['2026-07-28', '1900-01-01']) {
			const initialized = response(
				await handler().handle({
					jsonrpc: '2.0',
					id: requested,
					method: 'initialize',
					params: { protocolVersion: requested },
				}),
			)
			expect(initialized.result).toMatchObject({ protocolVersion: '2025-11-25' })
		}
	})

	it('can process an initialize plus follow-up request deterministically in a batch', async () => {
		const batched = await handler().handle([
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-11-25' },
			},
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		])
		expect(batched).toEqual([
			expect.objectContaining({ id: 1, result: expect.any(Object) }),
			expect.objectContaining({ id: 2, result: expect.any(Object) }),
		])
	})
})

describe('JSON-RPC behavior', () => {
	it('rejects null request IDs and unknown protocol methods', async () => {
		const invalidId = response(
			await handler().handle({ jsonrpc: '2.0', id: null, method: 'server/discover' }),
		)
		expect(invalidId.error).toMatchObject({ code: -32600 })

		const unknown = response(
			await handler().handle({
				jsonrpc: '2.0',
				id: 1,
				method: 'resources/list',
				params: modernParams(),
			}),
		)
		expect(unknown.error).toMatchObject({ code: -32601 })
	})

	it('does not respond to notifications', async () => {
		await expect(
			handler().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		).resolves.toBeUndefined()
	})
})

describe('MCP stdio transport', () => {
	it('uses one JSON-RPC object per line, reports parse errors, and keeps diagnostics off stdout', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const diagnostics = new PassThrough()
		let stdout = ''
		let stderr = ''
		output.setEncoding('utf8')
		diagnostics.setEncoding('utf8')
		output.on('data', (chunk) => {
			stdout += chunk
		})
		diagnostics.on('data', (chunk) => {
			stderr += chunk
		})

		const running = runMcpStdioServer({
			input,
			output,
			errorOutput: diagnostics,
			executor: createAgentExecutor(runtime()),
			serverVersion: '0.2.0-test',
		})
		input.end(
			`{not-json}\n${JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'server/discover',
				params: modernParams(),
			})}\n${JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: modernParams(),
			})}\n`,
		)
		await running

		const lines = stdout
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(lines).toHaveLength(3)
		expect(lines[0]).toMatchObject({ id: null, error: { code: -32700 } })
		expect(lines.slice(1).map((line) => line.id)).toEqual([1, 2])
		expect(lines[1].result).toMatchObject({ resultType: 'complete' })
		expect(stderr).toBe('')
	})
})
