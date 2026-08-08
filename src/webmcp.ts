import { type AgentToolName, type JsonSchema, listAgentTools } from './agent/catalog.js'

export type WebMcpExecutor = (
	name: AgentToolName,
	input: Record<string, unknown>,
) => Promise<unknown>

export interface WebMcpTool {
	name: string
	title?: string
	description: string
	inputSchema?: JsonSchema
	annotations?: {
		readOnlyHint?: boolean
		untrustedContentHint?: boolean
	}
	execute(input: Record<string, unknown>): Promise<unknown>
}

export interface WebMcpModelContext {
	registerTool(
		tool: WebMcpTool,
		options?: { signal?: AbortSignal; exposedTo?: string[] },
	): Promise<void>
}

export interface WebMcpDocument {
	modelContext?: WebMcpModelContext
}

export interface RegisterWebMcpOptions {
	document?: WebMcpDocument
	exposedTo?: string[]
}

export interface WebMcpRegistration {
	supported: boolean
	registered: number
	dispose(): void
}

export async function registerOpenMarketDataWebMcp(
	execute: WebMcpExecutor,
	options: RegisterWebMcpOptions = {},
): Promise<WebMcpRegistration> {
	const documentRef =
		options.document ?? (globalThis as typeof globalThis & { document?: WebMcpDocument }).document
	const modelContext = documentRef?.modelContext
	if (!modelContext || typeof modelContext.registerTool !== 'function') {
		return { supported: false, registered: 0, dispose: () => undefined }
	}

	const controller = new AbortController()
	try {
		for (const tool of listAgentTools()) {
			await modelContext.registerTool(
				{
					name: tool.name,
					title: tool.title,
					description: tool.description,
					inputSchema: tool.inputSchema,
					annotations: {
						readOnlyHint: true,
						untrustedContentHint: true,
					},
					execute: (input) => execute(tool.name, input),
				},
				{
					signal: controller.signal,
					exposedTo: options.exposedTo,
				},
			)
		}
	} catch (error) {
		controller.abort(error)
		throw error
	}

	return {
		supported: true,
		registered: listAgentTools().length,
		dispose: () => controller.abort(),
	}
}
