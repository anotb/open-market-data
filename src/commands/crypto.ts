import type { Command } from 'commander'
import { loadConfig } from '../core/config.js'
import {
	formatCurrency,
	formatKeyValue,
	formatNumber,
	formatPercent,
	formatTable,
} from '../core/formatter.js'
import { route } from '../core/router.js'
import type { ProviderResult } from '../providers/types.js'
import type { CryptoCandle, CryptoQuote, GlobalOptions } from '../types.js'
import { boundedInteger, choice, symbol as normalizedSymbol } from './validation.js'

const CRYPTO_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const

export function registerCryptoCommand(program: Command): void {
	const crypto = program.command('crypto').description('Cryptocurrency market data')

	crypto
		.command('top [limit]')
		.description('Top cryptocurrencies by market cap')
		.action(async (limit: string | undefined) => {
			const opts = program.opts<GlobalOptions>()
			const requestedLimit = limit ? boundedInteger(limit, 'limit', 1, 100) : 10
			let result: ProviderResult<CryptoQuote[]> | undefined
			try {
				result = await route<CryptoQuote[]>(
					'crypto',
					'top',
					{ limit: requestedLimit },
					{ source: opts.source, noCache: opts.noCache },
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const config = loadConfig()
				const hint =
					!config.coingeckoApiKey && /429|rate limit/i.test(message)
						? ' Configure a free CoinGecko Demo key for a dedicated quota.'
						: ''
				console.error(`Failed to fetch market rankings: ${message}${hint}`)
				process.exitCode = 1
				return
			}

			const rows = result.data.map((coin) => [
				coin.marketCapRank?.toString() ?? '',
				coin.symbol.toUpperCase(),
				coin.name ?? '',
				formatCurrency(coin.price),
				coin.changePercent24h != null ? formatPercent(coin.changePercent24h) : '',
				coin.marketCap ? formatNumber(coin.marketCap) : '',
				coin.volume24h ? formatNumber(coin.volume24h) : '',
			])
			console.log(
				formatTable(
					['#', 'Symbol', 'Name', 'Price', '24h %', 'Mkt Cap', 'Volume'],
					rows,
					opts.format,
				),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})

	crypto
		.command('history <symbol>')
		.description('Historical price data (OHLCV candles)')
		.option('-d, --days <n>', 'number of days', '30')
		.option('-i, --interval <interval>', 'candle interval (1m, 5m, 15m, 1h, 4h, 1d, 1w)')
		.action(async (symbol: string, commandOptions: { days: string; interval?: string }) => {
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const days = boundedInteger(commandOptions.days, '--days', 1, 3650)
			const interval = commandOptions.interval
				? choice(commandOptions.interval, '--interval', CRYPTO_INTERVALS)
				: undefined
			const result = await route<CryptoCandle[]>(
				'crypto',
				'history',
				{
					symbol: ticker,
					days,
					interval,
				},
				{ source: opts.source, noCache: opts.noCache },
			)
			const rows = result.data.map((candle) => [
				candle.time,
				candle.open.toFixed(2),
				candle.high.toFixed(2),
				candle.low.toFixed(2),
				candle.close.toFixed(2),
				formatNumber(candle.volume),
			])
			console.log(
				formatTable(['Time', 'Open', 'High', 'Low', 'Close', 'Volume'], rows, opts.format),
			)
			if (opts.format !== 'json') {
				console.log(`\nSource: ${result.source}${result.cached ? ' (cached)' : ''}`)
			}
		})

	crypto
		.argument('[symbol]', 'crypto symbol (e.g., BTC, ETH)')
		.action(async (symbol: string | undefined) => {
			if (!symbol) {
				crypto.help()
				return
			}
			const opts = program.opts<GlobalOptions>()
			const ticker = normalizedSymbol(symbol)
			const result = await route<CryptoQuote>(
				'crypto',
				'quote',
				{ symbol: ticker },
				{ source: opts.source, noCache: opts.noCache },
			)
			const coin = result.data
			console.log(
				formatKeyValue(
					{
						Symbol: coin.symbol.toUpperCase(),
						Name: coin.name,
						Price: formatCurrency(coin.price),
						'24h Change':
							coin.changePercent24h != null ? formatPercent(coin.changePercent24h) : undefined,
						'24h Volume': coin.volume24h ? formatNumber(coin.volume24h) : undefined,
						'Market Cap': coin.marketCap ? formatNumber(coin.marketCap) : undefined,
						Rank: coin.marketCapRank?.toString(),
						'24h High': coin.high24h ? formatCurrency(coin.high24h) : undefined,
						'24h Low': coin.low24h ? formatCurrency(coin.low24h) : undefined,
						ATH: coin.ath ? formatCurrency(coin.ath) : undefined,
						Source: result.source + (result.cached ? ' (cached)' : ''),
					},
					opts.format,
				),
			)
		})
}
