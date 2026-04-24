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

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowList = buildAllowList();
  const isAllowed = origin !== null && allowList.includes(origin);

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
