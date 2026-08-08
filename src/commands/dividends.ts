import type { Command } from 'commander'
import { formatCurrency, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { DividendEvent, GlobalOptions } from '../types.js'
import { symbol as normalizedSymbol } from './validation.js'

export function registerDividendsCommand(program: Command): void {
	program
		.command('dividends <symbol>')
		.description('Get dividend history')
		.action(async (symbol: string) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const result = await route<DividendEvent[]>(
				'dividends',
				'get',
				{ symbol: ticker },
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			if (result.data.length === 0) {
				console.log(
					opts.format === 'markdown'
						? 'No dividend data available.'
						: formatTable(['Date', 'Amount'], [], opts.format),
				)
				return
			}

			const rows = result.data.map((d) => [d.date, formatCurrency(d.amount)])

			console.log(formatTable(['Date', 'Amount'], rows, opts.format))
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
