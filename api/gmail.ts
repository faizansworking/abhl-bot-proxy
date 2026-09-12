// ---------------------------------------------------------------------------
// ABHL app — the firm's shared Gmail, read and sent through one door
// ---------------------------------------------------------------------------
// Why this exists: the firm has ONE central Gmail. When one person opens a
// client's mail it turns "read" for everyone, and a notice was missed that way.
// The app now shows every client mail with a PER-PERSON read state, mapped to
// the client — and to do that it needs the mail. Gmail's token cannot live in
// the browser, so it lives here, exactly like the Gemini and Sarvam keys.
//
// Same rules as every other door: check the caller is signed-in staff, add the
// secret, forward. Still no Firestore here — the app writes what this returns.
//
// Two actions, both POST with a Firebase ID token:
//   { action: 'sync', historyId?, days? }
//       → { historyId, messages: MailMeta[], full: boolean }
//     Returns what changed since `historyId` (Gmail's own change cursor). With
//     no cursor, or a cursor Gmail has forgotten (they expire after about a
//     week), it returns the newest mail of the last `days` days instead and
//     says so with `full: true` — the app then de-duplicates against what it
//     already holds.
//   { action: 'send', to, cc?, subject, body, threadId?, inReplyTo? }
//       → { id, threadId }
//     Sends as the central account. Plain text only, on purpose.
//
// METADATA ONLY leaves this function: headers, snippet, attachment NAMES. The
// body is fetched (Gmail's `full` format is the only one that lists the parts,
// and the part list is where the filenames are) and dropped right here. The
// app is a "who mailed us, has anyone answered" board, not a mail client —
// reading and replying stay in Gmail, which is better at both.
//
// Setup (one time, see README "Gmail"): a Google Cloud OAuth client + the
// central account's refresh token, obtained via /api/gmail-setup.
// ---------------------------------------------------------------------------

import { corsHeaders, fail, guardMethod, verifyCaller } from './_shared';

export const config = { runtime: 'edge' };

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Hard ceilings, so a bad cursor can never turn into a thousand fetches.
const MAX_MESSAGES = 100;
const DEFAULT_DAYS = 14;
const CONCURRENCY = 8;
const MAX_BODY_CHARS = 20_000;

export interface MailMeta {
  id: string;
  threadId: string;
  historyId: string;
  at: string; // ISO datetime from Gmail's internalDate
  dir: 'in' | 'out';
  from: string; // bare address, lower-case
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  attachments: { name: string; size: number }[];
  messageIdHeader: string; // RFC Message-ID, for threading replies
}

