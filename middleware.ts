import { NextResponse, type NextRequest } from 'next/server';

const STATIC_ALLOWED = ['http://localhost:3000'];

function buildAllowList(): string[] {
  const extra = (process.env.FRONTEND_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...STATIC_ALLOWED, ...extra];
}

const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type,Authorization';

/**
 * 100 MB cap. Matches the per-file upload cap in
 * /api/proofs/[proofId]/files; the route still enforces its own limit
 * after parsing in case a client lies about Content-Length, but rejecting
 * here avoids the multipart parser ever seeing an oversized body.
 */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowList = buildAllowList();
  const isAllowed = origin !== null && allowList.includes(origin);

  // Body-cap check before anything else. Content-Length is required for
  // bounded payloads; chunked / streaming requests without it pass through
  // and rely on the route's own enforcement.
  const cl = req.headers.get('content-length');
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Request body exceeds ${MAX_BODY_BYTES} byte limit`,
          },
        },
        { status: 413 }
      );
    }
  }

  if (req.method === 'OPTIONS') {
    const headers = new Headers();
    if (isAllowed && origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
      headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
      headers.set('Access-Control-Max-Age', '86400');
      headers.set('Vary', 'Origin');
    }
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  if (isAllowed && origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Credentials', 'true');
    res.headers.set('Vary', 'Origin');
  }
  return res;
}

export const config = {
  matcher: '/api/:path*',
};
