import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/core/config.js'
import { alphaVantage } from '../src/providers/alpha-vantage.js'
import { binance } from '../src/providers/binance.js'
import { coingecko } from '../src/providers/coingecko.js'
import { finnhub } from '../src/providers/finnhub.js'
import { fred } from '../src/providers/fred.js'
import { secEdgar } from '../src/providers/sec-edgar.js'
import { worldBank } from '../src/providers/world-bank.js'
import { yahoo } from '../src/providers/yahoo-finance.js'
import type {
	CryptoCandle,
	CryptoQuote,
	DividendEvent,
	EarningsData,
	Filing,
	FinancialStatement,
	HistoricalQuote,
	InsiderTransaction,
	MacroSeries,
	OptionContract,
	QuoteResult,
	SearchResult,
} from '../src/types.js'

const config = loadConfig()
const describeWithFred = config.fredApiKey ? describe : describe.skip
const describeWithFinnhub = config.finnhubApiKey ? describe : describe.skip
const describeWithAlphaVantage = config.alphaVantageApiKey ? describe : describe.skip

describe('Yahoo Finance provider live API', () => {
	it('searches Microsoft and returns MSFT', async () => {
		const result = await yahoo.execute<SearchResult[]>('search', 'search', {
			query: 'Microsoft',
		})
		expect(result.source).toBe('yahoo')
		expect(result.data.some((item) => item.symbol === 'MSFT')).toBe(true)
	})

	it('fetches a real single quote and a three-symbol batch', async () => {
		const single = await yahoo.execute<QuoteResult>('quote', 'get', { symbol: 'AAPL' })
		const batch = await yahoo.execute<QuoteResult[]>('quote', 'get', {
			symbols: ['AAPL', 'MSFT', 'GOOGL'],
		})
		expect(single.data).toMatchObject({ symbol: 'AAPL', source: 'yahoo' })
		expect(single.data.price).toBeGreaterThan(0)
		expect(batch.data.map((quote) => quote.symbol).sort()).toEqual(['AAPL', 'GOOGL', 'MSFT'])
		expect(batch.data.every((quote) => quote.price > 0)).toBe(true)
	})

	it('honors annual and quarterly financial limits', async () => {
		for (const period of ['annual', 'quarterly'] as const) {
			const result = await yahoo.execute<FinancialStatement[]>('financials', 'get', {
				symbol: 'AAPL',
				period,
				limit: 2,
			})
			expect(result.data.length).toBeGreaterThan(0)
			expect(result.data.length).toBeLessThanOrEqual(2)
			expect(result.data.every((statement) => statement.period === period)).toBe(true)
			expect(isDescending(result.data.map((statement) => statement.date))).toBe(true)
		}
	})

	it('fetches ordered 30-day OHLCV history', async () => {
		const result = await yahoo.execute<HistoricalQuote[]>('history', 'get', {
			symbol: 'AAPL',
			days: 30,
		})
		expect(result.data.length).toBeGreaterThanOrEqual(15)
		expect(result.data.length).toBeLessThanOrEqual(30)
		expect(isAscending(result.data.map((quote) => quote.date))).toBe(true)
		expect(result.data.every(validOhlcv)).toBe(true)
	})

	it('fetches a live bounded options sample, earnings, and dividends', async () => {
		const options = await yahoo.execute<OptionContract[]>('options', 'get', { symbol: 'AAPL' })
		const earnings = await yahoo.execute<EarningsData[]>('earnings', 'get', { symbol: 'AAPL' })
		const dividends = await yahoo.execute<DividendEvent[]>('dividends', 'get', { symbol: 'AAPL' })
		expect(options.data.length).toBeGreaterThan(0)
		expect(options.data.slice(0, 100).every((contract) => contract.strike > 0)).toBe(true)
		expect(earnings.data.length).toBeGreaterThan(0)
		expect(
			earnings.data.some(
				(item) => typeof item.epsActual === 'number' || typeof item.epsEstimate === 'number',
			),
		).toBe(true)
		expect(dividends.data.length).toBeGreaterThan(0)
		expect(dividends.data.every((event) => event.amount > 0)).toBe(true)
	})

	it('rejects an invalid symbol actionably', async () => {
		await expect(
			yahoo.execute<QuoteResult>('quote', 'get', { symbol: 'OMD-NOT-A-REAL-SYMBOL-XYZ' }),
		).rejects.toThrow(/not found|no data|quote not found|validation/i)
	})
})

