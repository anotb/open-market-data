import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, readBoundedResponseText } from '../src/core/http.js'

describe('bounded provider HTTP helpers', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('adds an abort signal while preserving explicit request options', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
		await fetchWithTimeout('https://example.com/data', { headers: { Accept: 'application/json' } })
		expect(fetchMock).toHaveBeenCalledWith(
			'https://example.com/data',
			expect.objectContaining({
				headers: { Accept: 'application/json' },
				signal: expect.any(AbortSignal),
			}),
		)
	})

	it('compacts and truncates upstream response bodies', async () => {
		const body = `  provider\nerror ${'x'.repeat(300)}  `
		const result = await readBoundedResponseText(new Response(body), 100)
		expect(result).toHaveLength(100)
		expect(result).toMatch(/^provider error x+/)
		expect(result.endsWith('...')).toBe(true)
	})
})
