import type { Command } from 'commander'
import { formatKeyValue, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, MacroSeries, SearchResult } from '../types.js'

export function registerMacroCommand(program: Command): void {
	const macro = program.command('macro').description('Macroeconomic data from FRED')

	macro
		.command('search <query>')
		.description('Search FRED series')
		.option('-l, --limit <n>', 'number of results', '20')
		.action(async (query: string, cmdOpts: { limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<SearchResult[]>(
				'macro',
				'search',
				{
					query,
					limit: Number.parseInt(cmdOpts.limit, 10),
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((r) => [r.symbol, r.name, r.type ?? '', r.exchange ?? ''])
			console.log(formatTable(['Series ID', 'Title', 'Frequency', 'Units'], rows, opts.format))
		})

	macro
		.command('get <seriesId>')
		.description('Get time series data (e.g., GDP, UNRATE, CPIAUCSL)')
		.option('-s, --start <date>', 'start date (YYYY-MM-DD)')
		.option('-e, --end <date>', 'end date (YYYY-MM-DD)')
		.option('-l, --limit <n>', 'number of observations')
		.action(async (seriesId: string, cmdOpts: { start?: string; end?: string; limit?: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<MacroSeries>(
				'macro',
				'get',
				{
					seriesId,
					start: cmdOpts.start,
					end: cmdOpts.end,
					limit: cmdOpts.limit ? Number.parseInt(cmdOpts.limit, 10) : undefined,
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const series = result.data
			console.log(
				formatKeyValue(
					{
						Series: series.id,
						Title: series.title,
						Units: series.units,
						Frequency: series.frequency,
						'Seasonal Adj.': series.seasonalAdjustment,
					},
					opts.format,
				),
			)
			console.log()

			const rows = series.data.map((d) => [d.date, d.value.toString()])
			console.log(formatTable(['Date', 'Value'], rows, opts.format))
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
		})

	// Allow bare `omd macro GDP` as shorthand for `omd macro get GDP`
	macro
		.action(async (seriesIdOrCmd: string, cmdOpts: Record<string, string>) => {
			// If first arg looks like a series ID (all caps, no spaces), treat as `get`
			if (seriesIdOrCmd && /^[A-Z0-9_]+$/.test(seriesIdOrCmd)) {
				const opts = program.opts<GlobalOptions>()
				const result = await route<MacroSeries>(
					'macro',
					'get',
					{
						seriesId: seriesIdOrCmd,
						start: cmdOpts.start,
						end: cmdOpts.end,
					},
					{
						source: opts.source,
						noCache: opts.noCache,
					},
				)
				const series = result.data
				console.log(
					formatKeyValue(
						{
							Series: series.id,
							Title: series.title,
							Units: series.units,
							Frequency: series.frequency,
						},
						opts.format,
					),
				)
				console.log()
				const rows = series.data.map((d) => [d.date, d.value.toString()])
				console.log(formatTable(['Date', 'Value'], rows, opts.format))
			}
		})
		.argument('[seriesId]', 'FRED series ID (shorthand for `macro get`)')
		.option('-s, --start <date>', 'start date')
		.option('-e, --end <date>', 'end date')
}
