import { registerProvider } from '../core/router.js'
import { binance } from './binance.js'
import { coingecko } from './coingecko.js'
import { fred } from './fred.js'
import { secEdgar } from './sec-edgar.js'
import { yahoo } from './yahoo-finance.js'

export function registerAllProviders(): void {
	registerProvider(secEdgar)
	registerProvider(yahoo)
	registerProvider(binance)
	registerProvider(coingecko)
	registerProvider(fred)
}
