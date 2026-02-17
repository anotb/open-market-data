import type { Command } from 'commander'
import {
	formatCurrency,
	formatKeyValue,
	formatNumber,
	formatPercent,
	formatTable,
} from '../core/formatter.js'
import { route } from '../core/router.js'
import type { CryptoCandle, CryptoQuote, GlobalOptions } from '../types.js'

export function registerCryptoCommand(program: Command): void {
	const crypto = program.command('crypto').description('Cryptocurrency market data')

	crypto
		.command('top [limit]')
		.description('Top cryptocurrencies by market cap')
		.action(async (limit: string | undefined) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<CryptoQuote[]>(
				'crypto',
				'top',
				{
					limit: limit ? Number.parseInt(limit, 10) : 10,
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((c) => [
				c.marketCapRank?.toString() ?? '',
				c.symbol.toUpperCase(),
				c.name ?? '',
				formatCurrency(c.price),
				c.changePercent24h != null ? formatPercent(c.changePercent24h) : '',
				c.marketCap ? formatNumber(c.marketCap) : '',
				c.volume24h ? formatNumber(c.volume24h) : '',
			])

			console.log(
				formatTable(
					['#', 'Symbol', 'Name', 'Price', '24h %', 'Mkt Cap', 'Volume'],
					rows,
					opts.format,
				),
			)
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
		})

	crypto
		.command('history <symbol>')
		.description('Historical price data (OHLCV candles)')
		.option('-d, --days <n>', 'number of days', '30')
		.option('-i, --interval <interval>', 'candle interval (1m, 5m, 15m, 1h, 4h, 1d, 1w)')
		.action(async (symbol: string, cmdOpts: { days: string; interval?: string }) => {
			const opts = program.opts<GlobalOptions>()
			const result = await route<CryptoCandle[]>(
				'crypto',
				'history',
				{
					symbol: symbol.toUpperCase(),
					days: Number.parseInt(cmdOpts.days, 10),
					interval: cmdOpts.interval,
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const rows = result.data.map((c) => [
				c.time,
				c.open.toFixed(2),
				c.high.toFixed(2),
				c.low.toFixed(2),
				c.close.toFixed(2),
				formatNumber(c.volume),
			])

			console.log(
				formatTable(['Time', 'Open', 'High', 'Low', 'Close', 'Volume'], rows, opts.format),
			)
			console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
		})

	// Default: `omd crypto BTC` → quote
	crypto
		.argument('[symbol]', 'crypto symbol (e.g., BTC, ETH)')
		.action(async (symbol: string | undefined) => {
			if (!symbol) {
				crypto.help()
				return
			}

			const opts = program.opts<GlobalOptions>()
			const result = await route<CryptoQuote>(
				'crypto',
				'quote',
				{
					symbol: symbol.toUpperCase(),
				},
				{
					source: opts.source,
					noCache: opts.noCache,
				},
			)

			const c = result.data
			console.log(
				formatKeyValue(
					{
						Symbol: c.symbol.toUpperCase(),
						Name: c.name,
						Price: formatCurrency(c.price),
						'24h Change':
							c.changePercent24h != null ? formatPercent(c.changePercent24h) : undefined,
						'24h Volume': c.volume24h ? formatNumber(c.volume24h) : undefined,
						'Market Cap': c.marketCap ? formatNumber(c.marketCap) : undefined,
						Rank: c.marketCapRank?.toString(),
						'24h High': c.high24h ? formatCurrency(c.high24h) : undefined,
						'24h Low': c.low24h ? formatCurrency(c.low24h) : undefined,
						ATH: c.ath ? formatCurrency(c.ath) : undefined,
						Source: result.source + (result.cached ? ' (cached)' : ''),
					},
					opts.format,
				),
			)
		})
}
