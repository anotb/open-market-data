import type { Command } from 'commander'
import { formatCurrency, formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, InsiderTransaction } from '../types.js'
import { boundedInteger, symbol as normalizedSymbol } from './validation.js'

export function registerInsidersCommand(program: Command): void {
	program
		.command('insiders <symbol>')
		.description('View recent Form 4 insider filings')
		.option('-l, --limit <n>', 'number of filings', '20')
		.action(async (symbol: string, cmdOpts: { limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const limit = boundedInteger(cmdOpts.limit, '--limit', 1, 100)
			const result = await route<InsiderTransaction[]>(
				'insiders',
				'list',
				{
					symbol: ticker,
					limit,
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
				formatNumber(t.shares, 0),
				t.pricePerShare != null ? formatCurrency(t.pricePerShare) : '',
				t.totalValue != null ? formatCurrency(t.totalValue) : '',
				t.description ?? '',
				t.accessionNumber ?? '',
			])

			console.log(
				formatTable(
					['Filer', 'Date', 'Transaction', 'Shares', 'Price', 'Value', 'Security', 'Accession'],
					rows,
					opts.format,
				),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
