import type { DataCategory } from '../providers/types.js'

interface CacheEntry<T> {
	data: T
	expiresAt: number
}

const TTL: Record<DataCategory, number> = {
	search: 300_000, // 5 min
	quote: 30_000, // 30s
	financials: 3_600_000, // 1h
	filing: 3_600_000, // 1h
	insiders: 3_600_000, // 1h
	macro: 3_600_000, // 1h
	crypto: 15_000, // 15s
}

const MAX_ENTRIES = 500
const store = new Map<string, CacheEntry<unknown>>()

function makeKey(provider: string, category: DataCategory, args: Record<string, unknown>): string {
	const sorted = Object.keys(args)
		.sort()
		.map((k) => `${k}=${JSON.stringify(args[k])}`)
		.join('&')
	return `${provider}:${category}:${sorted}`
}

function evictIfNeeded(): void {
	if (store.size <= MAX_ENTRIES) return
	const now = Date.now()
	for (const [key, entry] of store) {
		if (entry.expiresAt <= now) store.delete(key)
	}
	if (store.size <= MAX_ENTRIES) return
	// Remove oldest entries
	const entries = [...store.entries()]
	entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt)
	const toRemove = entries.slice(0, entries.length - MAX_ENTRIES)
	for (const [key] of toRemove) store.delete(key)
}

export function get<T>(
	provider: string,
	category: DataCategory,
	args: Record<string, unknown>,
): T | undefined {
	const key = makeKey(provider, category, args)
	const entry = store.get(key)
	if (!entry) return undefined
	if (entry.expiresAt <= Date.now()) {
		store.delete(key)
		return undefined
	}
	return entry.data as T
}

export function set<T>(
	provider: string,
	category: DataCategory,
	args: Record<string, unknown>,
	data: T,
): void {
	const key = makeKey(provider, category, args)
	const ttl = TTL[category]
	store.set(key, { data, expiresAt: Date.now() + ttl })
	evictIfNeeded()
}

export function clear(): void {
	store.clear()
}

export function size(): number {
	return store.size
}
