// Phase 6: strict CSP applied to every response.
//   * /api/* returns JSON only — default-src 'none' is enough.
//   * / (placeholder app/page.tsx) is stub UI but we still ship a strict
//     policy. Habit matters: a future intern adding a real page will see
//     the policy fail and be forced to think about what they're loading.
const CSP_DEFAULT =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Server-only packages webpack must NOT bundle — leave them as runtime
    // `require()` so native addons / broken-`main` CJS packages resolve via
    // Node's own (more lenient) resolver:
    //   * @node-rs/argon2 — ships a native .node addon (pre-existing; the
    //     production build has never tolerated bundling it).
    //   * opentimestamps   — Phase 7. Declares a `main` ('open-timestamps.js')
    //     that doesn't exist; Node falls back to index.js, webpack can't.
    //     Also pulls native-ish CJS deps (bitcore-lib, request).
    serverComponentsExternalPackages: ['@node-rs/argon2', 'opentimestamps'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP_DEFAULT },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
