import type { RateLimitConfig } from '../providers/types.js'

interface Bucket {
	tokens: number
	lastRefill: number
	config: RateLimitConfig
}

const buckets = new Map<string, Bucket>()

function getBucket(source: string, config: RateLimitConfig): Bucket {
	let bucket = buckets.get(source)
	if (!bucket) {
		bucket = { tokens: config.maxRequests, lastRefill: Date.now(), config }
		buckets.set(source, bucket)
	}
	return bucket
}

function refill(bucket: Bucket): void {
	const now = Date.now()
	const elapsed = now - bucket.lastRefill
	const refillAmount = (elapsed / bucket.config.windowMs) * bucket.config.maxRequests
	bucket.tokens = Math.min(bucket.config.maxRequests, bucket.tokens + refillAmount)
	bucket.lastRefill = now
}

export function canRequest(source: string, config: RateLimitConfig): boolean {
	const bucket = getBucket(source, config)
	refill(bucket)
	return bucket.tokens >= 1
}

export function consumeToken(source: string, config: RateLimitConfig): boolean {
	const bucket = getBucket(source, config)
	refill(bucket)
	if (bucket.tokens < 1) return false
	bucket.tokens -= 1
	return true
}

export function getRemaining(source: string, config: RateLimitConfig): number {
	const bucket = getBucket(source, config)
	refill(bucket)
	return Math.floor(bucket.tokens)
}

export function resetBucket(source: string): void {
	buckets.delete(source)
}
