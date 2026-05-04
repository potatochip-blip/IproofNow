import { describe, expect, it } from 'vitest';
import { consume, ipKey } from '@/lib/rate-limit';

describe('lib/rate-limit', () => {
  it('allows up to max attempts then rejects', () => {
    const store = new Map();
    const opts = { max: 3, windowMs: 60_000, store };

    expect(consume('a', opts)).toBe(true);
    expect(consume('a', opts)).toBe(true);
    expect(consume('a', opts)).toBe(true);
    expect(consume('a', opts)).toBe(false);
    expect(consume('a', opts)).toBe(false);
  });

  it('refills after the window elapses', () => {
    const store = new Map();
    let now = 1_000_000;
    const opts = { max: 2, windowMs: 1000, store, now: () => now };

    expect(consume('k', opts)).toBe(true);
    expect(consume('k', opts)).toBe(true);
    expect(consume('k', opts)).toBe(false);

    // Advance past the window.
    now += 1500;
    expect(consume('k', opts)).toBe(true);
    expect(consume('k', opts)).toBe(true);
    expect(consume('k', opts)).toBe(false);
  });

  it('isolates buckets per key', () => {
    const store = new Map();
    const opts = { max: 1, windowMs: 60_000, store };

    expect(consume('one', opts)).toBe(true);
    expect(consume('one', opts)).toBe(false);
    expect(consume('two', opts)).toBe(true);
    expect(consume('two', opts)).toBe(false);
  });

  it('ipKey() honours x-forwarded-for left-most then x-real-ip then unknown', () => {
    const xff = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    expect(ipKey(xff)).toBe('203.0.113.5');

    const real = new Request('http://localhost', {
      headers: { 'x-real-ip': '198.51.100.7' },
    });
    expect(ipKey(real)).toBe('198.51.100.7');

    const none = new Request('http://localhost');
    expect(ipKey(none)).toBe('unknown');
  });
});
