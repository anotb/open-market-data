import type { Command } from 'commander'
import { formatCurrency, formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, HistoricalQuote } from '../types.js'
import { boundedInteger, symbol as normalizedSymbol } from './validation.js'

export function registerHistoryCommand(program: Command): void {
	program
		.command('history <symbol>')
		.description('Get historical price data (OHLCV)')
		.option('-d, --days <n>', 'number of days', '30')
		.action(async (symbol: string, cmdOpts: { days: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const days = boundedInteger(cmdOpts.days, '--days', 1, 730)
			const result = await route<HistoricalQuote[]>(
				'history',
				'get',
				{
					symbol: ticker,
					days,
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
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
