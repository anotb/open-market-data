#!/usr/bin/env node
import { Command } from 'commander'
import { registerConfigCommand } from './commands/config.js'
import { registerCryptoCommand } from './commands/crypto.js'
import { registerFilingCommand } from './commands/filing.js'
import { registerFinancialsCommand } from './commands/financials.js'
import { registerInsidersCommand } from './commands/insiders.js'
import { registerMacroCommand } from './commands/macro.js'
import { registerQuoteCommand } from './commands/quote.js'
import { registerSearchCommand } from './commands/search.js'
import { registerSourcesCommand } from './commands/sources.js'
import { registerAllProviders } from './providers/registry.js'
import type { OutputFormat } from './types.js'

const program = new Command()

program
	.name('omd')
	.description('Unified CLI for free financial data APIs')
	.version('0.1.0')
	.option('--json', 'output as JSON')
	.option('--plain', 'output as tab-separated values')
	.option('-v, --verbose', 'verbose output')
	.option('-s, --source <source>', 'force specific data source')
	.option('--no-cache', 'bypass cache')
	.hook('preAction', () => {
		// Normalize format option
		const rawOpts = program.opts()
		let format: OutputFormat = 'markdown'
		if (rawOpts.json) format = 'json'
		else if (rawOpts.plain) format = 'plain'
		// Store normalized format
		program.setOptionValue('format', format)
	})

// Register all providers
registerAllProviders()

// Register commands
registerSearchCommand(program)
registerQuoteCommand(program)
registerFinancialsCommand(program)
registerFilingCommand(program)
registerInsidersCommand(program)
registerMacroCommand(program)
registerCryptoCommand(program)
registerSourcesCommand(program)
registerConfigCommand(program)

program.parseAsync(process.argv).catch((err) => {
	console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
})
