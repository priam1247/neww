import { NextRequest } from 'next/server';

interface RateBucket {
  timestamps: number[];
}

declare global {
  // eslint-disable-next-line no-var
  var __zafarRateLimitBuckets: Map<string, RateBucket> | undefined;
}

const MAX_BUCKETS = 4096;

function getBuckets(): Map<string, RateBucket> {
  if (!globalThis.__zafarRateLimitBuckets) {
    globalThis.__zafarRateLimitBuckets = new Map();
  }
  return globalThis.__zafarRateLimitBuckets;
}

export function getClientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;

  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return '127.0.0.1';
}

function pruneWindow(key: string, windowMs: number, now = Date.now()): number[] {
  const buckets = getBuckets();
  const existing = buckets.get(key);
  if (!existing) return [];
  const cutoff = now - windowMs;
  const fresh = existing.timestamps.filter((ts) => ts > cutoff);
  if (fresh.length === 0) {
    buckets.delete(key);
  } else {
    existing.timestamps = fresh;
  }
  return fresh;
}

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
  const now = Date.now();
  const timestamps = pruneWindow(key, windowMs, now);
  if (timestamps.length >= maxAttempts) {
    const oldest = timestamps[0] || now;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, maxAttempts - timestamps.length),
  };
}

export function recordRateLimitHit(key: string, windowMs: number): void {
  const now = Date.now();
  const buckets = getBuckets();
  const timestamps = pruneWindow(key, windowMs, now);

  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }

  timestamps.push(now);
  buckets.set(key, { timestamps });
}

export function clearRateLimit(key: string): void {
  getBuckets().delete(key);
}
