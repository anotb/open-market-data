import { describe, expect, it } from 'vitest'
import {
	formatCurrency,
	formatKeyValue,
	formatNumber,
	formatPercent,
	formatTable,
} from '../../src/core/formatter.js'
import type { OutputFormat } from '../../src/types.js'

/**
 * formatter.ts produces user-visible terminal output, so every assertion here is
 * an exact string. Nothing in this module touches I/O, the clock, or the network.
 */

const lines = (...ls: string[]) => ls.join('\n')

/** Splits a rendered markdown line back into its padded cells. */
const mdCells = (line: string) => line.slice(2, -2).split(' | ')

// `formatTable`/`formatKeyValue` fall through to markdown for anything that is
// neither 'json' nor 'plain'; the double cast lets us reach that branch.
const UNKNOWN_FORMAT = 'csv' as unknown as OutputFormat

describe('formatTable — markdown', () => {
	it('renders a header row, a separator row, and one line per data row', () => {
		expect(formatTable(['A', 'Value'], [['x', '1']], 'markdown')).toBe(
			lines('| A | Value |', '| - | ----- |', '| x | 1     |'),
		)
	})

	it('widens a column when a data cell is wider than its header', () => {
		expect(formatTable(['A', 'B'], [['alpha', 'b']], 'markdown')).toBe(
			lines('| A     | B |', '| ----- | - |', '| alpha | b |'),
		)
	})

	it('pads data cells out to the header width when the header is wider', () => {
		expect(formatTable(['Description'], [['x']], 'markdown')).toBe(
			lines('| Description |', '| ----------- |', '| x           |'),
		)
	})

	it('sizes a column from the widest cell across all rows', () => {
		expect(formatTable(['Sym'], [['A'], ['LONGER']], 'markdown')).toBe(
			lines('| Sym    |', '| ------ |', '| A      |', '| LONGER |'),
		)
	})

	it('keeps every line the same width for a rectangular table', () => {
		const out = formatTable(
			['Symbol', 'Company'],
			[
				['AAPL', 'Apple Inc.'],
				['MSFT', 'Microsoft Corp'],
			],
			'markdown',
		)

		expect(out).toBe(
			lines(
				'| Symbol | Company        |',
				'| ------ | -------------- |',
				'| AAPL   | Apple Inc.     |',
				'| MSFT   | Microsoft Corp |',
			),
		)
	})

	it('makes each separator run exactly as wide as its column', () => {
		// 'Ticker' is wider than its data cell and '55.5' is wider than the 'P/E'
		// header, so one table exercises both directions of the column-width max.
		const out = formatTable(['Ticker', 'P/E'], [['NVDA', '55.5']], 'markdown')
		const [header, separator, row] = out.split('\n')

		expect(separator).toBe('| ------ | ---- |')
		// Only the separator is pinned above, so measuring the header and data cells
		// against it catches a padding regression that leaves the separator intact.
		expect(mdCells(header)).toEqual(['Ticker', 'P/E '])
		expect(mdCells(row)).toEqual(['NVDA  ', '55.5'])
	})

	it('emits only the header and separator when there are no rows', () => {
		expect(formatTable(['A', 'BB'], [], 'markdown')).toBe(lines('| A | BB |', '| - | -- |'))
	})

	it('renders null and undefined cells as blank padded cells', () => {
		expect(formatTable(['A', 'B', 'C'], [['x', null, undefined]], 'markdown')).toBe(
			lines('| A | B | C |', '| - | - | - |', '| x |   |   |'),
		)
	})

	it('does not let a null cell shrink a column below its header width', () => {
		expect(formatTable(['Volume'], [[null]], 'markdown')).toBe(
			lines('| Volume |', '| ------ |', '|        |'),
		)
	})

	it('stringifies numeric cells and sizes columns from their rendered length', () => {
		expect(formatTable(['N'], [[1234.5]], 'markdown')).toBe(
			lines('| N      |', '| ------ |', '| 1234.5 |'),
		)
	})

	it('treats a zero cell as data rather than as an empty cell', () => {
		expect(formatTable(['N'], [[0]], 'markdown')).toBe(lines('| N |', '| - |', '| 0 |'))
	})

	it('renders an empty-string cell as blank padding', () => {
		expect(formatTable(['AB'], [['']], 'markdown')).toBe(lines('| AB |', '| -- |', '|    |'))
	})

	it('emits a degenerate one-cell frame when headers are empty', () => {
		expect(formatTable([], [], 'markdown')).toBe(lines('|  |', '|  |'))
	})

	it('still renders row cells when headers are empty', () => {
		// NOTE: suspected bug — with no headers there are no column widths, so data
		// rows are emitted with columns the header/separator rows do not have.
		expect(formatTable([], [['x', 'y']], 'markdown')).toBe(lines('|  |', '|  |', '| x | y |'))
	})

	it('emits a short row when a row has fewer cells than headers', () => {
		// NOTE: suspected bug — ragged rows are not padded to the header count, so the
		// markdown table is malformed (this row has 2 columns, the header has 3).
		expect(formatTable(['A', 'B', 'C'], [['x', 'y']], 'markdown')).toBe(
			lines('| A | B | C |', '| - | - | - |', '| x | y |'),
		)
	})

	it('emits extra unpadded columns when a row has more cells than headers', () => {
		// NOTE: suspected bug — cells past the header count have no colWidth, so they
		// are appended without padding and the table loses alignment.
		expect(
			formatTable(
				['A'],
				[
					['x', 'ex'],
					['y', 'longer'],
				],
				'markdown',
			),
		).toBe(lines('| A |', '| - |', '| x | ex |', '| y | longer |'))
	})

	it('ignores overflow cells when computing column widths', () => {
		expect(formatTable(['A'], [['x', 'a-very-long-overflow-cell']], 'markdown')).toBe(
			lines('| A |', '| - |', '| x | a-very-long-overflow-cell |'),
		)
	})

	it('falls back to markdown for an unrecognised format', () => {
		expect(formatTable(['A'], [['x']], UNKNOWN_FORMAT)).toBe(lines('| A |', '| - |', '| x |'))
	})
})

