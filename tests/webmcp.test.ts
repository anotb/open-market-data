import { describe, expect, it, vi } from 'vitest'
import { AGENT_TOOLS, type AgentToolName } from '../src/agent/catalog.js'
import {
	type WebMcpDocument,
	type WebMcpTool,
	registerOpenMarketDataWebMcp,
} from '../src/webmcp.js'

describe('WebMCP adapter', () => {
	it('feature-detects unsupported browsers without throwing', async () => {
		const execute = vi.fn()
		const registration = await registerOpenMarketDataWebMcp(execute, { document: {} })

		expect(registration).toMatchObject({ supported: false, registered: 0 })
		expect(execute).not.toHaveBeenCalled()
		expect(() => registration.dispose()).not.toThrow()
	})

	it('registers the shared read-only catalog and forwards execution', async () => {
		const registered: Array<{
			tool: WebMcpTool
			options?: { signal?: AbortSignal; exposedTo?: string[] }
		}> = []
		const document: WebMcpDocument = {
			modelContext: {
				registerTool: async (tool, options) => {
					registered.push({ tool, options })
				},
			},
		}
		const execute = vi.fn(async (name: AgentToolName, input: Record<string, unknown>) => ({
			name,
			input,
		}))
		const registration = await registerOpenMarketDataWebMcp(execute, {
			document,
			exposedTo: ['self'],
		})

		expect(registration).toMatchObject({ supported: true, registered: AGENT_TOOLS.length })
		expect(registered).toHaveLength(AGENT_TOOLS.length)
		expect(registered[0].tool).toMatchObject({
			name: AGENT_TOOLS[0].name,
			inputSchema: AGENT_TOOLS[0].inputSchema,
			annotations: {
				readOnlyHint: true,
				untrustedContentHint: true,
			},
		})
		expect(registered[0].options?.exposedTo).toEqual(['self'])
		expect(registered[0].options?.signal?.aborted).toBe(false)

		await registered[0].tool.execute({ query: 'Apple' })
		expect(execute).toHaveBeenCalledWith(AGENT_TOOLS[0].name, { query: 'Apple' })

		registration.dispose()
		expect(registered.every((entry) => entry.options?.signal?.aborted)).toBe(true)
	})

	it('rolls back earlier registrations when one registration fails', async () => {
		const signals: AbortSignal[] = []
		let calls = 0
		const document: WebMcpDocument = {
			modelContext: {
				registerTool: async (_tool, options) => {
					calls += 1
					if (options?.signal) signals.push(options.signal)
					if (calls === 2) throw new Error('registration failed')
				},
			},
		}

		await expect(registerOpenMarketDataWebMcp(async () => ({}), { document })).rejects.toThrow(
			'registration failed',
		)
		expect(signals).not.toHaveLength(0)
		expect(signals.every((signal) => signal.aborted)).toBe(true)
	})
})
