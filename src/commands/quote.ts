import type { Command } from 'commander'
import {
	formatCurrency,
	formatKeyValue,
	formatNumber,
	formatPercent,
	formatTable,
} from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, QuoteResult } from '../types.js'

export function registerQuoteCommand(program: Command): void {
	program
		.command('quote <symbols...>')
		.description('Get stock/asset quotes')
		.action(async (symbols: string[]) => {
			const opts = program.opts<GlobalOptions>()

			if (symbols.length === 1) {
				const result = await route<QuoteResult>(
					'quote',
					'get',
					{ symbol: symbols[0] },
					{
						source: opts.source,
						noCache: opts.noCache,
					},
				)
				const q = result.data
				console.log(
					formatKeyValue(
						{
							Symbol: q.symbol,
							Price: formatCurrency(q.price),
							Change: `${formatCurrency(q.change)} (${formatPercent(q.changePercent)})`,
							Volume: q.volume ? formatNumber(q.volume, 0) : undefined,
							'Market Cap': q.marketCap ? formatNumber(q.marketCap) : undefined,
							'Day Range':
								q.dayLow && q.dayHigh
									? `${formatCurrency(q.dayLow)} — ${formatCurrency(q.dayHigh)}`
									: undefined,
							'52w Range':
								q.low52w && q.high52w
									? `${formatCurrency(q.low52w)} — ${formatCurrency(q.high52w)}`
									: undefined,
							Open: q.open ? formatCurrency(q.open) : undefined,
							'Prev Close': q.previousClose ? formatCurrency(q.previousClose) : undefined,
							Source: result.source + (result.cached ? ' (cached)' : ''),
						},
						opts.format,
					),
				)
			} else {
				// Multi-symbol: try batch first, fall back to concurrent individual requests
				let results: { data: QuoteResult; source: string; cached: boolean }[]
				try {
					const batchResult = await route<QuoteResult[]>(
						'quote',
						'get',
						{ symbols },
						{ source: opts.source, noCache: opts.noCache },
					)
					results = batchResult.data.map((q) => ({
						data: q,
						source: batchResult.source,
						cached: batchResult.cached,
					}))
				} catch {
					// Fall back to concurrent individual requests
					results = await Promise.all(
						symbols.map((s) =>
							route<QuoteResult>(
								'quote',
								'get',
								{ symbol: s },
								{ source: opts.source, noCache: opts.noCache },
							),
						),
					)
				}

				const rows = results.map((r) => {
					const q = r.data
					return [
						q.symbol,
						formatCurrency(q.price),
						formatPercent(q.changePercent),
						q.volume ? formatNumber(q.volume, 0) : '',
						q.marketCap ? formatNumber(q.marketCap) : '',
						r.source,
					]
				})

				console.log(
					formatTable(
						['Symbol', 'Price', 'Change', 'Volume', 'Mkt Cap', 'Source'],
						rows,
						opts.format,
					),
				)
			}
		})
}
