import { afterEach, describe, expect, it, vi } from 'vitest'
import { worldBank } from '../src/providers/world-bank.js'
import type { MacroSeries } from '../src/types.js'

describe('World Bank provider resilience', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('avoids the unreliable upstream date query and filters a bounded window locally', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				jsonResponse([
					{ page: 1, pages: 1, per_page: 250, total: 4 },
					[entry('2023', 3), entry('2022', 2), entry('2021', 1), entry('2020', 0)],
				]),
			)

		const result = await worldBank.execute<MacroSeries>('macro', 'get', {
			seriesId: 'NY.GDP.MKTP.CD',
			country: 'US',
			start: '2020-01-01',
			end: '2022-12-31',
		})

		const requested = new URL(String(fetchMock.mock.calls[0]?.[0]))
		expect(requested.searchParams.has('date')).toBe(false)
		expect(requested.searchParams.get('mrv')).toBe('250')
		expect(result.data.data.map((point) => point.date)).toEqual(['2020', '2021', '2022'])
	})

	it('turns a World Bank message envelope into an actionable provider error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse([
				{
					message: [
						{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
					],
				},
			]),
		)

		await expect(
			worldBank.execute<MacroSeries>('macro', 'get', {
				seriesId: 'OMD.DOES.NOT.EXIST',
				country: 'US',
			}),
		).rejects.toThrow(/Invalid value.*not valid/i)
	})
})

function entry(date: string, value: number): Record<string, unknown> {
	return {
		indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP' },
		country: { id: 'US', value: 'United States' },
		countryiso3code: 'USA',
		date,
		value,
		unit: '',
		decimal: 0,
	}
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
