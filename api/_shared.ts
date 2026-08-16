// ---------------------------------------------------------------------------
// The two things every route here does before anything else
// ---------------------------------------------------------------------------
// 1. Decide whether the calling website is allowed to talk to us at all (CORS).
// 2. Prove the caller is a signed-in ABHL staff member (Firebase ID token).
//
// Both routes need exactly this, so it lives in one place. A file starting with
// `_` is NOT deployed as an endpoint by Vercel — it is just a module the real
// routes import, which is what we want.
//
// Note what is still absent: any Firebase service-account key. Verifying WHO
// someone is needs only Google's public keys. Acting on their behalf would need
// a private key that is effectively root over both Firebase projects, and this
// proxy deliberately never has one. See README.md.
// ---------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify } from 'jose';

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
export const projectIds = (): string[] => csv(process.env.FIREBASE_PROJECT_IDS);
export const allowedOrigins = (): string[] => csv(process.env.ALLOWED_ORIGINS);

export function corsHeaders(origin: string | null): Record<string, string> {
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

export const fail = (
  message: string,
  status: number,
  cors: Record<string, string>,
): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

/**
 * Check the Authorization header holds a valid Firebase ID token from one of
 * our projects. Returns the user's uid, or a ready-to-return 401 Response.
 *
 * Callers should treat this as the ONLY gate — there is nothing else standing
 * between the public internet and a paid API key.
 */
export async function verifyCaller(
  req: Request,
  cors: Record<string, string>,
): Promise<{ uid: string } | { error: Response }> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { error: fail('Missing Firebase ID token', 401, cors) };

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
    return { uid: String(payload.sub) };
  } catch (err) {
    return { error: fail(`Not signed in: ${(err as Error).message}`, 401, cors) };
  }
}

/** Standard preflight + method guard. Returns a Response only if we should stop. */
export function guardMethod(
  req: Request,
  cors: Record<string, string>,
): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405, cors);
  return null;
}
