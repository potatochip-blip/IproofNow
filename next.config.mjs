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
