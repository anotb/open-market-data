import { describe, expect, it } from 'vitest'
import { calculateKlineLimit } from '../src/providers/binance.js'

describe('Binance candle lookback', () => {
	it('converts calendar days to interval-aware candle counts', () => {
		expect(calculateKlineLimit(30, '1d')).toBe(30)
		expect(calculateKlineLimit(30, '1h')).toBe(720)
		expect(calculateKlineLimit(7, '1w')).toBe(1)
	})

	it('caps requests at the Binance maximum', () => {
		expect(calculateKlineLimit(30, '1m')).toBe(1000)
		expect(calculateKlineLimit(3650, '1d')).toBe(1000)
	})

	it('rejects unsupported intervals and invalid lookbacks', () => {
		expect(() => calculateKlineLimit(30, '2h')).toThrow(/unsupported interval/i)
		expect(() => calculateKlineLimit(0, '1d')).toThrow(/positive number/i)
	})
})
