import type { Command } from 'commander'
import { formatCurrency, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { DividendEvent, GlobalOptions } from '../types.js'

export function registerDividendsCommand(program: Command): void {
	program
		.command('dividends <symbol>')
		.description('Get dividend history')
		.action(async (symbol: string) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<DividendEvent[]>(
				'dividends',
				'get',
				{ symbol },
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			if (result.data.length === 0) {
				console.log('No dividend data available.')
				return
			}

			const rows = result.data.map((d) => [d.date, formatCurrency(d.amount)])

			console.log(formatTable(['Date', 'Amount'], rows, opts.format))
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
