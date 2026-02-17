import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, InsiderTransaction } from '../types.js'

export function registerInsidersCommand(program: Command): void {
	program
		.command('insiders <symbol>')
		.description('View recent Form 4 insider filings')
		.option('-l, --limit <n>', 'number of filings', '20')
		.action(async (symbol: string, cmdOpts: { limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<InsiderTransaction[]>(
				'insiders',
				'list',
				{
					symbol,
					limit: Number.parseInt(cmdOpts.limit, 10),
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((t) => [
				t.name,
				t.transactionDate,
				t.transactionType,
				t.description ?? '',
			])

			console.log(
				formatTable(['Filer', 'Filed', 'Form', 'Description'], rows, opts.format),
			)
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			console.log('Note: For transaction details (shares, price), view the actual Form 4 filing on SEC.gov.')
		})
}
