import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { Filing, GlobalOptions } from '../types.js'
import { boundedInteger, boundedText, symbol as normalizedSymbol } from './validation.js'

export function registerFilingCommand(program: Command): void {
	program
		.command('filing <symbol>')
		.description('List SEC filings for a company')
		.option('-t, --type <type>', 'filing type (10-K, 10-Q, 8-K, etc.)')
		.option('--latest', 'show only the most recent filing')
		.option('-l, --limit <n>', 'number of filings', '20')
		.action(async (symbol: string, cmdOpts: { type?: string; latest?: boolean; limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const limit = boundedInteger(cmdOpts.limit, '--limit', 1, 100)
			const formType = cmdOpts.type ? boundedText(cmdOpts.type, '--type', 32) : undefined
			const result = await route<Filing[]>(
				'filing',
				'list',
				{
					symbol: ticker,
					type: formType,
					latest: cmdOpts.latest,
					limit,
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const filings = cmdOpts.latest ? result.data.slice(0, 1) : result.data

			const rows = filings.map((f) => [
				f.form,
				f.filingDate,
				f.reportDate ?? '',
				f.accessionNumber,
				f.description ?? '',
			])

			console.log(
				formatTable(
					['Form', 'Filed', 'Report Date', 'Accession #', 'Description'],
					rows,
					opts.format,
				),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