// --- access token ----------------------------------------------------------
// Edge isolates live for a while; caching the short-lived access token in
// module scope saves a token round-trip on most calls. Nothing depends on it
// being there — a cold isolate just fetches a new one.
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID ?? '',
      client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
      refresh_token: process.env.GMAIL_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // invalid_grant = the refresh token was revoked or expired (an app left in
    // "Testing" on the consent screen expires them after 7 days). The fix is
    // to run /api/gmail-setup again — say so, it is the only likely cause.
    throw new Error(
      `Gmail refused the refresh token (${data.error ?? res.status}). ` +
        `Re-connect via /api/gmail-setup and update GMAIL_REFRESH_TOKEN in Vercel.`,
    );
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gmail(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { __notFound: true };
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gmail ${path.split('?')[0]} failed: ${data?.error?.message ?? res.status}`);
  }
  return data;
}

// --- reading -----------------------------------------------------------------

// "Ram Kumar <ram@x.com>" → { name: 'Ram Kumar', email: 'ram@x.com' }
function parseAddress(raw: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: raw.trim().toLowerCase() };
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => parseAddress(s).email)
    .filter(Boolean);
}

// Attachment names live on the parts tree; a real attachment is any part that
// carries a filename. Inline images in signatures come along too — they are
// small and honest, and filtering by mime would drop a client's photo of a
// challan.
function attachmentsOf(part: any, out: { name: string; size: number }[] = []) {
  if (!part) return out;
  if (part.filename) out.push({ name: String(part.filename), size: Number(part.body?.size ?? 0) });
  for (const p of part.parts ?? []) attachmentsOf(p, out);
  return out;
}

function toMeta(msg: any): MailMeta | null {
  const labels: string[] = msg.labelIds ?? [];
  // Drafts, spam and bin are not "mail that came". Chats never were.
  if (labels.some((l) => l === 'DRAFT' || l === 'SPAM' || l === 'TRASH' || l === 'CHAT')) return null;
  const headers: { name: string; value: string }[] = msg.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const from = parseAddress(h('From'));
  return {
    id: String(msg.id),
    threadId: String(msg.threadId),
    historyId: String(msg.historyId ?? ''),
    at: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
    dir: labels.includes('SENT') ? 'out' : 'in',
    from: from.email,
    fromName: from.name,
    to: splitAddresses(h('To')),
    cc: splitAddresses(h('Cc')),
    subject: h('Subject') || '(no subject)',
    snippet: String(msg.snippet ?? ''),
    attachments: attachmentsOf(msg.payload),
    messageIdHeader: h('Message-ID'),
  };
}

// Fetch N messages a few at a time. The whole document (body included) comes
// down to this function and only the metadata goes out — see the header note.
async function fetchMessages(ids: string[], token: string): Promise<MailMeta[]> {
  const out: MailMeta[] = [];
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        const msg = await gmail(`/messages/${id}?format=full`, token);
        if (msg.__notFound) continue; // deleted between listing and fetching
        const meta = toMeta(msg);
        if (meta) out.push(meta);
      } catch (err) {
        console.warn(`[gmail] message ${id} skipped: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function sync(historyId: string, days: number, token: string) {
  // --- incremental: what changed since the cursor ------------------------
  if (historyId) {
    const ids = new Set<string>();
    let pageToken = '';
    let newest = historyId;
    let ok = true;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({
        startHistoryId: historyId,
        historyTypes: 'messageAdded',
        maxResults: '500',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await gmail(`/history?${q}`, token);
      if (data.__notFound) { ok = false; break; } // cursor too old — fall through
      if (data.historyId) newest = String(data.historyId);
      for (const h of data.history ?? []) {
        for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
      }
      pageToken = data.nextPageToken ?? '';
      if (!pageToken) break;
    }
    if (ok) {
      const messages = await fetchMessages([...ids].slice(0, MAX_MESSAGES), token);
      return { historyId: newest, messages, full: false };
    }
  }

  // --- full: the newest mail of the last N days --------------------------
  const q = new URLSearchParams({
    maxResults: String(MAX_MESSAGES),
    q: `newer_than:${days}d -in:spam -in:trash -in:draft`,
  });
  const [list, profile] = await Promise.all([
    gmail(`/messages?${q}`, token),
    gmail('/profile', token),
  ]);
  const ids: string[] = (list.messages ?? []).map((m: any) => String(m.id));
  const messages = await fetchMessages(ids, token);
  return { historyId: String(profile.historyId ?? ''), messages, full: true };
}

// --- sending -----------------------------------------------------------------

// Base64url of a UTF-8 string, which is what messages.send wants.
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 so a subject like "Documents — ₹ TDS" survives the wire.
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`);

async function send(body: any, token: string) {
  const to = String(body.to ?? '').trim();
  const cc = String(body.cc ?? '').trim();
  const subject = String(body.subject ?? '').trim();
  const text = String(body.body ?? '');
  if (!to) throw new Error('`to` is required');
  if (!subject) throw new Error('`subject` is required');
  if (text.length > MAX_BODY_CHARS) throw new Error(`Body too long (limit ${MAX_BODY_CHARS} characters)`);

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    `Subject: ${encodeHeader(subject)}`,
    body.inReplyTo ? `In-Reply-To: ${body.inReplyTo}` : '',
    body.inReplyTo ? `References: ${body.inReplyTo}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  const raw = [...headers, '', text].join('\r\n');

  const payload: any = { raw: b64url(raw) };
  if (body.threadId) payload.threadId = String(body.threadId);
  const res = await gmail('/messages/send', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { id: String(res.id), threadId: String(res.threadId) };
}

// --- the door -----------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));
  const stop = guardMethod(req, cors);
  if (stop) return stop;

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return fail('Gmail is not connected on the proxy: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN (see README → Gmail)', 500, cors);
  }

  const caller = await verifyCaller(req, cors);
  if ('error' in caller) return caller.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Body must be JSON', 400, cors);
  }

  try {
    const token = await accessToken();
    let result: unknown;
    if (body?.action === 'sync') {
      const days = Math.min(60, Math.max(1, Number(body.days) || DEFAULT_DAYS));
      result = await sync(String(body.historyId ?? ''), days, token);
      console.log(`[gmail] sync uid=${caller.uid} got=${(result as any).messages.length} full=${(result as any).full}`);
    } else if (body?.action === 'send') {
      result = await send(body, token);
      console.log(`[gmail] send uid=${caller.uid} to=${String(body.to ?? '').slice(0, 60)}`);
    } else {
      return fail('Unknown action: use "sync" or "send"', 400, cors);
    }
    return new Response(JSON.stringify(result), {
      headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return fail((err as Error).message, 502, cors);
  }
}
