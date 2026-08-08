import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfigCache } from '../src/core/config.js'
import { secEdgar } from '../src/providers/sec-edgar.js'
import type { InsiderTransaction } from '../src/types.js'

const originalUserAgent = process.env.EDGAR_USER_AGENT

describe('SEC EDGAR insider filings', () => {
	beforeEach(() => {
		process.env.EDGAR_USER_AGENT = 'open-market-data tests@example.com'
		resetConfigCache()
	})

	afterEach(() => {
		if (originalUserAgent === undefined) {
			Reflect.deleteProperty(process.env, 'EDGAR_USER_AGENT')
		} else {
			process.env.EDGAR_USER_AGENT = originalUserAgent
		}
		resetConfigCache()
		vi.restoreAllMocks()
	})

	it('loads recent Form 4 documents from issuer submissions and normalizes transactions', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				jsonResponse({
					0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					filings: {
						recent: {
							accessionNumber: ['0001140361-26-025622'],
							filingDate: ['2026-06-17'],
							reportDate: ['2026-06-15'],
							form: ['4'],
							primaryDocument: ['xslF345X06/form4.xml'],
							primaryDocDescription: ['FORM 4'],
						},
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					`<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2026-06-15</periodOfReport>
  <rptOwnerName>Newstead Jennifer</rptOwnerName>
  <officerTitle>SVP, GC and Secretary</officerTitle>
  <nonDerivativeTransaction>
    <securityTitle><value>Common Stock</value></securityTitle>
    <transactionDate><value>2026-06-15</value></transactionDate>
    <transactionCode>F</transactionCode>
    <transactionShares><value>16238</value></transactionShares>
    <transactionPricePerShare><value>296.42</value></transactionPricePerShare>
    <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
    <sharesOwnedFollowingTransaction><value>41546</value></sharesOwnedFollowingTransaction>
  </nonDerivativeTransaction>
</ownershipDocument>`,
					{ status: 200, headers: { 'content-type': 'application/xml' } },
				),
			)

		const result = await secEdgar.execute<InsiderTransaction[]>('insiders', 'list', {
			symbol: 'AAPL',
			limit: 1,
		})

		expect(result.data).toEqual([
			expect.objectContaining({
				name: 'Newstead Jennifer',
				title: 'SVP, GC and Secretary',
				transactionDate: '2026-06-15',
				transactionType: 'F disposed',
				shares: 16238,
				pricePerShare: 296.42,
				sharesOwned: 41546,
				description: 'Common Stock',
				accessionNumber: '0001140361-26-025622',
				source: 'sec-edgar',
			}),
		])
		expect(fetchMock.mock.calls[2]?.[0]).toContain(
			'/Archives/edgar/data/320193/000114036126025622/form4.xml',
		)
	})
})

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
