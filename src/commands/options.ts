import type { Command } from 'commander'
import { formatCurrency, formatNumber, formatTable } from '../core/formatter.js'
import { route } from '../core/router.js'
import type { GlobalOptions, OptionContract } from '../types.js'
import { boundedInteger, choice, symbol as normalizedSymbol } from './validation.js'

export function registerOptionsCommand(program: Command): void {
	program
		.command('options <symbol>')
		.description('Get options chain data')
		.option('-t, --type <type>', 'filter by call or put')
		.option('-l, --limit <n>', 'maximum contracts to return', '100')
		.action(async (symbol: string, cmdOpts: { type?: string; limit: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const type = cmdOpts.type
				? choice(cmdOpts.type, '--type', ['call', 'put'] as const)
				: undefined
			const limit = boundedInteger(cmdOpts.limit, '--limit', 1, 250)
			const result = await route<OptionContract[]>(
				'options',
				'get',
				{ symbol: ticker },
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			let contracts = result.data
			if (type) contracts = contracts.filter((contract) => contract.type === type)
			contracts = contracts.slice(0, limit)

			const rows = contracts.map((c) => [
				c.type.toUpperCase(),
				c.expiration,
				formatCurrency(c.strike),
				c.lastPrice != null ? formatCurrency(c.lastPrice) : '',
				c.bid != null ? formatCurrency(c.bid) : '',
				c.ask != null ? formatCurrency(c.ask) : '',
				c.volume != null ? formatNumber(c.volume, 0) : '',
				c.openInterest != null ? formatNumber(c.openInterest, 0) : '',
				c.impliedVolatility != null ? `${(c.impliedVolatility * 100).toFixed(1)}%` : '',
			])

			console.log(
				formatTable(
					['Type', 'Expiry', 'Strike', 'Last', 'Bid', 'Ask', 'Vol', 'OI', 'IV'],
					rows,
					opts.format,
				),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})
}