describe('SEC EDGAR provider live API', () => {
	it('searches Apple and returns AAPL', async () => {
		const result = await secEdgar.execute<SearchResult[]>('search', 'search', { query: 'Apple' })
		expect(result.source).toBe('sec-edgar')
		expect(result.data.some((item) => item.symbol === 'AAPL')).toBe(true)
	})

	it('fetches the latest AAPL 10-K with a valid accession and filing date', async () => {
		const result = await secEdgar.execute<Filing[]>('filing', 'list', {
			symbol: 'AAPL',
			type: '10-K',
			latest: true,
			limit: 5,
		})
		expect(result.data).toHaveLength(1)
		expect(result.data[0]).toMatchObject({ form: '10-K', source: 'sec-edgar' })
		expect(result.data[0].accessionNumber).toMatch(/^\d{10}-\d{2}-\d{6}$/)
		expect(result.data[0].filingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})

	it('fetches recent annual AAPL XBRL financials', async () => {
		const result = await secEdgar.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'AAPL',
			period: 'annual',
			limit: 2,
		})
		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data.length).toBeLessThanOrEqual(2)
		expect(result.data.every((statement) => statement.source === 'sec-edgar')).toBe(true)
		expect(result.data.some((statement) => (statement.revenue ?? 0) > 0)).toBe(true)
	})

	it('returns recent AAPL Form 4 filing results within the requested limit', async () => {
		const result = await secEdgar.execute<InsiderTransaction[]>('insiders', 'list', {
			symbol: 'AAPL',
			limit: 5,
		})
		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data.length).toBeLessThanOrEqual(5)
		expect(result.data.every((transaction) => transaction.source === 'sec-edgar')).toBe(true)
		expect(result.data[0].accessionNumber).toBeTruthy()
	})

	it('rejects an invalid ticker actionably', async () => {
		await expect(
			secEdgar.execute<Filing[]>('filing', 'list', {
				symbol: 'OMDNOTREAL',
				limit: 1,
			}),
		).rejects.toThrow(/not found.*SEC EDGAR/i)
	})
})

describe('World Bank provider live API', () => {
	it('searches WDI indicators for GDP', async () => {
		const result = await worldBank.execute<Array<{ id: string; title: string }>>(
			'macro',
			'search',
			{ query: 'GDP', limit: 10 },
		)
		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data.length).toBeLessThanOrEqual(10)
		expect(result.data.some((indicator) => /GDP/i.test(indicator.title))).toBe(true)
	})

	it('fetches recent GDP for the US and India with limits honored', async () => {
		const results = await Promise.all(
			['US', 'IN'].map((country) =>
				worldBank.execute<MacroSeries>('macro', 'get', {
					seriesId: 'NY.GDP.MKTP.CD',
					country,
					limit: 2,
				}),
			),
		)
		for (const result of results) {
			expect(result.source).toBe('worldbank')
			expect(result.data.data.length).toBeGreaterThan(0)
			expect(result.data.data.length).toBeLessThanOrEqual(2)
			expect(result.data.data.at(-1)?.value).toBeGreaterThan(0)
			expect(isAscending(result.data.data.map((point) => point.date))).toBe(true)
		}
	})

	it('honors date filtering', async () => {
		const result = await worldBank.execute<MacroSeries>('macro', 'get', {
			seriesId: 'NY.GDP.MKTP.CD',
			country: 'US',
			start: '2020-01-01',
			end: '2022-12-31',
		})
		expect(result.data.data.map((point) => point.date)).toEqual(['2020', '2021', '2022'])
	})

	it('rejects invalid country codes and reports a missing indicator truthfully', async () => {
		await expect(
			worldBank.execute<MacroSeries>('macro', 'get', {
				seriesId: 'NY.GDP.MKTP.CD',
				country: 'INVALID',
			}),
		).rejects.toThrow(/Invalid country code/)
		await expect(
			worldBank.execute<MacroSeries>('macro', 'get', {
				seriesId: 'OMD.DOES.NOT.EXIST',
				country: 'US',
				limit: 2,
			}),
		).rejects.toThrow(/Invalid value|not valid/i)
	})
})

