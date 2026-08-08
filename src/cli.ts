#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerConfigCommand } from './commands/config.js'
import { registerCryptoCommand } from './commands/crypto.js'
import { registerDividendsCommand } from './commands/dividends.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerEarningsCommand } from './commands/earnings.js'
import { registerFilingCommand } from './commands/filing.js'
import { registerFinancialsCommand } from './commands/financials.js'
import { registerHistoryCommand } from './commands/history.js'
import { registerInsidersCommand } from './commands/insiders.js'
import { registerMacroCommand } from './commands/macro.js'
import { registerOptionsCommand } from './commands/options.js'
import { registerQuoteCommand } from './commands/quote.js'
import { registerSearchCommand } from './commands/search.js'
import { registerSourcesCommand } from './commands/sources.js'
import { loadConfig } from './core/config.js'
import { registerAllProviders } from './providers/registry.js'
import type { OutputFormat } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

const program = new Command()

program
	.name('omd')
	.description('Read-only market, SEC, crypto, and macro data from free public APIs')
	.version(pkg.version)
	.option('--json', 'output as JSON')
	.option('--plain', 'output as tab-separated values')
	.option('-v, --verbose', 'verbose output')
	.option('-s, --source <source>', 'force specific data source')
	.option('--no-cache', 'bypass cache')
	.hook('preAction', () => {
		const rawOpts = program.opts()
		let format: OutputFormat = loadConfig().defaultFormat ?? 'markdown'
		if (rawOpts.json) format = 'json'
		else if (rawOpts.plain) format = 'plain'
		program.setOptionValue('format', format)

		if (typeof rawOpts.source === 'string') {
			const source = rawOpts.source.trim().toLowerCase()
			if (source) program.setOptionValue('source', source)
		}
	})

registerAllProviders()

registerSearchCommand(program)
registerQuoteCommand(program)
registerFinancialsCommand(program)
registerHistoryCommand(program)
registerOptionsCommand(program)
registerEarningsCommand(program)
registerDividendsCommand(program)
registerFilingCommand(program)
registerInsidersCommand(program)
registerMacroCommand(program)
registerCryptoCommand(program)
registerSourcesCommand(program)
registerDoctorCommand(program)
registerConfigCommand(program)

program.parseAsync(process.argv).catch((err) => {
	console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
})
