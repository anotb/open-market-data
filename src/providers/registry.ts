import { registerProvider } from '../core/router.js'
import { alphaVantage } from './alpha-vantage.js'
import { binance } from './binance.js'
import { coingecko } from './coingecko.js'
import { finnhub } from './finnhub.js'
import { fred } from './fred.js'
import { secEdgar } from './sec-edgar.js'
import { worldBank } from './world-bank.js'
import { yahoo } from './yahoo-finance.js'

export function registerAllProviders(): void {
	registerProvider(secEdgar)
	registerProvider(yahoo)
	registerProvider(binance)
	registerProvider(coingecko)
	registerProvider(fred)
	registerProvider(finnhub)
	registerProvider(alphaVantage)
	registerProvider(worldBank)
}
