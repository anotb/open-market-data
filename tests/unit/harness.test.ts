import { afterEach, describe, expect, it } from 'vitest'
import {
	expectNoUnmatched,
	mockFetch,
	mockFetchFailure,
	mockFetchNetworkError,
} from '../helpers/mock-fetch.js'
import { clearConfigEnv, makeTempHome } from '../helpers/modules.js'
import {
	createFailingProvider,
	createMockProvider,
	createRecordingProvider,
} from '../helpers/providers.js'

/**
 * The test harness is load-bearing for every provider suite, so it gets its own
 * tests. If these fail, treat other provider failures as suspect.
 */

describe('mockFetch', () => {
	afterEach(() => {
		// vitest.config.ts sets unstubGlobals, but be explicit here.
		mockFetch([]).restore()
	})

	it('serves JSON bodies with an application/json content type', async () => {
		const fx = mockFetch([{ match: '/quote', respond: { json: { price: 42 } } }])

		const res = await fetch('https://example.com/quote?symbol=AAPL')
		expect(res.ok).toBe(true)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		await expect(res.json()).resolves.toEqual({ price: 42 })
		expectNoUnmatched(fx)
		fx.restore()
	})

	it('throws a descriptive error when no route matches', async () => {
		const fx = mockFetch([{ match: '/quote', respond: { json: {} } }])

		await expect(fetch('https://example.com/other')).rejects.toThrow(
			/no route matched GET https:\/\/example.com\/other/,
		)
		expect(fx.unmatched).toEqual(['https://example.com/other'])
		expect(() => expectNoUnmatched(fx)).toThrow(/Unmatched fetch requests/)
		fx.restore()
	})

	it('matches by substring, regex, and predicate', async () => {
		const fx = mockFetch([
			{ match: 'substr', respond: { json: { via: 'substring' } } },
			{ match: /re[gG]ex/, respond: { json: { via: 'regex' } } },
			{ match: (url) => url.endsWith('/pred'), respond: { json: { via: 'predicate' } } },
		])

		await expect((await fetch('https://x.test/substr')).json()).resolves.toEqual({
			via: 'substring',
		})
		await expect((await fetch('https://x.test/regex')).json()).resolves.toEqual({ via: 'regex' })
		await expect((await fetch('https://x.test/pred')).json()).resolves.toEqual({
			via: 'predicate',
		})
		expect(fx.callCount()).toBe(3)
		fx.restore()
	})

	it('applies routes in order and honours the times limit', async () => {
		const fx = mockFetch([
			{ match: '/x', respond: { json: { call: 'first' } }, times: 1 },
			{ match: '/x', respond: { json: { call: 'rest' } } },
		])

		await expect((await fetch('https://x.test/x')).json()).resolves.toEqual({ call: 'first' })
		await expect((await fetch('https://x.test/x')).json()).resolves.toEqual({ call: 'rest' })
		await expect((await fetch('https://x.test/x')).json()).resolves.toEqual({ call: 'rest' })
		fx.restore()
	})

	it('passes request context to responder functions', async () => {
		const fx = mockFetch([
			{
				match: '/ctx',
				respond: (ctx) => ({
					json: {
						hit: ctx.hit,
						symbol: ctx.parsed.searchParams.get('symbol'),
						agent: ctx.headers['user-agent'],
						method: ctx.method,
					},
				}),
			},
		])

		const res = await fetch('https://x.test/ctx?symbol=MSFT', {
			method: 'POST',
			headers: { 'User-Agent': 'omd/1.0' },
		})
		await expect(res.json()).resolves.toEqual({
			hit: 1,
			symbol: 'MSFT',
			agent: 'omd/1.0',
			method: 'POST',
		})
		fx.restore()
	})

	it('records calls, headers, and query params for assertions', async () => {
		const fx = mockFetch([{ match: () => true, respond: { json: {} } }])

		await fetch('https://x.test/a?one=1&two=2', { headers: { Accept: 'application/json' } })
		await fetch('https://x.test/b')

		expect(fx.callCount()).toBe(2)
		expect(fx.callCount('/a')).toBe(1)
		expect(fx.urls('/b')).toEqual(['https://x.test/b'])
		expect(fx.query('/a')).toEqual({ one: '1', two: '2' })
		expect(fx.call('/a')?.headers.accept).toBe('application/json')
		expect(fx.query('/nothing')).toEqual({})
		fx.restore()
	})

	it('serves non-OK responses without throwing', async () => {
		const fx = mockFetchFailure(503, 'upstream exploded')

		const res = await fetch('https://x.test/anything')
		expect(res.ok).toBe(false)
		expect(res.status).toBe(503)
		await expect(res.text()).resolves.toBe('upstream exploded')
		fx.restore()
	})

	it('simulates network-level rejections', async () => {
		const fx = mockFetchNetworkError('ECONNREFUSED')
		await expect(fetch('https://x.test/anything')).rejects.toThrow('ECONNREFUSED')
		fx.restore()
	})

	it('omits the body for bodyless status codes', async () => {
		const fx = mockFetch([{ match: () => true, respond: { status: 204, json: { a: 1 } } }])
		const res = await fetch('https://x.test/no-content')
		expect(res.status).toBe(204)
		await expect(res.text()).resolves.toBe('')
		fx.restore()
	})
})

describe('module helpers', () => {
	it('points HOME at a throwaway directory and restores it', () => {
		const original = process.env.HOME
		const home = makeTempHome()

		expect(process.env.HOME).toBe(home.dir)
		expect(home.configFile).toBe(`${home.dir}/.omd/config.json`)

		home.cleanup()
		expect(process.env.HOME).toBe(original)
	})

	it('clears and restores provider key env vars', () => {
		process.env.FRED_API_KEY = 'sentinel'
		const restore = clearConfigEnv()

		expect(process.env.FRED_API_KEY).toBeUndefined()
		restore()
		expect(process.env.FRED_API_KEY).toBe('sentinel')

		delete process.env.FRED_API_KEY
	})
})

describe('provider factories', () => {
	it('builds a provider with sensible defaults', async () => {
		const provider = createMockProvider({ name: 'stub' })
		expect(provider.name).toBe('stub')
		expect(provider.requiresKey).toBe(false)
		expect(provider.isEnabled()).toBe(true)

		const result = await provider.execute('quote', 'get', {})
		expect(result).toEqual({ data: { price: 42 }, source: 'stub', cached: false })
	})

	it('lets overrides win over defaults', () => {
		const provider = createMockProvider({
			name: 'stub',
			requiresKey: true,
			capabilities: ['crypto'],
			isEnabled: () => false,
		})
		expect(provider.requiresKey).toBe(true)
		expect(provider.capabilities).toEqual(['crypto'])
		expect(provider.isEnabled()).toBe(false)
	})

	it('builds a provider that always rejects', async () => {
		const provider = createFailingProvider('broken', 'upstream 500')
		await expect(provider.execute('quote', 'get', {})).rejects.toThrow('upstream 500')
	})

	it('records every execute call', async () => {
		const { provider, calls } = createRecordingProvider('recorder', { ok: true })

		await provider.execute('quote', 'get', { symbol: 'AAPL' })
		await provider.execute('crypto', 'quote', { symbol: 'BTC' })

		expect(calls).toEqual([
			{ category: 'quote', action: 'get', args: { symbol: 'AAPL' } },
			{ category: 'crypto', action: 'quote', args: { symbol: 'BTC' } },
		])
	})
})
