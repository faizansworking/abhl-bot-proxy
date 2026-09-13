// ---------------------------------------------------------------------------
// The narrowest possible Firestore writer, for the Gmail push endpoint only
// ---------------------------------------------------------------------------
// This proxy deliberately had NO Firestore access (see README). Push
// notifications are the one job that cannot run in a browser — Gmail fires
// them at 2am with nobody signed in — so this file exists, and it is kept as
// small as the job: CREATE a `mails` row (never update, never delete, never
// read anything but its own cursor). The service account behind it should
// carry only "Cloud Datastore User", so the key is worth exactly that much.
//
// Uses Firestore's REST API with a token minted from the service-account key
// (RS256 JWT via jose — Web Crypto, so it runs on the edge runtime). No
// firebase-admin: that package is 10MB and assumes Node.
// ---------------------------------------------------------------------------

import { importPKCS8, SignJWT } from 'jose';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

function account(): ServiceAccount {
  const raw = process.env.FIREBASE_SA_KEY;
  if (!raw) throw new Error('FIREBASE_SA_KEY is not set');
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FIREBASE_SA_KEY is not a service-account JSON');
  return sa;
}

let cached: { token: string; expiresAt: number } | null = null;

async function saToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const sa = account();
  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/datastore' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Firestore token refused: ${data.error_description ?? data.error ?? res.status}`);
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

const base = () => `https://firestore.googleapis.com/v1/projects/${account().project_id}/databases/(default)/documents`;

// --- JSON ↔ Firestore's typed values ---------------------------------------------
function toValue(v: unknown): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
}
function toFields(obj: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toValue(v);
  return out;
}
function fromValue(v: any): unknown {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields ?? {});
  return undefined;
}
function fromFields(fields: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

// --- the three operations this endpoint is allowed --------------------------------

/** Create a document. Returns false (and changes nothing) if the id already exists. */
export async function createDoc(collection: string, id: string, data: Record<string, unknown>): Promise<boolean> {
  const token = await saToken();
  const res = await fetch(`${base()}/${collection}?documentId=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) }),
  });
  if (res.status === 409) return false; // already there — exactly what we want
  if (!res.ok) throw new Error(`Firestore create ${collection}/${id} failed: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export async function readDoc(collection: string, id: string): Promise<Record<string, unknown> | null> {
  const token = await saToken();
  const res = await fetch(`${base()}/${collection}/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read ${collection}/${id} failed: ${res.status}`);
  const doc: any = await res.json();
  return fromFields(doc.fields ?? {});
}

/** Merge these fields into a document (creating it if needed). Used only for the cursor. */
export async function mergeDoc(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  const token = await saToken();
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${base()}/${collection}/${encodeURIComponent(id)}?${mask}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore merge ${collection}/${id} failed: ${(await res.text()).slice(0, 200)}`);
}
