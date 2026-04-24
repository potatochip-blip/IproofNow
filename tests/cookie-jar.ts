// Minimal in-memory cookie jar that quacks like next/headers cookies().
// Used by tests/test-env.ts to mock the next/headers module.

type CookieAttrs = {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
  path?: string;
  expires?: Date;
  maxAge?: number;
};

let jar = new Map<string, CookieAttrs>();

export function resetCookieJar(): void {
  jar = new Map();
}

export function getCookieJar(): Map<string, CookieAttrs> {
  return jar;
}

export function seedCookie(name: string, value: string): void {
  jar.set(name, { name, value });
}

export function mockCookies() {
  return {
    get(name: string): { name: string; value: string } | undefined {
      const c = jar.get(name);
      return c ? { name: c.name, value: c.value } : undefined;
    },
    set(arg: string | CookieAttrs, value?: string, opts?: Partial<CookieAttrs>): void {
      if (typeof arg === 'string') {
        jar.set(arg, { name: arg, value: value ?? '', ...(opts ?? {}) });
      } else {
        if (arg.maxAge === 0 || arg.value === '') {
          jar.delete(arg.name);
        } else {
          jar.set(arg.name, arg);
        }
      }
    },
    delete(name: string): void {
      jar.delete(name);
    },
    has(name: string): boolean {
      return jar.has(name);
    },
  };
}
