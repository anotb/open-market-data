import type { AgentToolInputMap, AgentToolName, CommonToolInput } from './agent/catalog.js'
import {
	type AgentRuntime,
	type AgentToolOutputMap,
	type AgentToolResponse,
	createAgentExecutor,
} from './agent/runtime.js'

export interface OpenMarketDataClient {
	listTools: ReturnType<typeof createAgentExecutor>['listTools']
	call<Name extends AgentToolName>(
		name: Name,
		input: AgentToolInputMap[Name],
	): Promise<AgentToolResponse<AgentToolOutputMap[Name]>>
	search(
		query: string,
		options?: CommonToolInput & { limit?: number },
	): Promise<AgentToolResponse<AgentToolOutputMap['market_search']>>
	snapshot(
		input: AgentToolInputMap['company_snapshot'],
	): Promise<AgentToolResponse<AgentToolOutputMap['company_snapshot']>>
	quotes(
		symbols: string[],
		options?: CommonToolInput,
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_quotes']>>
	financials(
		input: AgentToolInputMap['stock_financials'],
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_financials']>>
	history(
		input: AgentToolInputMap['stock_history'],
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_history']>>
	options(
		input: AgentToolInputMap['stock_options'],
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_options']>>
	earnings(
		input: AgentToolInputMap['stock_earnings'],
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_earnings']>>
	dividends(
		input: AgentToolInputMap['stock_dividends'],
	): Promise<AgentToolResponse<AgentToolOutputMap['stock_dividends']>>
	filings(
		input: AgentToolInputMap['sec_filings'],
	): Promise<AgentToolResponse<AgentToolOutputMap['sec_filings']>>
	insiders(
		input: AgentToolInputMap['sec_insider_transactions'],
	): Promise<AgentToolResponse<AgentToolOutputMap['sec_insider_transactions']>>
	cryptoQuote(
		input: AgentToolInputMap['crypto_quote'],
	): Promise<AgentToolResponse<AgentToolOutputMap['crypto_quote']>>
	cryptoTop(
		input?: AgentToolInputMap['crypto_top'],
	): Promise<AgentToolResponse<AgentToolOutputMap['crypto_top']>>
	cryptoHistory(
		input: AgentToolInputMap['crypto_history'],
	): Promise<AgentToolResponse<AgentToolOutputMap['crypto_history']>>
	macroSeries(
		input: AgentToolInputMap['macro_series'],
	): Promise<AgentToolResponse<AgentToolOutputMap['macro_series']>>
	macroSearch(
		query: string,
		options?: CommonToolInput & { limit?: number },
	): Promise<AgentToolResponse<AgentToolOutputMap['macro_search']>>
	providers(): Promise<AgentToolResponse<AgentToolOutputMap['provider_status']>>
	health(
		input?: AgentToolInputMap['provider_health'],
	): Promise<AgentToolResponse<AgentToolOutputMap['provider_health']>>
}

export interface OpenMarketDataClientOptions {
	runtime?: AgentRuntime
}

export function createOpenMarketDataClient(
	options: OpenMarketDataClientOptions = {},
): OpenMarketDataClient {
	const executor = createAgentExecutor(options.runtime)
	const call: OpenMarketDataClient['call'] = (name, input) => executor.execute(name, input)

	return {
		listTools: executor.listTools,
		call,
		search: (query, inputOptions = {}) => call('market_search', { query, ...inputOptions }),
		snapshot: (input) => call('company_snapshot', input),
		quotes: (symbols, inputOptions = {}) => call('stock_quotes', { symbols, ...inputOptions }),
		financials: (input) => call('stock_financials', input),
		history: (input) => call('stock_history', input),
		options: (input) => call('stock_options', input),
		earnings: (input) => call('stock_earnings', input),
		dividends: (input) => call('stock_dividends', input),
		filings: (input) => call('sec_filings', input),
		insiders: (input) => call('sec_insider_transactions', input),
		cryptoQuote: (input) => call('crypto_quote', input),
		cryptoTop: (input = {}) => call('crypto_top', input),
		cryptoHistory: (input) => call('crypto_history', input),
		macroSeries: (input) => call('macro_series', input),
		macroSearch: (query, inputOptions = {}) => call('macro_search', { query, ...inputOptions }),
		providers: () => call('provider_status', {}),
		health: (input = {}) => call('provider_health', input),
	}
}

export const openMarketData = createOpenMarketDataClient()