describe('formatTable — json', () => {
	it('emits an array of header-keyed objects indented by two spaces', () => {
		expect(formatTable(['Name', 'Value'], [['AAPL', '100']], 'json')).toBe(
			lines('[', '  {', '    "Name": "AAPL",', '    "Value": "100"', '  }', ']'),
		)
	})

	it('emits an empty array for no rows', () => {
		expect(formatTable(['Name'], [], 'json')).toBe('[]')
	})

	it('round-trips through JSON.parse with nulls preserved', () => {
		const parsed = JSON.parse(formatTable(['A', 'B'], [['x', null]], 'json'))
		expect(parsed).toEqual([{ A: 'x', B: null }])
		expect(parsed[0].B).toBeNull()
	})

	it('converts undefined cells to null so the key survives', () => {
		const parsed = JSON.parse(formatTable(['A', 'B'], [['x', undefined]], 'json'))
		expect(Object.keys(parsed[0])).toEqual(['A', 'B'])
		expect(parsed[0].B).toBeNull()
	})

	it('fills missing trailing cells with null', () => {
		expect(JSON.parse(formatTable(['A', 'B', 'C'], [['x']], 'json'))).toEqual([
			{ A: 'x', B: null, C: null },
		])
	})

	it('drops cells that have no matching header', () => {
		expect(JSON.parse(formatTable(['A'], [['x', 'dropped']], 'json'))).toEqual([{ A: 'x' }])
	})

	it('preserves numeric cells as JSON numbers', () => {
		const parsed = JSON.parse(formatTable(['Price', 'Volume'], [[193.42, 0]], 'json'))
		expect(parsed).toEqual([{ Price: 193.42, Volume: 0 }])
		expect(typeof parsed[0].Price).toBe('number')
		expect(typeof parsed[0].Volume).toBe('number')
	})

	it('keeps an empty-string cell as an empty string rather than null', () => {
		expect(JSON.parse(formatTable(['A'], [['']], 'json'))).toEqual([{ A: '' }])
	})

	it('emits one empty object per row when headers are empty', () => {
		expect(formatTable([], [['x'], ['y']], 'json')).toBe(lines('[', '  {},', '  {}', ']'))
	})

	it('collapses duplicate headers, keeping the last matching cell', () => {
		// NOTE: suspected bug — duplicate column names silently overwrite each other
		// in JSON output, so a column of data disappears.
		expect(JSON.parse(formatTable(['A', 'A'], [['first', 'second']], 'json'))).toEqual([
			{ A: 'second' },
		])
	})

	it('emits one object per row for multi-row input', () => {
		expect(
			JSON.parse(
				formatTable(
					['Symbol', 'Price'],
					[
						['AAPL', 193.42],
						['MSFT', 421.9],
					],
					'json',
				),
			),
		).toEqual([
			{ Symbol: 'AAPL', Price: 193.42 },
			{ Symbol: 'MSFT', Price: 421.9 },
		])
	})
})

