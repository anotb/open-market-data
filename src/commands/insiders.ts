import type { Command } from 'commander'
import { formatCurrency, formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, InsiderTransaction } from '../types.js'

export function registerInsidersCommand(program: Command): void {
	program
		.command('insiders <symbol>')
		.description('View insider transactions')
		.option('-l, --limit <n>', 'number of transactions', '20')
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
				t.title ?? '',
				t.transactionDate,
				t.transactionType,
				formatNumber(t.shares, 0),
				t.pricePerShare ? formatCurrency(t.pricePerShare) : '',
				t.totalValue ? formatNumber(t.totalValue) : '',
			])

			console.log(
				formatTable(
					['Name', 'Title', 'Date', 'Type', 'Shares', 'Price', 'Value'],
					rows,
					opts.format,
				),
			)
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			console.log('Note: Share counts are not available from EDGAR search results.')
		})
}
