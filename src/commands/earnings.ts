import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { EarningsData, GlobalOptions } from '../types.js'
import { symbol as normalizedSymbol } from './validation.js'

export function registerEarningsCommand(program: Command): void {
	program
		.command('earnings <symbol>')
		.description('Get earnings data and upcoming dates')
		.action(async (symbol: string) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const result = await route<EarningsData[]>(
				'earnings',
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
						? 'No earnings data available.'
						: formatTable(['Date', 'EPS Est.', 'EPS Actual', 'Surprise'], [], opts.format),
				)
				return
			}

			const rows = result.data.map((e) => [
				e.earningsDate ?? '',
				e.epsEstimate != null ? e.epsEstimate.toFixed(2) : '',
				e.epsActual != null ? e.epsActual.toFixed(2) : '',
				e.epsEstimate != null && e.epsActual != null
					? (e.epsActual - e.epsEstimate > 0 ? '+' : '') + (e.epsActual - e.epsEstimate).toFixed(2)
					: '',
			])

			console.log(formatTable(['Date', 'EPS Est.', 'EPS Actual', 'Surprise'], rows, opts.format))
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
