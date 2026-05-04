/**
 * Tiny in-memory token-bucket rate limiter. Enough for `auth.login` brute-
 * force protection on a single instance. Prod with horizontal scaling will
 * swap the backing store for Redis (`INCR key EX windowSec` with the same
 * shape); the call site stays the same.
 *
 * Bucket semantics:
 *   - Each key gets a bucket that holds up to `max` tokens.
 *   - `consume(key)` removes one token; if the bucket is empty, returns
 *     false without scheduling a refill.
 *   - The bucket refills to full when `windowMs` has elapsed since the
 *     last refill timestamp. (We refill on demand inside `consume` rather
 *     than on a timer — there's no event loop overhead when nothing's
 *     hitting the endpoint.)
 *
 * The default policy (`max=5`, `windowMs=15min`) is the standard OWASP
 * recommendation for login: enough to absorb a fat-fingered user mistype
 * a couple of times, hostile to a brute-force attacker.
 */

export type Bucket = {
  tokens: number;
  lastRefill: number;
};

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Default in-process store. Tests can construct their own Map for
 * isolation by passing it via the `store` option to `consume`.
 */
const defaultStore: Map<string, Bucket> = new Map();

export type ConsumeOptions = {
  /** Max tokens in the bucket (capacity + refill amount). */
  max?: number;
  /** Refill window in ms. */
  windowMs?: number;
  /** Override the default Map (e.g. test isolation). */
  store?: Map<string, Bucket>;
  /** Time source override for testing. */
  now?: () => number;
};

/**
 * Try to consume one token from `key`'s bucket. Returns true when allowed,
 * false when rate-limited.
 */
export function consume(key: string, opts: ConsumeOptions = {}): boolean {
  const max = opts.max ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const store = opts.store ?? defaultStore;
  const now = opts.now ? opts.now() : Date.now();

  let bucket = store.get(key);
  if (!bucket) {
    bucket = { tokens: max, lastRefill: now };
    store.set(key, bucket);
  } else if (now - bucket.lastRefill >= windowMs) {
    bucket.tokens = max;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

/** Drop a key from the store. Test/ops helper. */
export function reset(key: string, opts: { store?: Map<string, Bucket> } = {}): void {
  const store = opts.store ?? defaultStore;
  store.delete(key);
}

/** Wipe the default store. Test helper. */
export function resetAll(): void {
  defaultStore.clear();
}

/**
 * Best-effort IP extraction from a Next.js Request. Honours the
 * `x-forwarded-for` chain (left-most is the original client) and falls
 * back to a fixed key so a misconfigured proxy can't dodge the limiter.
 */
export function ipKey(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
