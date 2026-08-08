export function boundedInteger(
	value: string,
	label: string,
	minimum: number,
	maximum: number,
): number {
	const trimmed = value.trim()
	if (!/^-?\d+$/.test(trimmed)) {
		throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
	}
	const parsed = Number(trimmed)
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
	}
	return parsed
}

export function choice<T extends string>(value: string, label: string, choices: readonly T[]): T {
	if (!choices.includes(value as T)) {
		throw new Error(`${label} must be one of: ${choices.join(', ')}`)
	}
	return value as T
}

export function boundedText(value: string, label: string, maximumLength: number): string {
	const trimmed = value.trim()
	if (!trimmed || trimmed.length > maximumLength) {
		throw new Error(`${label} must contain 1 to ${maximumLength} characters`)
	}
	return trimmed
}

export function symbol(value: string): string {
	const normalized = boundedText(value, 'symbol', 32).toUpperCase()
	if (/\s/.test(normalized)) throw new Error('symbol must not contain whitespace')
	return normalized
}

export function isoDate(value: string, label: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) throw new Error(`${label} must be a valid date in YYYY-MM-DD format`)
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const date = new Date(Date.UTC(year, month - 1, day))
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		throw new Error(`${label} must be a valid date in YYYY-MM-DD format`)
	}
	return value
}

export function countryCode(value: string): string {
	const normalized = value.trim().toUpperCase()
	if (!/^[A-Z]{2,3}$/.test(normalized)) {
		throw new Error('--country must be an ISO alpha-2 or alpha-3 country code')
	}
	return normalized
}