describe('formatTable — plain', () => {
	it('separates the header and each row with tabs', () => {
		expect(formatTable(['Name', 'Value'], [['AAPL', '100']], 'plain')).toBe(
			lines('Name\tValue', 'AAPL\t100'),
		)
	})

	it('emits only the header line when there are no rows', () => {
		expect(formatTable(['Name', 'Value'], [], 'plain')).toBe('Name\tValue')
	})

	it('substitutes an empty string for null and undefined cells', () => {
		expect(formatTable(['A', 'B', 'C'], [['x', null, undefined]], 'plain')).toBe(
			lines('A\tB\tC', 'x\t\t'),
		)
	})

	it('keeps zero and empty-string cells distinct from missing ones', () => {
		expect(formatTable(['A', 'B'], [[0, '']], 'plain')).toBe(lines('A\tB', '0\t'))
	})

	it('stringifies numeric cells', () => {
		expect(formatTable(['Price', 'Volume'], [[193.42, 1000000]], 'plain')).toBe(
			lines('Price\tVolume', '193.42\t1000000'),
		)
	})

	it('emits a leading blank line when headers are empty', () => {
		expect(formatTable([], [['x']], 'plain')).toBe(lines('', 'x'))
	})

	it('emits a single empty line for empty headers and no rows', () => {
		expect(formatTable([], [], 'plain')).toBe('')
	})

	it('emits fewer fields for a row shorter than the headers', () => {
		// NOTE: suspected bug — ragged rows are not padded, so plain output columns
		// no longer line up with the header fields.
		expect(formatTable(['A', 'B', 'C'], [['x']], 'plain')).toBe(lines('A\tB\tC', 'x'))
	})

	it('emits extra fields for a row longer than the headers', () => {
		expect(formatTable(['A'], [['x', 'y']], 'plain')).toBe(lines('A', 'x\ty'))
	})

	it('does not append a trailing newline', () => {
		const out = formatTable(['A'], [['x'], ['y']], 'plain')
		expect(out.endsWith('\n')).toBe(false)
		expect(out.split('\n')).toHaveLength(3)
	})
})

describe('formatKeyValue — markdown', () => {
	it('bolds keys padded to the longest key and separates with a colon', () => {
		expect(formatKeyValue({ Price: '$100', Volume: '1M' }, 'markdown')).toBe(
			lines('**Price **: $100', '**Volume**: 1M'),
		)
	})

	it('does not pad when every key is the same length', () => {
		expect(formatKeyValue({ ab: '1', cd: '2' }, 'markdown')).toBe(lines('**ab**: 1', '**cd**: 2'))
	})

	it('drops null and undefined values', () => {
		expect(formatKeyValue({ a: '1', b: null, c: undefined, d: '2' }, 'markdown')).toBe(
			lines('**a**: 1', '**d**: 2'),
		)
	})

	it('ignores dropped keys when computing the padding width', () => {
		expect(formatKeyValue({ short: '1', aVeryLongKeyName: null }, 'markdown')).toBe('**short**: 1')
	})

	it('keeps zero and empty-string values', () => {
		expect(formatKeyValue({ zero: 0, empty: '' }, 'markdown')).toBe(
			lines('**zero **: 0', '**empty**: '),
		)
	})

	it('renders numeric values without quoting them', () => {
		expect(formatKeyValue({ Price: 193.42 }, 'markdown')).toBe('**Price**: 193.42')
	})

	it('returns an empty string for an empty object', () => {
		expect(formatKeyValue({}, 'markdown')).toBe('')
	})

	it('returns an empty string when every value is nullish', () => {
		expect(formatKeyValue({ a: null, b: undefined }, 'markdown')).toBe('')
	})

	it('preserves insertion order of the keys', () => {
		expect(formatKeyValue({ zebra: '1', apple: '2', mango: '3' }, 'markdown')).toBe(
			lines('**zebra**: 1', '**apple**: 2', '**mango**: 3'),
		)
	})

	it('falls back to markdown for an unrecognised format', () => {
		expect(formatKeyValue({ a: '1' }, UNKNOWN_FORMAT)).toBe('**a**: 1')
	})
})

