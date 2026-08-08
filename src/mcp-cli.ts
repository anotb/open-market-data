#!/usr/bin/env node
import { runMcpStdioServer } from './mcp/server.js'

runMcpStdioServer().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`[open-market-data-mcp] ${message}\n`)
	process.exitCode = 1
})
