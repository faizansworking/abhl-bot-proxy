// ---------------------------------------------------------------------------
// ABHL assistant — Gemini proxy
// ---------------------------------------------------------------------------
// This is the ONLY server-side piece of the assistant, and it does exactly two
// things:
//
//   1. Checks that the caller is a signed-in ABHL staff member, by verifying
//      their Firebase ID token against Google's PUBLIC signing keys.
//   2. Swaps in the Gemini API key and forwards the request to Google,
//      streaming the reply straight back.
//
// What it deliberately does NOT do: touch Firestore. There is no Firebase
// service-account key here, and there must never be one. Verifying *who
// someone is* needs only public keys; acting as an admin would need a private
// key that bypasses every security rule in the app. The assistant's tools run
// in the browser instead, against data the app has already loaded, so they
// inherit the user's real permissions from firestore.rules for free.
//
// ROUTING: the app points the Vercel AI SDK's `baseURL` at /api/gemini, and the
// SDK then appends paths like `/models/<model>:streamGenerateContent`. The
// rewrite in vercel.json turns that into `?path=models/<model>:stream...` so we
// never depend on filesystem catch-all routing, which is the thing that 404'd.
// ---------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify } from 'jose';

export const config = { runtime: 'edge' };

const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta';

// Google's public keys for Firebase ID tokens. Public — safe to fetch, nothing
// secret involved. `jose` caches and refreshes these automatically.
const JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
);

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// The firm runs TWO Firebase projects (main + Ahmedabad branch), so a token is
// valid if it was issued by any project we list.
const projectIds = (): string[] => csv(process.env.FIREBASE_PROJECT_IDS);
const allowedOrigins = (): string[] => csv(process.env.ALLOWED_ORIGINS);

function corsHeaders(origin: string | null): Record<string, string> {
  const list = allowedOrigins();
  const permitted = origin !== null && list.includes(origin);
  return {
    // Only ever echo back an origin we explicitly trust.
    'Access-Control-Allow-Origin': permitted ? origin : (list[0] ?? 'null'),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-goog-api-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const fail = (
  message: string,
  status: number,
  cors: Record<string, string>,
): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405, cors);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail('Proxy misconfigured: GEMINI_API_KEY is not set', 500, cors);
  if (projectIds().length === 0) {
    return fail('Proxy misconfigured: FIREBASE_PROJECT_IDS is not set', 500, cors);
  }

  // --- 1. Who is calling? ---------------------------------------------------
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail('Missing Firebase ID token', 401, cors);

  let uid: string;
  try {
    // jwtVerify checks the signature and expiry; we check who it was issued to.
    const { payload } = await jwtVerify(token, JWKS);
    const audience = String(payload.aud ?? '');
    if (!projectIds().includes(audience)) {
      throw new Error('token belongs to a different Firebase project');
    }
    if (payload.iss !== `https://securetoken.google.com/${audience}`) {
      throw new Error('unexpected issuer');
    }
    if (!payload.sub) throw new Error('token has no subject');
    uid = String(payload.sub);
  } catch (err) {
    return fail(`Not signed in: ${(err as Error).message}`, 401, cors);
  }

  // --- 2. Work out what to call upstream ------------------------------------
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) {
    return fail(
      'No upstream path. Call /api/gemini/models/<model>:generateContent, not /api/gemini directly.',
      400,
      cors,
    );
  }
  // Everything except our own `path` marker is a real Gemini query param
  // (notably ?alt=sse, which is how streaming is requested).
  url.searchParams.delete('path');
  const query = url.searchParams.toString();

  // Shows up in the Vercel logs — the quickest way to see who is using the bot
  // and which model they hit when something misbehaves.
  console.log(`[bot] uid=${uid} -> ${path}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}/${path}${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: req.body,
      // Required when streaming a request body through fetch.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    return fail(`Could not reach Gemini: ${(err as Error).message}`, 502, cors);
  }

  // Pass the response straight through, including Gemini's own error bodies —
  // a 429 here means the free-tier rate limit, which the app surfaces to the user.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