describe('formatKeyValue — plain', () => {
	it('emits tab-separated key/value lines', () => {
		expect(formatKeyValue({ Price: '$100', Volume: '1M' }, 'plain')).toBe(
			lines('Price\t$100', 'Volume\t1M'),
		)
	})

	it('drops null and undefined values', () => {
		expect(formatKeyValue({ a: '1', b: null, c: undefined }, 'plain')).toBe('a\t1')
	})

	it('keeps zero and empty-string values', () => {
		expect(formatKeyValue({ zero: 0, empty: '' }, 'plain')).toBe(lines('zero\t0', 'empty\t'))
	})

	it('returns an empty string for an empty object', () => {
		expect(formatKeyValue({}, 'plain')).toBe('')
	})

	it('does not pad keys', () => {
		expect(formatKeyValue({ a: '1', longer: '2' }, 'plain')).toBe(lines('a\t1', 'longer\t2'))
	})
})

describe('formatKeyValue — json', () => {
	it('emits the object indented by two spaces', () => {
		expect(formatKeyValue({ Price: '$100', Volume: '1M' }, 'json')).toBe(
			lines('{', '  "Price": "$100",', '  "Volume": "1M"', '}'),
		)
	})

	it('keeps null values instead of dropping them like the other formats', () => {
		expect(formatKeyValue({ a: 1, b: null, c: undefined }, 'json')).toBe(
			lines('{', '  "a": 1,', '  "b": null', '}'),
		)
	})

	it('round-trips numbers as numbers', () => {
		const parsed = JSON.parse(formatKeyValue({ price: 193.42, volume: 0 }, 'json'))
		expect(parsed).toEqual({ price: 193.42, volume: 0 })
		expect(typeof parsed.price).toBe('number')
	})

	it('emits an empty object literal for an empty input', () => {
		expect(formatKeyValue({}, 'json')).toBe('{}')
	})

	it('escapes characters that are special in JSON', () => {
		expect(JSON.parse(formatKeyValue({ 'a"b': 'line1\nline2' }, 'json'))).toEqual({
			'a"b': 'line1\nline2',
		})
	})
})

describe('formatNumber — magnitude thresholds', () => {
	it('leaves values below one thousand unscaled', () => {
		expect(formatNumber(0)).toBe('0.00')
		expect(formatNumber(1)).toBe('1.00')
		expect(formatNumber(999)).toBe('999.00')
	})

	it('switches to K at exactly 1000', () => {
		expect(formatNumber(1000)).toBe('1.00K')
		expect(formatNumber(999.99)).toBe('999.99')
	})

	it('rounds a just-under-K value up to 1000.00 rather than promoting it', () => {
		// NOTE: suspected bug — values within rounding distance of a threshold render
		// as e.g. "1000.00" / "1000.00K" instead of being promoted to the next suffix.
		expect(formatNumber(999.999)).toBe('1000.00')
		expect(formatNumber(999_999)).toBe('1000.00K')
		expect(formatNumber(999_999_999)).toBe('1000.00M')
		expect(formatNumber(999_999_999_999)).toBe('1000.00B')
	})

	it('switches to M at exactly 1e6', () => {
		expect(formatNumber(999_499)).toBe('999.50K')
		expect(formatNumber(1_000_000)).toBe('1.00M')
	})

	it('switches to B at exactly 1e9', () => {
		expect(formatNumber(999_499_999)).toBe('999.50M')
		expect(formatNumber(1_000_000_000)).toBe('1.00B')
	})

	it('switches to T at exactly 1e12', () => {
		expect(formatNumber(999_499_999_999)).toBe('999.50B')
		expect(formatNumber(1_000_000_000_000)).toBe('1.00T')
	})

	it('keeps using T above one trillion', () => {
		expect(formatNumber(3_450_000_000_000)).toBe('3.45T')
		expect(formatNumber(1e15)).toBe('1000.00T')
	})

	it('formats representative magnitudes the way the CLI displays them', () => {
		expect(formatNumber(45_000)).toBe('45.00K')
		expect(formatNumber(2_300_000)).toBe('2.30M')
		expect(formatNumber(1_500_000_000)).toBe('1.50B')
		expect(formatNumber(1_200_000_000_000)).toBe('1.20T')
	})
})

