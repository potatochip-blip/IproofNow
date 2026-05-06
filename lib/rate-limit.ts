/**
 * Tiny in-memory token-bucket rate limiter. Enough for `auth.login` brute-
 * force protection on a single instance. Prod with horizontal scaling will
 * swap the backing store for Redis (`INCR key EX windowSec` with the same
 * shape).
 *
 * Phase 6 — the bucket is now behind a small `RateLimiter` interface so
 * the Redis swap is a new module (`lib/rate-limit-redis.ts`) implementing
 * the same shape, not a call-site rewrite. The function exports
 * (`consume`/`reset`/`resetAll`) remain — they're thin wrappers around a
 * module-level default `MemoryRateLimiter` instance, kept for the call
 * sites and tests written before the interface existed.
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
 * Minimal interface every limiter backend implements. Sync return is fine
 * for the in-memory impl; the Redis swap will return Promise<boolean> and
 * call sites that await the function will keep working either way.
 */
export interface RateLimiter {
  consume(key: string): boolean | Promise<boolean>;
  reset(key: string): void | Promise<void>;
}

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
 * In-process token-bucket limiter. Implements `RateLimiter` and is the
 * default backend wired into the function exports below.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly store: Map<string, Bucket>;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: { max?: number; windowMs?: number; store?: Map<string, Bucket>; now?: () => number } = {}) {
    this.store = opts.store ?? new Map();
    this.max = opts.max ?? DEFAULT_MAX;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.now ?? Date.now;
  }

  consume(key: string): boolean {
    return consumeFrom(key, {
      max: this.max,
      windowMs: this.windowMs,
      store: this.store,
      now: this.clock,
    });
  }

  reset(key: string): void {
    this.store.delete(key);
  }
}

const defaultStore: Map<string, Bucket> = new Map();

/** Internal — backs both the function form and the class method. */
function consumeFrom(
  key: string,
  cfg: { max: number; windowMs: number; store: Map<string, Bucket>; now: () => number }
): boolean {
  const now = cfg.now();
  let bucket = cfg.store.get(key);
  if (!bucket) {
    bucket = { tokens: cfg.max, lastRefill: now };
    cfg.store.set(key, bucket);
  } else if (now - bucket.lastRefill >= cfg.windowMs) {
    bucket.tokens = cfg.max;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Try to consume one token from `key`'s bucket. Returns true when allowed,
 * false when rate-limited. Backed by the default in-process store unless
 * `opts.store` overrides it (used by tests).
 */
export function consume(key: string, opts: ConsumeOptions = {}): boolean {
  return consumeFrom(key, {
    max: opts.max ?? DEFAULT_MAX,
    windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
    store: opts.store ?? defaultStore,
    now: opts.now ?? Date.now,
  });
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
 * Module-level singleton wrapping the default store. Call sites that want
 * the interface form (so a future Redis backend swap is invisible) can do
 * `getRateLimiter().consume(key)`. The login route still uses the function
 * form — both go through the same `defaultStore`.
 */
let singleton: RateLimiter | null = null;
export function getRateLimiter(): RateLimiter {
  // TODO(scaling): when horizontal scaling lands, swap this for the Redis
  // implementation (lib/rate-limit-redis.ts). Selection can key off
  // process.env.RATE_LIMITER='redis' so dev stays in-memory.
  if (!singleton) {
    singleton = new MemoryRateLimiter({ store: defaultStore });
  }
  return singleton;
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
