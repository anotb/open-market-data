/**
 * Deterministic `fetch` mocking harness.
 *
 * Every test that exercises a provider should install a fetch mock. Any request
 * that does not match a registered route **throws** — so a test can never
 * silently fall through to the real network and become flaky.
 *
 * ```ts
 * const fx = mockFetch([
 *   { match: /\/api\/v3\/ticker\/24hr/, respond: { json: TICKER_FIXTURE } },
 * ])
 * ...
 * expect(fx.callCount()).toBe(1)
 * expect(fx.unmatched).toEqual([])
 * fx.restore()
 * ```
 */
import { vi } from 'vitest'

export interface ResponseSpec {
	status?: number
	statusText?: string
	/** Serialized with JSON.stringify and served as application/json. */
	json?: unknown
	/** Raw body. Takes precedence over `json` when both are set. */
	text?: string
	headers?: Record<string, string>
	/** Reject the fetch promise with this error instead of responding. */
	throw?: Error
}

export interface RequestContext {
	url: string
	parsed: URL
	method: string
	headers: Record<string, string>
	body?: string
	/** 1-based count of how many times this particular route has matched. */
	hit: number
}

export type Matcher = string | RegExp | ((url: string) => boolean)

export type Responder =
	| ResponseSpec
	| ((ctx: RequestContext) => ResponseSpec | Promise<ResponseSpec>)

export interface Route {
	match: Matcher
	respond: Responder
	/** Stop matching after this many hits, letting a later route take over. */
	times?: number
}

export interface RecordedCall {
	url: string
	parsed: URL
	method: string
	headers: Record<string, string>
	body?: string
}

export interface FetchMock {
	/** Every request the code under test issued, in order. */
	calls: RecordedCall[]
	/** Requests that matched no route (each also threw at the call site). */
	unmatched: string[]
	/** Total calls, or calls matching `matcher` when provided. */
	callCount(matcher?: Matcher): number
	/** All request URLs, optionally filtered. */
	urls(matcher?: Matcher): string[]
	/** First call matching `matcher` (or the first call overall). */
	call(matcher?: Matcher): RecordedCall | undefined
	/** Query params of the first matching call, as a plain object. */
	query(matcher?: Matcher): Record<string, string>
	restore(): void
}

function matches(matcher: Matcher, url: string): boolean {
	if (typeof matcher === 'string') return url.includes(matcher)
	if (matcher instanceof RegExp) return matcher.test(url)
	return matcher(url)
}

function describeMatcher(matcher: Matcher): string {
	if (typeof matcher === 'string') return `substring ${JSON.stringify(matcher)}`
	if (matcher instanceof RegExp) return `regex ${matcher}`
	return 'predicate function'
}

function normalizeHeaders(init?: RequestInit): Record<string, string> {
	const out: Record<string, string> = {}
	const raw = init?.headers
	if (!raw) return out
	if (raw instanceof Headers) {
		raw.forEach((value, key) => {
			out[key.toLowerCase()] = value
		})
		return out
	}
	if (Array.isArray(raw)) {
		for (const [key, value] of raw) out[String(key).toLowerCase()] = String(value)
		return out
	}
	for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = String(value)
	return out
}

function toResponse(spec: ResponseSpec): Response {
	const status = spec.status ?? 200
	const headers: Record<string, string> = { ...spec.headers }

	let body: string | null
	if (spec.text !== undefined) {
		body = spec.text
	} else if (spec.json !== undefined) {
		body = JSON.stringify(spec.json)
		headers['content-type'] ??= 'application/json'
	} else {
		body = null
	}

	// 204/205/304 must not carry a body per the Response spec.
	const bodyless = status === 204 || status === 205 || status === 304
	return new Response(bodyless ? null : body, {
		status,
		statusText: spec.statusText ?? '',
		headers,
	})
}

/**
 * Replaces `globalThis.fetch` for the duration of the test. Routes are tried in
 * order; the first match wins. Call `restore()` in an afterEach, or rely on
 * `unstubGlobals` in vitest.config.ts.
 */
export function mockFetch(routes: Route[]): FetchMock {
	const calls: RecordedCall[] = []
	const unmatched: string[] = []
	const hits = new Map<Route, number>()

	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		const method = (init?.method ?? 'GET').toUpperCase()
		const headers = normalizeHeaders(init)
		const body = typeof init?.body === 'string' ? init.body : undefined

		calls.push({ url, parsed: new URL(url), method, headers, body })

		for (const route of routes) {
			const used = hits.get(route) ?? 0
			if (route.times !== undefined && used >= route.times) continue
			if (!matches(route.match, url)) continue

			hits.set(route, used + 1)
			const ctx: RequestContext = {
				url,
				parsed: new URL(url),
				method,
				headers,
				body,
				hit: used + 1,
			}
			const spec = typeof route.respond === 'function' ? await route.respond(ctx) : route.respond
			if (spec.throw) throw spec.throw
			return toResponse(spec)
		}

		unmatched.push(url)
		const known = routes.map((r) => `  - ${describeMatcher(r.match)}`).join('\n')
		throw new Error(
			`mockFetch: no route matched ${method} ${url}\nRegistered routes:\n${known || '  (none)'}`,
		)
	}

	vi.stubGlobal('fetch', vi.fn(impl))

	const select = (matcher?: Matcher): RecordedCall[] =>
		matcher === undefined ? calls : calls.filter((c) => matches(matcher, c.url))

	return {
		calls,
		unmatched,
		callCount: (matcher) => select(matcher).length,
		urls: (matcher) => select(matcher).map((c) => c.url),
		call: (matcher) => select(matcher)[0],
		query(matcher) {
			const found = select(matcher)[0]
			if (!found) return {}
			return Object.fromEntries(found.parsed.searchParams.entries())
		},
		restore: () => vi.unstubAllGlobals(),
	}
}

/** Convenience: a mock where every request fails with the given status/body. */
export function mockFetchFailure(status: number, body = 'error'): FetchMock {
	return mockFetch([{ match: () => true, respond: { status, text: body } }])
}

/** Convenience: a mock where every request rejects (network-level failure). */
export function mockFetchNetworkError(message = 'network down'): FetchMock {
	return mockFetch([{ match: () => true, respond: { throw: new Error(message) } }])
}

/**
 * Asserts no request escaped to the real network. Call at the end of provider
 * tests as a belt-and-braces check.
 */
export function expectNoUnmatched(fx: FetchMock): void {
	if (fx.unmatched.length > 0) {
		throw new Error(`Unmatched fetch requests:\n${fx.unmatched.map((u) => `  ${u}`).join('\n')}`)
	}
}
