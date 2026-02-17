import { describe, it, expect } from 'vitest'
import { yahoo } from '../src/providers/yahoo-finance.js'
import { secEdgar } from '../src/providers/sec-edgar.js'
import { binance } from '../src/providers/binance.js'
import type { QuoteResult, SearchResult, FinancialStatement, Filing, CryptoQuote, CryptoCandle } from '../src/types.js'

describe('yahoo provider (real API)', () => {
	it('is enabled without key', () => {
		expect(yahoo.isEnabled()).toBe(true)
		expect(yahoo.requiresKey).toBe(false)
	})

	it('fetches a real quote for AAPL', async () => {
		const result = await yahoo.execute<QuoteResult>('quote', 'get', { symbol: 'AAPL' })
		expect(result.source).toBe('yahoo')
		expect(result.data.symbol).toBe('AAPL')
		expect(result.data.price).toBeGreaterThan(0)
		expect(typeof result.data.change).toBe('number')
		expect(typeof result.data.changePercent).toBe('number')
	})

	it('searches for companies', async () => {
		const result = await yahoo.execute<SearchResult[]>('search', 'search', { query: 'Microsoft' })
		expect(result.data.length).toBeGreaterThan(0)
		const msft = result.data.find((r) => r.symbol === 'MSFT')
		expect(msft).toBeDefined()
		expect(msft?.name).toContain('Microsoft')
	})

	it('fetches financials for AAPL', async () => {
		const result = await yahoo.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'AAPL',
			period: 'annual',
		})
		expect(result.data.length).toBeGreaterThan(0)
		const latest = result.data[0]
		expect(latest.source).toBe('yahoo')
		expect(latest.period).toBe('annual')
		expect(latest.date).toBeTruthy()
	})
})

describe('sec-edgar provider (real API)', () => {
	it('is enabled without key', () => {
		expect(secEdgar.isEnabled()).toBe(true)
		expect(secEdgar.requiresKey).toBe(false)
	})

	it('fetches filings for AAPL', async () => {
		const result = await secEdgar.execute<Filing[]>('filing', 'list', { symbol: 'AAPL' })
		expect(result.source).toBe('sec-edgar')
		expect(result.data.length).toBeGreaterThan(0)
		const filing = result.data[0]
		expect(filing.form).toBeTruthy()
		expect(filing.filingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(filing.accessionNumber).toBeTruthy()
	})

	it('fetches 10-K filings specifically', async () => {
		const result = await secEdgar.execute<Filing[]>('filing', 'list', {
			symbol: 'AAPL',
			type: '10-K',
		})
		expect(result.data.length).toBeGreaterThan(0)
		for (const f of result.data) {
			expect(f.form).toBe('10-K')
		}
	})

	it('fetches XBRL financials for AAPL', async () => {
		const result = await secEdgar.execute<FinancialStatement[]>('financials', 'get', {
			symbol: 'AAPL',
			period: 'annual',
		})
		expect(result.data.length).toBeGreaterThan(0)
		const latest = result.data[0]
		expect(latest.date).toBeTruthy()
		expect(latest.source).toBe('sec-edgar')
	})
})

describe('binance provider (real API)', () => {
	it('is enabled without key', () => {
		expect(binance.isEnabled()).toBe(true)
		expect(binance.requiresKey).toBe(false)
	})

	it('fetches BTC price or fails gracefully in restricted regions', async () => {
		try {
			const result = await binance.execute<CryptoQuote>('crypto', 'quote', { symbol: 'BTC' })
			expect(result.source).toBe('binance')
			expect(result.data.price).toBeGreaterThan(0)
			expect(result.data.symbol).toBe('BTC')
		} catch (err) {
			// Binance is geo-restricted in some regions (451)
			expect((err as Error).message).toContain('Binance')
		}
	})

	it('fetches BTC klines or fails gracefully', async () => {
		try {
			const result = await binance.execute<CryptoCandle[]>('crypto', 'history', {
				symbol: 'BTC',
				days: 7,
			})
			expect(result.data.length).toBeGreaterThan(0)
			const candle = result.data[0]
			expect(candle.open).toBeGreaterThan(0)
			expect(candle.close).toBeGreaterThan(0)
		} catch (err) {
			expect((err as Error).message).toContain('Binance')
		}
	})
})
