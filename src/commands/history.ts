import type { Command } from 'commander'
import { formatCurrency, formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, HistoricalQuote } from '../types.js'

export function registerHistoryCommand(program: Command): void {
	program
		.command('history <symbol>')
		.description('Get historical price data (OHLCV)')
		.option('-d, --days <n>', 'number of days', '30')
		.action(async (symbol: string, cmdOpts: { days: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<HistoricalQuote[]>(
				'history',
				'get',
				{
					symbol,
					days: Number.parseInt(cmdOpts.days, 10),
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((h) => [
				h.date,
				formatCurrency(h.open),
				formatCurrency(h.high),
				formatCurrency(h.low),
				formatCurrency(h.close),
				formatNumber(h.volume, 0),
			])

			console.log(
				formatTable(['Date', 'Open', 'High', 'Low', 'Close', 'Volume'], rows, opts.format),
			)
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
		})
}
