import type { Command } from 'commander'
import { formatKeyValue, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, MacroSeries, OutputFormat } from '../types.js'

// FRED search returns this shape (not SearchResult)
interface FredSearchResult {
	id: string
	title: string
	units: string
	frequency: string
	seasonal_adjustment: string
	popularity: number
}

function displaySeries(
	series: MacroSeries,
	source: string,
	cached: boolean,
	format: OutputFormat,
): void {
	if (format === 'json') {
		// Single combined JSON object for machine consumption
		console.log(
			JSON.stringify(
				{
					series: series.id,
					title: series.title,
					units: series.units,
					frequency: series.frequency,
					seasonalAdjustment: series.seasonalAdjustment,
					source,
					cached,
					data: series.data,
				},
				null,
				2,
			),
		)
		return
	}

	console.log(
		formatKeyValue(
			{
				Series: series.id,
				Title: series.title,
				Units: series.units,
				Frequency: series.frequency,
				'Seasonal Adj.': series.seasonalAdjustment,
			},
			format,
		),
	)
	console.log()
	const rows = series.data.map((d) => [d.date, d.value.toString()])
	console.log(formatTable(['Date', 'Value'], rows, format))
	console.log(`\nSource: ${source}${cached ? ' (cached)' : ''}`)
}

export function registerMacroCommand(program: Command): void {
	const macro = program.command('macro').description('Macroeconomic data from FRED')

	macro
		.command('search <query>')
		.description('Search FRED series')
		.option('-l, --limit <n>', 'number of results', '20')
		.action(async (query: string, cmdOpts: { limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<FredSearchResult[]>(
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

			const rows = result.data.map((r) => [r.id, r.title, r.frequency ?? '', r.units ?? ''])
			console.log(formatTable(['Series ID', 'Title', 'Frequency', 'Units'], rows, opts.format))
		})

	// `omd macro get GDP` or just `omd macro GDP` (isDefault makes it the fallback)
	macro
		.command('get [seriesId]', { isDefault: true })
		.description('Get time series data (e.g., GDP, UNRATE, CPIAUCSL)')
		.option('-s, --start <date>', 'start date (YYYY-MM-DD)')
		.option('-e, --end <date>', 'end date (YYYY-MM-DD)')
		.option('-l, --limit <n>', 'number of observations')
		.option('-c, --country <code>', 'ISO 3166-1 alpha-2 country code', 'US')
		.action(
			async (
				seriesId: string | undefined,
				cmdOpts: { start?: string; end?: string; limit?: string; country?: string },
			) => {
				if (!seriesId) {
					macro.help()
					return
				}

				const opts = program.opts<GlobalOptions>()
				// Non-US country data only available from World Bank
				const source =
					cmdOpts.country && cmdOpts.country.toUpperCase() !== 'US'
						? (opts.source ?? 'worldbank')
						: opts.source
				const result = await route<MacroSeries>(
					'macro',
					'get',
					{
						seriesId: seriesId.toUpperCase(),
						start: cmdOpts.start,
						end: cmdOpts.end,
						limit: cmdOpts.limit ? Number.parseInt(cmdOpts.limit, 10) : undefined,
						country: cmdOpts.country,
					},
					{
						source,
						noCache: opts.noCache,
					},
				)
				displaySeries(result.data, result.source, result.cached, opts.format)
			},
		)
}
