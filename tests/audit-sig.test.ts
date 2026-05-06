import { describe, expect, it, vi } from 'vitest';
import { sign, verify, verifyAuditSignature } from '@/lib/audit-sig';

describe('lib/audit-sig — HMAC signing wrapper', () => {
  it('sign/verify roundtrip succeeds for the same input', () => {
    const sig = sign('hello-entry-hash');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verify('hello-entry-hash', sig)).toBe(true);
  });

  it('verify rejects a tampered input under the same signature', () => {
    const sig = sign('original-entry-hash');
    expect(verify('original-entry-hash', sig)).toBe(true);
    expect(verify('tampered-entry-hash', sig)).toBe(false);
  });

  it('verify rejects a malformed signature without throwing', () => {
    expect(verify('x', 'not-hex')).toBe(false);
    expect(verify('x', 'a'.repeat(63))).toBe(false); // wrong length
    expect(verify('x', 'a'.repeat(64))).toBe(false); // wrong value
  });

  it('verifyAuditSignature returns false for null signature', () => {
    expect(verifyAuditSignature({ entryHash: 'x', signature: null })).toBe(false);
  });

  it('verifyAuditSignature roundtrips with sign()', () => {
    const entryHash = 'deadbeef';
    const sig = sign(entryHash);
    expect(verifyAuditSignature({ entryHash, signature: sig })).toBe(true);
  });

  it('signs Buffer and string identically when bytes match', () => {
    const a = sign('utf8-input');
    const b = sign(Buffer.from('utf8-input', 'utf8'));
    expect(a).toBe(b);
  });

  it('module load fails fast when AUDIT_SIGNING_KEY missing outside test env', async () => {
    // Force a clean re-import of the module under test conditions that
    // simulate dev/prod (no env var, NODE_ENV != 'test').
    vi.resetModules();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKey = process.env.AUDIT_SIGNING_KEY;
    Object.assign(process.env, { NODE_ENV: 'development' });
    delete process.env.AUDIT_SIGNING_KEY;
    try {
      await expect(import('@/lib/audit-sig')).rejects.toThrow(
        /AUDIT_SIGNING_KEY/
      );
    } finally {
      Object.assign(process.env, { NODE_ENV: prevNodeEnv });
      if (prevKey !== undefined) process.env.AUDIT_SIGNING_KEY = prevKey;
      vi.resetModules();
    }
  });

  it('module load rejects malformed key (wrong length)', async () => {
    vi.resetModules();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKey = process.env.AUDIT_SIGNING_KEY;
    Object.assign(process.env, { NODE_ENV: 'development' });
    process.env.AUDIT_SIGNING_KEY = 'deadbeef'; // 8 hex chars, not 64
    try {
      await expect(import('@/lib/audit-sig')).rejects.toThrow(
        /64 hex characters/
      );
    } finally {
      Object.assign(process.env, { NODE_ENV: prevNodeEnv });
      if (prevKey !== undefined) {
        process.env.AUDIT_SIGNING_KEY = prevKey;
      } else {
        delete process.env.AUDIT_SIGNING_KEY;
      }
      vi.resetModules();
    }
  });
});
