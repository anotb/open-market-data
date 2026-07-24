import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RateLimitConfig } from '../../src/providers/types.js'
import { freshImport } from '../helpers/modules.js'

/**
 * src/core/rate-limiter.ts holds one module-scoped Map of token buckets that
 * lives for the whole process, so every test takes a fresh copy of the module
 * through freshImport(). resetBucket() alone would only clear the names a test
 * happens to remember, and `buckets` has no exported clear().
 *
 * Every exported function reads Date.now(), so the clock is pinned for the
 * whole file. Elapsed times are always exact binary fractions of the window
 * (halves, quarters, eighths) so the floating-point refill maths is
 * reproducible down to the last bit.
 */

type RateLimiterModule = typeof import('../../src/core/rate-limiter.js')

const START = Date.parse('2024-06-15T12:00:00Z')
const SECOND = 1000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Rate limits lifted from the real providers, used as realistic fixtures. */
const SEC_EDGAR: RateLimitConfig = { maxRequests: 10, windowMs: 1000 }
const YAHOO: RateLimitConfig = { maxRequests: 60, windowMs: 60_000 }
const FRED: RateLimitConfig = { maxRequests: 120, windowMs: 60_000 }
const COINGECKO: RateLimitConfig = { maxRequests: 30, windowMs: 60_000 }
const BINANCE: RateLimitConfig = { maxRequests: 1200, windowMs: 60_000 }
const ALPHA_VANTAGE: RateLimitConfig = { maxRequests: 25, windowMs: 86_400_000 }

const PROVIDER_LIMITS: [string, RateLimitConfig][] = [
	['sec-edgar', SEC_EDGAR],
	['yahoo-finance', YAHOO],
	['fred', FRED],
	['coingecko', COINGECKO],
	['binance', BINANCE],
	['alpha-vantage', ALPHA_VANTAGE],
]

let rl: RateLimiterModule

beforeEach(async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date(START))
	rl = await freshImport<RateLimiterModule>('../../src/core/rate-limiter.js')
})

afterEach(() => {
	vi.useRealTimers()
})

/** Consumes tokens until the bucket refuses, returning how many were granted. */
function drain(source: string, config: RateLimitConfig): number {
	let granted = 0
	// Time is frozen under fake timers so this always terminates; the cap only
	// stops a regression that hands out tokens forever from hanging the suite.
	while (granted < config.maxRequests + 10 && rl.consumeToken(source, config)) granted++
	return granted
}