describe('Binance provider live API', () => {
	it('fetches BTC quote and point price from the public market-data host', async () => {
		const quote = await binance.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })
		const price = await binance.execute<{ symbol: string; price: number }>('crypto', 'price', {
			symbol: 'BTC',
		})
		expect(quote.source).toBe('binance')
		expect(quote.data.price).toBeGreaterThan(0)
		expect(price.data).toMatchObject({ symbol: 'BTC' })
		expect(price.data.price).toBeGreaterThan(0)
	})

	it('honors day ranges for daily and hourly BTC candles', async () => {
		const daily = await binance.execute<CryptoCandle[]>('crypto', 'history', {
			symbol: 'BTC',
			days: 7,
			interval: '1d',
		})
		const hourly = await binance.execute<CryptoCandle[]>('crypto', 'history', {
			symbol: 'BTC',
			days: 2,
			interval: '1h',
		})
		expect(daily.data).toHaveLength(7)
		expect(hourly.data).toHaveLength(48)
		expect([...daily.data, ...hourly.data].every(validCryptoCandle)).toBe(true)
	})

	it('rejects unsupported intervals and unknown symbols', async () => {
		await expect(
			binance.execute<CryptoCandle[]>('crypto', 'history', {
				symbol: 'BTC',
				days: 1,
				interval: '2h',
			}),
		).rejects.toThrow(/Unsupported interval/)
		await expect(
			binance.execute<CryptoQuote>('crypto', 'quote', { symbol: 'OMDNOTREAL' }),
		).rejects.toThrow(/Binance API error 400|Invalid symbol/i)
	})
})

describe('CoinGecko provider live API', () => {
	it('searches bitcoin and fetches a positive keyless-or-demo-key quote', async () => {
		const search = await coingecko.execute<SearchResult[]>('search', 'search', { query: 'bitcoin' })
		const quote = await coingecko.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })
		expect(coingecko.isEnabled()).toBe(true)
		expect(search.data.some((item) => item.symbol === 'BTC')).toBe(true)
		expect(quote.source).toBe('coingecko')
		expect(quote.data.price).toBeGreaterThan(0)
	})

	it('returns an ordered top-ten market ranking', async () => {
		const result = await coingecko.execute<CryptoQuote[]>('crypto', 'top', { limit: 10 })
		expect(result.data).toHaveLength(10)
		expect(result.data.map((quote) => quote.marketCapRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		expect(result.data.every((quote) => quote.price > 0)).toBe(true)
	})

	it('fetches 30-day BTC OHLCV history', async () => {
		const result = await coingecko.execute<CryptoCandle[]>('crypto', 'history', {
			symbol: 'BTC',
			days: 30,
			interval: '1d',
		})
		expect(result.data.length).toBeGreaterThan(20)
		expect(result.data.every(validCryptoCandle)).toBe(true)
		expect(isAscending(result.data.map((candle) => candle.time))).toBe(true)
	})

	it('rejects an unknown token truthfully', async () => {
		await expect(
			coingecko.execute<CryptoQuote>('crypto', 'quote', { symbol: 'OMDNOTAREALTOKENXYZ' }),
		).rejects.toThrow(/could not resolve coin ID/)
	})
})