describe('formatNumber — signs and special values', () => {
	it('keeps the sign at every magnitude', () => {
		expect(formatNumber(-1)).toBe('-1.00')
		expect(formatNumber(-999)).toBe('-999.00')
		expect(formatNumber(-1000)).toBe('-1.00K')
		expect(formatNumber(-1_000_000)).toBe('-1.00M')
		expect(formatNumber(-1_000_000_000)).toBe('-1.00B')
		expect(formatNumber(-1_000_000_000_000)).toBe('-1.00T')
	})

	it('uses the absolute value only for the threshold, not the division', () => {
		expect(formatNumber(-2_500_000)).toBe('-2.50M')
		expect(formatNumber(-999.5)).toBe('-999.50')
	})

	it('drops the sign of negative zero', () => {
		// NOTE: minor — Number.prototype.toFixed renders -0 as "0.00".
		expect(formatNumber(-0)).toBe('0.00')
	})

	it('renders sub-cent magnitudes as zero', () => {
		expect(formatNumber(0.001)).toBe('0.00')
		expect(formatNumber(Number.MIN_VALUE)).toBe('0.00')
	})

	it('returns NaN unsuffixed', () => {
		expect(formatNumber(Number.NaN)).toBe('NaN')
	})

	it('suffixes infinities with T', () => {
		// NOTE: suspected bug — Math.abs(Infinity) >= 1e12 so infinities are divided
		// and rendered as "InfinityT" / "-InfinityT".
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('InfinityT')
		expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe('-InfinityT')
	})

	it('falls back to exponential notation for absurdly large values', () => {
		expect(formatNumber(Number.MAX_VALUE)).toBe('1.797693134862316e+296T')
	})
})

describe('formatNumber — decimals parameter', () => {
	it('defaults to two decimal places', () => {
		expect(formatNumber(1234)).toBe('1.23K')
	})

	it('supports zero decimals and rounds half away from zero', () => {
		expect(formatNumber(1234, 0)).toBe('1K')
		expect(formatNumber(1500, 0)).toBe('2K')
		expect(formatNumber(999, 0)).toBe('999')
	})

	it('supports a single decimal place', () => {
		expect(formatNumber(1234, 1)).toBe('1.2K')
		expect(formatNumber(1_250_000, 1)).toBe('1.3M')
	})

	it('supports five decimal places, padding with zeros', () => {
		expect(formatNumber(1234, 5)).toBe('1.23400K')
		expect(formatNumber(1_000_000_000_000, 5)).toBe('1.00000T')
	})

	it('supports the maximum of 100 decimal places', () => {
		expect(formatNumber(1, 100)).toBe(`1.${'0'.repeat(100)}`)
	})

	it('throws a RangeError for out-of-range decimal counts', () => {
		expect(() => formatNumber(5, -1)).toThrow(RangeError)
		expect(() => formatNumber(5, 101)).toThrow(RangeError)
	})
})

