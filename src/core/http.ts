export const DEFAULT_HTTP_TIMEOUT_MS = 15_000
export const DEFAULT_ERROR_BODY_LIMIT = 500

export function fetchWithTimeout(
	input: string | URL | Request,
	init: RequestInit = {},
	timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
	const boundedTimeout = Math.max(1_000, Math.min(60_000, Math.trunc(timeoutMs)))
	return fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(boundedTimeout),
	})
}

export async function readBoundedResponseText(
	response: Response,
	maxLength = DEFAULT_ERROR_BODY_LIMIT,
): Promise<string> {
	const boundedLength = Math.max(80, Math.min(2_000, Math.trunc(maxLength)))
	const compact = (await response.text()).replace(/\s+/g, ' ').trim() || 'Empty upstream response'
	return compact.length <= boundedLength ? compact : `${compact.slice(0, boundedLength - 3)}...`
}
