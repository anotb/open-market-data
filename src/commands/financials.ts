import type { Command } from 'commander'
import { formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { FinancialStatement, GlobalOptions } from '../types.js'
import { boundedInteger, choice, symbol as normalizedSymbol } from './validation.js'

export function registerFinancialsCommand(program: Command): void {
	program
		.command('financials <symbol>')
		.description('Get company financial statements')
		.option('-p, --period <period>', 'annual or quarterly', 'annual')
		.option('-l, --limit <n>', 'number of periods', '5')
		.action(async (symbol: string, cmdOpts: { period: string; limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const period = choice(cmdOpts.period, '--period', ['annual', 'quarterly'] as const)
			const limit = boundedInteger(cmdOpts.limit, '--limit', 1, 40)
			const result = await route<FinancialStatement[]>(
				'financials',
				'get',
				{
					symbol: ticker,
					period,
					limit,
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const fmt = (n: number | undefined) => (n != null ? formatNumber(n) : '')

			const rows = result.data.map((f) => [
				f.period,
				f.date,
				fmt(f.revenue),
				fmt(f.netIncome),
				f.eps?.toFixed(2) ?? '',
				fmt(f.totalAssets),
				fmt(f.stockholdersEquity),
			])

			console.log(
				formatTable(
					['Period', 'Date', 'Revenue', 'Net Income', 'EPS', 'Assets', 'Equity'],
					rows,
					opts.format,
				),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