describe('formatCurrency', () => {
	it('formats USD with a symbol, grouping, and two decimals', () => {
		expect(formatCurrency(1234.56)).toBe('$1,234.56')
	})

	it('defaults to USD when no currency is supplied', () => {
		expect(formatCurrency(1)).toBe(formatCurrency(1, 'USD'))
		expect(formatCurrency(1)).toBe('$1.00')
	})

	it('pads to two decimals', () => {
		expect(formatCurrency(5)).toBe('$5.00')
		expect(formatCurrency(5.1)).toBe('$5.10')
	})

	it('formats zero', () => {
		expect(formatCurrency(0)).toBe('$0.00')
	})

	it('puts the minus sign before the currency symbol for negatives', () => {
		expect(formatCurrency(-1234.5)).toBe('-$1,234.50')
		expect(formatCurrency(-0.5)).toBe('-$0.50')
	})

	it('keeps a negative sign on values that round to zero', () => {
		expect(formatCurrency(-0)).toBe('-$0.00')
		expect(formatCurrency(-0.004)).toBe('-$0.00')
	})

	it('rounds to two decimal places', () => {
		expect(formatCurrency(1234.564)).toBe('$1,234.56')
		expect(formatCurrency(1234.567)).toBe('$1,234.57')
		expect(formatCurrency(0.005)).toBe('$0.01')
		expect(formatCurrency(0.004)).toBe('$0.00')
	})

	it('rounds decimal halves up, unlike Number.prototype.toFixed', () => {
		// 2.675 and 1.015 are both stored just below the half, so toFixed(2) renders
		// them as '2.67' / '1.01'. Intl rounds the shortest decimal representation
		// with halfExpand, so formatCurrency goes up where formatPercent would not.
		expect(formatCurrency(2.675)).toBe('$2.68')
		expect(formatCurrency(1.015)).toBe('$1.02')
	})

	it('carries rounding into the next grouping', () => {
		expect(formatCurrency(999.995)).toBe('$1,000.00')
	})

	it('groups very large values in thousands', () => {
		expect(formatCurrency(1_234_567_890_123.45)).toBe('$1,234,567,890,123.45')
		expect(formatCurrency(1e15)).toBe('$1,000,000,000,000,000.00')
	})

	it('uses the symbol of a non-USD currency', () => {
		expect(formatCurrency(1234.5, 'EUR')).toBe('€1,234.50')
		expect(formatCurrency(1234.5, 'GBP')).toBe('£1,234.50')
	})

	it('honours currencies with zero decimal digits', () => {
		expect(formatCurrency(1234.5, 'JPY')).toBe('¥1,235')
		expect(formatCurrency(1234.5, 'KRW')).toBe('₩1,235')
	})

	it('accepts lowercase currency codes', () => {
		expect(formatCurrency(1, 'usd')).toBe('$1.00')
	})

	it('prefixes unknown three-letter codes with a non-breaking space', () => {
		expect(formatCurrency(1234.5, 'XYZ')).toBe('XYZ\u00a01,234.50')
	})

	it('throws a RangeError for a malformed currency code', () => {
		expect(() => formatCurrency(1, 'US')).toThrow(RangeError)
		expect(() => formatCurrency(1, 'US')).toThrow(/Invalid currency code/)
		expect(() => formatCurrency(1, '')).toThrow(RangeError)
	})

	it('renders non-finite amounts without throwing', () => {
		expect(formatCurrency(Number.NaN)).toBe('$NaN')
		expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('$∞')
		expect(formatCurrency(Number.NEGATIVE_INFINITY)).toBe('-$∞')
	})
})

describe('formatPercent', () => {
	it('prefixes positive values with a plus sign', () => {
		expect(formatPercent(3.14)).toBe('+3.14%')
		expect(formatPercent(0.5)).toBe('+0.50%')
	})

	it('keeps the minus sign for negative values without adding a plus', () => {
		expect(formatPercent(-2.5)).toBe('-2.50%')
		expect(formatPercent(-0.5)).toBe('-0.50%')
	})

	it('treats exactly zero as positive', () => {
		expect(formatPercent(0)).toBe('+0.00%')
	})

	it('treats negative zero as positive', () => {
		expect(formatPercent(-0)).toBe('+0.00%')
	})

	it('renders a negative value that rounds to zero as -0.00%', () => {
		expect(formatPercent(-0.004)).toBe('-0.00%')
	})

	it('renders a positive value that rounds to zero as +0.00%', () => {
		expect(formatPercent(0.004)).toBe('+0.00%')
	})

	it('always shows exactly two decimal places', () => {
		expect(formatPercent(1)).toBe('+1.00%')
		expect(formatPercent(1.5)).toBe('+1.50%')
		expect(formatPercent(1.234)).toBe('+1.23%')
		expect(formatPercent(1.235)).toBe('+1.24%')
	})

	it('rounds toward the nearest representable double at the halfway point', () => {
		// 1.005 is stored as 1.00499999..., so toFixed rounds it down.
		expect(formatPercent(1.005)).toBe('+1.00%')
		expect(formatPercent(-1.005)).toBe('-1.00%')
	})

	it('does not abbreviate large magnitudes', () => {
		expect(formatPercent(12345.6789)).toBe('+12345.68%')
		expect(formatPercent(-99999.996)).toBe('-100000.00%')
		expect(formatPercent(1_000_000)).toBe('+1000000.00%')
	})

	it('renders NaN without a sign prefix', () => {
		expect(formatPercent(Number.NaN)).toBe('NaN%')
	})

	it('renders infinities', () => {
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('+Infinity%')
		expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe('-Infinity%')
	})
})
