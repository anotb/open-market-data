import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, SearchResult } from '../types.js'

export function registerSearchCommand(program: Command): void {
	program
		.command('search <query>')
		.description('Search for companies, tickers, or assets')
		.action(async (query: string) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<SearchResult[]>(
				'search',
				'search',
				{ query },
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((r) => [
				r.symbol,
				r.name,
				r.exchange ?? '',
				r.type ?? '',
				r.source,
			])

			console.log(formatTable(['Symbol', 'Name', 'Exchange', 'Type', 'Source'], rows, opts.format))
		})
}