describe('fresh buckets', () => {
	it.each(PROVIDER_LIMITS)('starts the %s bucket full', (source, config) => {
		expect(rl.getRemaining(source, config)).toBe(config.maxRequests)
	})

	it.each(PROVIDER_LIMITS)('admits the first request for %s', (source, config) => {
		expect(rl.canRequest(source, config)).toBe(true)
	})

	it('creates the bucket on the first canRequest without spending a token', () => {
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('creates the bucket on the first consumeToken and spends exactly one token', () => {
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(true)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(9)
	})

	it('creates the bucket on the first getRemaining without spending a token', () => {
		expect(rl.getRemaining('fred', FRED)).toBe(120)

		expect(drain('fred', FRED)).toBe(120)
	})

	it('starts a single-token bucket with exactly one request available', () => {
		const single: RateLimitConfig = { maxRequests: 1, windowMs: 60_000 }

		expect(rl.getRemaining('single', single)).toBe(1)
		expect(rl.canRequest('single', single)).toBe(true)
		expect(rl.consumeToken('single', single)).toBe(true)
		expect(rl.consumeToken('single', single)).toBe(false)
		expect(rl.getRemaining('single', single)).toBe(0)
	})
})

describe('consumeToken', () => {
	it('decrements the remaining count by one per successful call', () => {
		for (let spent = 1; spent <= 10; spent++) {
			expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(true)
			expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10 - spent)
		}
	})

	it('grants exactly maxRequests tokens before refusing', () => {
		expect(drain('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it.each(PROVIDER_LIMITS)('grants exactly the %s allowance in one window', (source, config) => {
		expect(drain(source, config)).toBe(config.maxRequests)
	})

	it('reports the bucket as exhausted once every token is spent', () => {
		drain('sec-edgar', SEC_EDGAR)

		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)
	})

	it('keeps refusing while the bucket stays empty', () => {
		drain('sec-edgar', SEC_EDGAR)

		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(false)
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(false)
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it('does not push the balance below zero when refusing', () => {
		drain('sec-edgar', SEC_EDGAR)
		for (let i = 0; i < 25; i++) rl.consumeToken('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(SECOND)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('refills on its own before deciding, without help from canRequest', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(500)

		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(true)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(4)
	})
})

describe('canRequest', () => {
	it('never spends a token however often it is asked', () => {
		for (let i = 0; i < 50; i++) expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(drain('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('flips to false on the exact call that empties the bucket', () => {
		for (let i = 0; i < 9; i++) rl.consumeToken('sec-edgar', SEC_EDGAR)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)

		rl.consumeToken('sec-edgar', SEC_EDGAR)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it('refills on its own before answering, without help from getRemaining', () => {
		drain('sec-edgar', SEC_EDGAR)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)

		vi.advanceTimersByTime(500)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)
	})
})

describe('getRemaining', () => {
	it('never spends a token however often it is asked', () => {
		for (let i = 0; i < 50; i++) expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(60)

		expect(drain('yahoo-finance', YAHOO)).toBe(60)
	})

	it('refills on its own, so a drained bucket reports the accrued tokens', () => {
		drain('yahoo-finance', YAHOO)
		vi.advanceTimersByTime(30_000)

		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(30)
	})

	it('floors a fractional balance towards zero', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(125)

		// 125ms of a 1000ms / 10-token window accrues exactly 1.25 tokens.
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(1)
	})

	it('reports zero while the accrued balance is still under one token', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(99)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it('keeps the floored-off fraction instead of discarding it', () => {
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(125)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(1)
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(true)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)

		// The leftover 0.25 plus 3.75 more tokens must land on a clean 4.
		vi.advanceTimersByTime(375)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(4)
	})
})

describe('proportional refill', () => {
	const FRACTIONS: [number, number][] = [
		[0, 0],
		[125, 1],
		[250, 2],
		[500, 5],
		[750, 7],
		[875, 8],
		[999, 9],
		[1000, 10],
	]

	it.each(FRACTIONS)('restores %d ms worth of a drained window as %d tokens', (elapsed, tokens) => {
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(elapsed)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(tokens)
	})

	it('accrues the same total whether it is read in steps or in one go', () => {
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(250)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(2)
		vi.advanceTimersByTime(250)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(5)
		vi.advanceTimersByTime(250)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(7)
		vi.advanceTimersByTime(250)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('tops a partly spent bucket back up rather than starting from zero', () => {
		for (let i = 0; i < 30; i++) rl.consumeToken('yahoo-finance', YAHOO)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(30)

		vi.advanceTimersByTime(15_000)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(45)
	})

	it('refills a one-millisecond window completely in a single millisecond', () => {
		const burst: RateLimitConfig = { maxRequests: 5, windowMs: 1 }
		expect(drain('burst', burst)).toBe(5)

		vi.advanceTimersByTime(1)
		expect(rl.getRemaining('burst', burst)).toBe(5)
	})

	it('refills nothing for a sub-token slice of a one-second window', () => {
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(1)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)

		vi.advanceTimersByTime(99)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(1)
	})

	it('refills a day-long window in quarter-day steps', () => {
		expect(drain('alpha-vantage', ALPHA_VANTAGE)).toBe(25)

		vi.advanceTimersByTime(6 * HOUR)
		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(6)
		vi.advanceTimersByTime(6 * HOUR)
		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(12)
		vi.advanceTimersByTime(6 * HOUR)
		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(18)
		vi.advanceTimersByTime(6 * HOUR)
		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(25)
	})

	it('gives back nothing useful after a minute of a day-long window', () => {
		drain('alpha-vantage', ALPHA_VANTAGE)

		vi.advanceTimersByTime(60_000)
		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(0)
		expect(rl.canRequest('alpha-vantage', ALPHA_VANTAGE)).toBe(false)
	})

	it('scales the refill with maxRequests for an identical window', () => {
		drain('coingecko', COINGECKO)
		drain('binance', BINANCE)

		vi.advanceTimersByTime(30_000)
		expect(rl.getRemaining('coingecko', COINGECKO)).toBe(15)
		expect(rl.getRemaining('binance', BINANCE)).toBe(600)
	})
})

describe('the one-token boundary', () => {
	const QUARTERS: RateLimitConfig = { maxRequests: 4, windowMs: 1000 }

	it('admits a request the instant a whole token has accrued', () => {
		drain('quarters', QUARTERS)

		vi.advanceTimersByTime(250)
		expect(rl.canRequest('quarters', QUARTERS)).toBe(true)
		expect(rl.getRemaining('quarters', QUARTERS)).toBe(1)
		expect(rl.consumeToken('quarters', QUARTERS)).toBe(true)
		expect(rl.getRemaining('quarters', QUARTERS)).toBe(0)
	})

	it('refuses one millisecond before a whole token has accrued', () => {
		drain('quarters', QUARTERS)

		vi.advanceTimersByTime(249)
		expect(rl.canRequest('quarters', QUARTERS)).toBe(false)
		expect(rl.consumeToken('quarters', QUARTERS)).toBe(false)
		expect(rl.getRemaining('quarters', QUARTERS)).toBe(0)
	})

	it('needs a full window per token for a single-token bucket', () => {
		const single: RateLimitConfig = { maxRequests: 1, windowMs: 1000 }
		expect(rl.consumeToken('single', single)).toBe(true)

		vi.advanceTimersByTime(999)
		expect(rl.canRequest('single', single)).toBe(false)

		vi.advanceTimersByTime(1)
		expect(rl.canRequest('single', single)).toBe(true)
		expect(rl.consumeToken('single', single)).toBe(true)
		expect(rl.consumeToken('single', single)).toBe(false)
	})
})

describe('clamping at maxRequests', () => {
	it('never banks more than the allowance no matter how long it idles', () => {
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(60)

		vi.advanceTimersByTime(100 * 60_000)

		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(60)
		expect(drain('yahoo-finance', YAHOO)).toBe(60)
	})

	it('discards the surplus accrued while the bucket sat full', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(100 * SECOND)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(drain('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it('tops a partly spent bucket up to the cap and no further', () => {
		for (let i = 0; i < 3; i++) rl.consumeToken('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(10 * SECOND)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('clamps after an enormous idle gap on a short window', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(30 * DAY)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('clamps a day-long window that idled for a year', () => {
		drain('alpha-vantage', ALPHA_VANTAGE)
		vi.advanceTimersByTime(365 * DAY)

		expect(rl.getRemaining('alpha-vantage', ALPHA_VANTAGE)).toBe(25)
		expect(drain('alpha-vantage', ALPHA_VANTAGE)).toBe(25)
	})
})

describe('bucket independence', () => {
	it('keeps one source untouched while another is drained', () => {
		drain('sec-edgar', SEC_EDGAR)

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(60)
		expect(rl.canRequest('yahoo-finance', YAHOO)).toBe(true)
	})

	it('gives two sources separate buckets even when they share a config object', () => {
		expect(drain('coingecko', COINGECKO)).toBe(30)

		expect(rl.getRemaining('coingecko', COINGECKO)).toBe(0)
		expect(drain('worldbank', COINGECKO)).toBe(30)
	})

	it('refills every bucket on its own clock', () => {
		drain('sec-edgar', SEC_EDGAR)
		drain('yahoo-finance', YAHOO)

		vi.advanceTimersByTime(500)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(5)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(0)

		vi.advanceTimersByTime(29_500)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(30)
	})

	it('treats source names as case-sensitive', () => {
		drain('sec-edgar', SEC_EDGAR)

		expect(rl.getRemaining('SEC-EDGAR', SEC_EDGAR)).toBe(10)
	})

	it('treats a trailing space as a different source', () => {
		drain('fred', FRED)

		expect(rl.getRemaining('fred ', FRED)).toBe(120)
	})

	it('accepts the empty string as a source name', () => {
		expect(rl.getRemaining('', SEC_EDGAR)).toBe(10)
		expect(drain('', SEC_EDGAR)).toBe(10)

		expect(rl.canRequest('', SEC_EDGAR)).toBe(false)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)
	})

	it('isolates every registered provider from the others', () => {
		for (const [source, config] of PROVIDER_LIMITS) drain(source, config)
		for (const [source, config] of PROVIDER_LIMITS) {
			expect(rl.getRemaining(source, config)).toBe(0)
		}

		expect(rl.getRemaining('late-arrival', SEC_EDGAR)).toBe(10)
	})
})

describe('resetBucket', () => {
	it('restores a drained bucket to full without waiting for a refill', () => {
		drain('sec-edgar', SEC_EDGAR)

		rl.resetBucket('sec-edgar')

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(drain('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('clears only the named bucket', () => {
		drain('sec-edgar', SEC_EDGAR)
		drain('yahoo-finance', YAHOO)

		rl.resetBucket('sec-edgar')

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(0)
	})

	it('drops the partial balance rather than carrying it over', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(125)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(1)

		rl.resetBucket('sec-edgar')

		expect(drain('sec-edgar', SEC_EDGAR)).toBe(10)
	})

	it('restarts the refill clock from the moment the bucket is re-created', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.advanceTimersByTime(500)

		rl.resetBucket('sec-edgar')
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(250)
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(2)
	})

	it('is a no-op for a source that was never seen', () => {
		expect(() => rl.resetBucket('never-used')).not.toThrow()

		expect(rl.getRemaining('never-used', SEC_EDGAR)).toBe(10)
	})

	it('is idempotent', () => {
		drain('fred', FRED)
		rl.resetBucket('fred')
		rl.resetBucket('fred')

		expect(rl.getRemaining('fred', FRED)).toBe(120)
	})

	it('lets a brand-new config take effect for the recreated bucket', () => {
		drain('sec-edgar', SEC_EDGAR)

		rl.resetBucket('sec-edgar')
		const relaxed: RateLimitConfig = { maxRequests: 3, windowMs: 1000 }

		expect(rl.getRemaining('sec-edgar', relaxed)).toBe(3)
		expect(drain('sec-edgar', relaxed)).toBe(3)
	})
})

describe('config capture', () => {
	// NOTE: suspected bug (src/core/rate-limiter.ts:11-18) — getBucket() only
	// reads `config` when it creates the bucket, so every later call silently
	// ignores the config it was handed. A provider that changes its limits at
	// runtime (or two callers passing different limits for one source name)
	// keeps whichever config happened to arrive first, for the process lifetime.
	it('ignores a larger maxRequests supplied after the bucket exists', () => {
		const tight: RateLimitConfig = { maxRequests: 2, windowMs: 60_000 }
		const generous: RateLimitConfig = { maxRequests: 500, windowMs: 60_000 }

		expect(drain('finnhub', tight)).toBe(2)

		expect(rl.getRemaining('finnhub', generous)).toBe(0)
		expect(rl.canRequest('finnhub', generous)).toBe(false)
	})

	it('still clamps to the original maxRequests after a full window', () => {
		const tight: RateLimitConfig = { maxRequests: 2, windowMs: 60_000 }
		const generous: RateLimitConfig = { maxRequests: 500, windowMs: 60_000 }
		drain('finnhub', tight)

		vi.advanceTimersByTime(60_000)

		expect(rl.getRemaining('finnhub', generous)).toBe(2)
		expect(drain('finnhub', generous)).toBe(2)
	})

	it('ignores a different windowMs supplied after the bucket exists', () => {
		const slow: RateLimitConfig = { maxRequests: 10, windowMs: 100_000 }
		drain('sec-edgar', SEC_EDGAR)

		vi.advanceTimersByTime(500)

		// The original 1000ms window is still in force: 5 tokens, not 0.05.
		expect(rl.getRemaining('sec-edgar', slow)).toBe(5)
	})

	it('takes the config from whichever call created the bucket first', () => {
		const generous: RateLimitConfig = { maxRequests: 500, windowMs: 60_000 }
		const tight: RateLimitConfig = { maxRequests: 2, windowMs: 60_000 }

		expect(rl.canRequest('finnhub', generous)).toBe(true)

		expect(rl.getRemaining('finnhub', tight)).toBe(500)
	})

	it('does not require the same config object on later calls', () => {
		const first: RateLimitConfig = { maxRequests: 10, windowMs: 1000 }
		const equivalent: RateLimitConfig = { maxRequests: 10, windowMs: 1000 }

		expect(drain('sec-edgar', first)).toBe(10)

		vi.advanceTimersByTime(500)
		expect(rl.getRemaining('sec-edgar', equivalent)).toBe(5)
	})

	it('follows later mutations of the captured config object', () => {
		// NOTE: suspected bug (src/core/rate-limiter.ts:14) — the bucket stores the
		// caller's config by reference rather than copying it, so mutating the
		// object a provider exported rewrites a live bucket's limits.
		const mutable: RateLimitConfig = { maxRequests: 5, windowMs: 1000 }
		expect(drain('mutable', mutable)).toBe(5)

		mutable.maxRequests = 50
		vi.advanceTimersByTime(1000)

		expect(rl.getRemaining('mutable', mutable)).toBe(50)
	})
})

describe('a frozen clock', () => {
	it('changes nothing across repeated reads at the same instant', () => {
		for (let i = 0; i < 5; i++) rl.consumeToken('yahoo-finance', YAHOO)

		for (let i = 0; i < 20; i++) {
			expect(rl.canRequest('yahoo-finance', YAHOO)).toBe(true)
			expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(55)
		}
	})

	it('grants a whole allowance in a single instant, then nothing more', () => {
		expect(drain('coingecko', COINGECKO)).toBe(30)

		expect(rl.canRequest('coingecko', COINGECKO)).toBe(false)
		expect(rl.getRemaining('coingecko', COINGECKO)).toBe(0)
	})

	it('does not leak tokens between an interleaved check and spend', () => {
		for (let i = 0; i < 10; i++) {
			expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(true)
			expect(rl.consumeToken('sec-edgar', SEC_EDGAR)).toBe(true)
		}

		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)
	})
})

describe('a clock that moves backwards', () => {
	// NOTE: suspected bug (src/core/rate-limiter.ts:20-26) — refill() never
	// guards against a negative `elapsed`, so an NTP correction (or any backwards
	// system-clock step) debits tokens instead of adding them. getRemaining can
	// then return a negative number, and the caller has to wait out the deficit
	// on top of the real window before requests are allowed again.
	it('debits a full bucket when the system clock steps back', () => {
		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(60)

		vi.setSystemTime(new Date(START - 30_000))

		expect(rl.getRemaining('yahoo-finance', YAHOO)).toBe(30)
	})

	it('drives a drained bucket to a negative balance', () => {
		drain('sec-edgar', SEC_EDGAR)

		vi.setSystemTime(new Date(START - SECOND))

		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(-10)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)
	})

	it('makes the caller pay the deficit back before requests resume', () => {
		drain('sec-edgar', SEC_EDGAR)
		vi.setSystemTime(new Date(START - SECOND))
		rl.getRemaining('sec-edgar', SEC_EDGAR)

		vi.setSystemTime(new Date(START))
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(0)
		expect(rl.canRequest('sec-edgar', SEC_EDGAR)).toBe(false)

		vi.setSystemTime(new Date(START + SECOND))
		expect(rl.getRemaining('sec-edgar', SEC_EDGAR)).toBe(10)
	})
})

describe('degenerate configs', () => {
	it('never admits a request for a zero-request allowance', () => {
		const none: RateLimitConfig = { maxRequests: 0, windowMs: 60_000 }

		expect(rl.getRemaining('none', none)).toBe(0)
		expect(rl.canRequest('none', none)).toBe(false)
		expect(rl.consumeToken('none', none)).toBe(false)

		vi.advanceTimersByTime(10 * 60_000)
		expect(rl.canRequest('none', none)).toBe(false)
		expect(rl.getRemaining('none', none)).toBe(0)
	})

	it('poisons the balance of a bucket whose window is zero milliseconds', () => {
		// NOTE: suspected bug (src/core/rate-limiter.ts:23) — a zero windowMs makes
		// `elapsed / windowMs` NaN (0/0) or Infinity, and `Math.min(max, NaN)` is
		// NaN, so the balance is NaN from the very first call onwards.
		const instant: RateLimitConfig = { maxRequests: 5, windowMs: 0 }

		expect(rl.getRemaining('instant', instant)).toBeNaN()
		expect(rl.canRequest('instant', instant)).toBe(false)

		vi.advanceTimersByTime(60_000)
		expect(rl.getRemaining('instant', instant)).toBeNaN()
		expect(rl.canRequest('instant', instant)).toBe(false)
	})

	it('hands out unlimited tokens once the balance is NaN', () => {
		// NOTE: suspected bug (src/core/rate-limiter.ts:37) — the guard is
		// `tokens < 1`, which is false for NaN, so consumeToken keeps returning
		// true forever while canRequest says false. Every provider gates on
		// consumeToken, so a zero windowMs silently disables rate limiting.
		const instant: RateLimitConfig = { maxRequests: 5, windowMs: 0 }

		for (let i = 0; i < 100; i++) {
			expect(rl.consumeToken('instant', instant)).toBe(true)
		}
		expect(rl.canRequest('instant', instant)).toBe(false)
	})

	it('drains a bucket whose window is negative', () => {
		// NOTE: suspected bug (src/core/rate-limiter.ts:23) — a negative windowMs
		// inverts the refill, so time passing removes tokens.
		const inverted: RateLimitConfig = { maxRequests: 10, windowMs: -1000 }
		expect(rl.getRemaining('inverted', inverted)).toBe(10)

		vi.advanceTimersByTime(500)

		expect(rl.getRemaining('inverted', inverted)).toBe(5)
		vi.advanceTimersByTime(500)
		expect(rl.canRequest('inverted', inverted)).toBe(false)
	})

	it('handles a fractional allowance by flooring what it reports', () => {
		const fractional: RateLimitConfig = { maxRequests: 2.5, windowMs: 1000 }

		expect(rl.getRemaining('fractional', fractional)).toBe(2)
		expect(drain('fractional', fractional)).toBe(2)
		expect(rl.getRemaining('fractional', fractional)).toBe(0)

		vi.advanceTimersByTime(1000)
		expect(rl.getRemaining('fractional', fractional)).toBe(2)
	})
})