describeWithFred('FRED provider live API', () => {
	it('fetches recent GDP metadata and observations in chronological order', async () => {
		const result = await fred.execute<MacroSeries>('macro', 'get', {
			seriesId: 'GDP',
			limit: 2,
		})
		expect(result.source).toBe('fred')
		expect(result.data).toMatchObject({ id: 'GDP', source: 'fred' })
		expect(result.data.title).toMatch(/Gross Domestic Product/i)
		expect(result.data.data).toHaveLength(2)
		expect(isAscending(result.data.data.map((point) => point.date))).toBe(true)
	})

	it('searches inflation series', async () => {
		const result = await fred.execute<Array<{ id: string; title: string }>>('macro', 'search', {
			query: 'inflation',
			limit: 5,
		})
		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data.length).toBeLessThanOrEqual(5)
		expect(result.data.some((series) => /inflation/i.test(series.title))).toBe(true)
	})

	it('honors date filtering and rejects an invalid series', async () => {
		const filtered = await fred.execute<MacroSeries>('macro', 'get', {
			seriesId: 'GDP',
			start: '2024-01-01',
			end: '2024-12-31',
		})
		expect(filtered.data.data.length).toBeGreaterThan(0)
		expect(
			filtered.data.data.every((point) => point.date >= '2024-01-01' && point.date <= '2024-12-31'),
		).toBe(true)
		await expect(
			fred.execute<MacroSeries>('macro', 'get', { seriesId: 'OMD_DOES_NOT_EXIST_XYZ' }),
		).rejects.toThrow(/FRED API error|Bad Request|not found/i)
	})
})

describeWithFinnhub('Finnhub provider live API', () => {
	it('searches Microsoft and fetches a nonzero AAPL quote', async () => {
		const search = await finnhub.execute<SearchResult[]>('search', 'search', { query: 'Microsoft' })
		const quote = await finnhub.execute<QuoteResult>('quote', 'get', { symbol: 'AAPL' })
		expect(search.data.some((item) => item.symbol === 'MSFT')).toBe(true)
		expect(quote.source).toBe('finnhub')
		expect(quote.data).toMatchObject({ symbol: 'AAPL', source: 'finnhub' })
		expect(quote.data.price).toBeGreaterThan(0)
	})

	it('fetches AAPL earnings with usable values', async () => {
		const result = await finnhub.execute<EarningsData[]>('earnings', 'get', { symbol: 'AAPL' })
		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data[0].earningsDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(
			result.data.some(
				(item) => typeof item.epsActual === 'number' || typeof item.epsEstimate === 'number',
			),
		).toBe(true)
	})

	it('rejects an invalid ticker', async () => {
		await expect(
			finnhub.execute<QuoteResult>('quote', 'get', { symbol: 'OMDNOTREAL' }),
		).rejects.toThrow(/No quote data|invalid/i)
	})
})

describeWithAlphaVantage('Alpha Vantage provider live API', () => {
	it('searches IBM and fetches a live IBM quote', async () => {
		const search = await alphaVantage.execute<SearchResult[]>('search', 'search', { query: 'IBM' })
		const quote = await alphaVantage.execute<QuoteResult>('quote', 'get', { symbol: 'IBM' })
		expect(search.data.some((item) => item.symbol === 'IBM')).toBe(true)
		expect(quote.source).toBe('alphavantage')
		expect(quote.data).toMatchObject({ symbol: 'IBM', source: 'alphavantage' })
		expect(quote.data.price).toBeGreaterThan(0)
	})

	it('honors IBM financial and history limits', async () => {
		const financials = await alphaVantage.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'IBM',
			period: 'annual',
			limit: 2,
		})
		const history = await alphaVantage.execute<HistoricalQuote[]>('history', 'get', {
			symbol: 'IBM',
			days: 5,
		})
		expect(financials.data.length).toBeGreaterThan(0)
		expect(financials.data.length).toBeLessThanOrEqual(2)
		expect(history.data).toHaveLength(5)
		expect(history.data.every(validOhlcv)).toBe(true)
	})
})

function isAscending(values: string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1] <= value)
}

function isDescending(values: string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1] >= value)
}

function validOhlcv(quote: HistoricalQuote): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(quote.date) &&
		quote.open > 0 &&
		quote.high >= quote.low &&
		quote.close > 0 &&
		quote.volume >= 0
	)
}

function validCryptoCandle(candle: CryptoCandle): boolean {
	return (
		!Number.isNaN(Date.parse(candle.time)) &&
		candle.open > 0 &&
		candle.high >= candle.low &&
		candle.close > 0 &&
		candle.volume >= 0
	)
}
