#!/usr/bin/env node

try {
	const hasArguments = process.argv.length > 2
	const isInteractive = Boolean(process.stdin.isTTY || process.stdout.isTTY)

	if (hasArguments || isInteractive) {
		if (!hasArguments) process.argv.push('--help')
		await import('./cli.js')
	} else {
		const { runMcpStdioServer } = await import('./mcp/server.js')
		await runMcpStdioServer()
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`[open-market-data] ${message}\n`)
	process.exitCode = 1
}
