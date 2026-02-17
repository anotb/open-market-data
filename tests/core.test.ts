import { describe, it, expect, beforeEach } from 'vitest'
import { canRequest, consumeToken, getRemaining, resetBucket } from '../src/core/rate-limiter.js'
import * as cache from '../src/core/cache.js'
import { formatTable, formatKeyValue, formatNumber, formatCurrency, formatPercent } from '../src/core/formatter.js'
import type { RateLimitConfig } from '../src/providers/types.js'

describe('rate-limiter', () => {
	const config: RateLimitConfig = { maxRequests: 5, windowMs: 1000 }

	beforeEach(() => {
		resetBucket('test')
	})

	it('allows requests within limit', () => {
		expect(canRequest('test', config)).toBe(true)
		expect(getRemaining('test', config)).toBe(5)
	})

	it('consumes tokens correctly', () => {
		expect(consumeToken('test', config)).toBe(true)
		expect(consumeToken('test', config)).toBe(true)
		expect(getRemaining('test', config)).toBe(3)
	})

	it('rejects when exhausted', () => {
		for (let i = 0; i < 5; i++) consumeToken('test', config)
		expect(consumeToken('test', config)).toBe(false)
		expect(canRequest('test', config)).toBe(false)
	})
})

describe('cache', () => {
	beforeEach(() => {
		cache.clear()
	})

	it('stores and retrieves values', () => {
		cache.set('test', 'quote', { symbol: 'AAPL' }, { price: 100 })
		const result = cache.get('test', 'quote', { symbol: 'AAPL' })
		expect(result).toEqual({ price: 100 })
	})

	it('returns undefined for missing keys', () => {
		const result = cache.get('test', 'quote', { symbol: 'NOPE' })
		expect(result).toBeUndefined()
	})

	it('tracks size', () => {
		expect(cache.size()).toBe(0)
		cache.set('test', 'quote', { symbol: 'AAPL' }, { price: 100 })
		expect(cache.size()).toBe(1)
	})

	it('uses consistent keys regardless of arg order', () => {
		cache.set('test', 'quote', { a: 1, b: 2 }, 'val1')
		const result = cache.get('test', 'quote', { b: 2, a: 1 })
		expect(result).toBe('val1')
	})
})

describe('formatter', () => {
	it('formats markdown tables', () => {
		const result = formatTable(['Name', 'Value'], [['AAPL', '100']], 'markdown')
		expect(result).toContain('| Name')
		expect(result).toContain('| AAPL')
		expect(result).toContain('---')
	})

	it('formats JSON tables', () => {
		const result = formatTable(['Name', 'Value'], [['AAPL', '100']], 'json')
		const parsed = JSON.parse(result)
		expect(parsed).toEqual([{ Name: 'AAPL', Value: '100' }])
	})

	it('formats plain tables', () => {
		const result = formatTable(['Name', 'Value'], [['AAPL', '100']], 'plain')
		expect(result).toContain('Name\tValue')
		expect(result).toContain('AAPL\t100')
	})

	it('formats key-value pairs', () => {
		const result = formatKeyValue({ Price: '$100', Volume: '1M' }, 'markdown')
		expect(result).toContain('**Price')
		expect(result).toContain('$100')
	})

	it('formats numbers with suffixes', () => {
		expect(formatNumber(1_500_000_000)).toBe('1.50B')
		expect(formatNumber(2_300_000)).toBe('2.30M')
		expect(formatNumber(45_000)).toBe('45.00K')
		expect(formatNumber(1_200_000_000_000)).toBe('1.20T')
	})

	it('formats currency', () => {
		expect(formatCurrency(1234.56)).toBe('$1,234.56')
	})

	it('formats percentages', () => {
		expect(formatPercent(3.14)).toBe('+3.14%')
		expect(formatPercent(-2.5)).toBe('-2.50%')
	})
})
