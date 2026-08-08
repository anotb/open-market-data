import { describe, expect, it } from 'vitest'
import {
	boundedInteger,
	boundedText,
	choice,
	countryCode,
	isoDate,
	symbol,
} from '../src/commands/validation.js'

describe('CLI input validation', () => {
	it('accepts bounded integers and rejects partial, negative, and extreme values', () => {
		expect(boundedInteger('20', '--limit', 1, 100)).toBe(20)
		for (const value of ['2x', '-1', '101', '1.5']) {
			expect(() => boundedInteger(value, '--limit', 1, 100)).toThrow(/between 1 and 100/)
		}
	})

	it('validates closed choices and bounded text', () => {
		expect(choice('annual', '--period', ['annual', 'quarterly'] as const)).toBe('annual')
		expect(() => choice('monthly', '--period', ['annual', 'quarterly'] as const)).toThrow(
			/annual, quarterly/,
		)
		expect(boundedText(' Apple ', 'query', 20)).toBe('Apple')
		expect(() => boundedText(' ', 'query', 20)).toThrow(/1 to 20/)
	})

	it('normalizes symbols and country codes without permitting whitespace', () => {
		expect(symbol(' aapl ')).toBe('AAPL')
		expect(countryCode(' us ')).toBe('US')
		expect(() => symbol('not a symbol')).toThrow(/whitespace/)
		expect(() => countryCode('invalid')).toThrow(/ISO/)
	})

	it('accepts calendar dates and rejects impossible dates', () => {
		expect(isoDate('2024-02-29', '--start')).toBe('2024-02-29')
		expect(() => isoDate('2025-02-29', '--start')).toThrow(/valid date/)
		expect(() => isoDate('01/02/2025', '--start')).toThrow(/YYYY-MM-DD/)
	})
})
