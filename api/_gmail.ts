// ---------------------------------------------------------------------------
// Gmail plumbing shared by api/gmail.ts (the door the app calls) and
// api/gmail-push.ts (the endpoint Pub/Sub calls). A file starting with `_`
// is not deployed as a route.
// ---------------------------------------------------------------------------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Hard ceilings, so a bad cursor can never turn into a thousand fetches.
export const MAX_MESSAGES = 100;
export const DEFAULT_DAYS = 14;
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

export async function accessToken(): Promise<string> {
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

export async function gmail(path: string, token: string, init: RequestInit = {}): Promise<any> {
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

// The MIME parts tree, flattened (root first) so every reader is a .find/.filter.
const parts = (p: any, out: any[] = []): any[] => {
  if (p) { out.push(p); for (const c of p.parts ?? []) parts(c, out); }
  return out;
};
const cidOf = (p: any): string | undefined =>
  (p.headers ?? []).find((h: any) => h.name.toLowerCase() === 'content-id')?.value?.replace(/[<>]/g, '');

// A real attachment is any part that carries a filename. Inline images in
// signatures come along too — they are small and honest, and filtering by
// mime would drop a client's photo of a challan.
const attachmentsOf = (payload: any) =>
  parts(payload).filter((p) => p.filename).map((p) => ({ name: String(p.filename), size: Number(p.body?.size ?? 0) }));

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
export async function fetchMessages(ids: string[], token: string): Promise<MailMeta[]> {
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

// Gmail's own search (the same syntax as its search box: "from:x has:attachment
// TDS notice"). Gmail already indexes every mail, so nothing is stored by us.
export async function search(q: string, token: string): Promise<MailMeta[]> {
  const text = q.trim().slice(0, 200);
  if (!text) return [];
  const params = new URLSearchParams({ maxResults: '30', q: `${text} -in:spam -in:trash -in:draft` });
  const list = await gmail(`/messages?${params}`, token);
  return fetchMessages((list.messages ?? []).map((m: any) => String(m.id)), token);
}

// Message ids added since Gmail's change cursor, plus the cursor to hold next.
// null when Gmail has forgotten the cursor (they expire after about a week).
export async function historySince(historyId: string, token: string): Promise<{ ids: string[]; newest: string } | null> {
  const ids = new Set<string>();
  let newest = historyId;
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await gmail(`/history?${q}`, token);
    if (data.__notFound) return null;
    if (data.historyId) newest = String(data.historyId);
    for (const h of data.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return { ids: [...ids], newest };
}

export async function sync(historyId: string, days: number, token: string) {
  // --- incremental: what changed since the cursor ------------------------
  const since = historyId ? await historySince(historyId, token) : null;
  if (since) {
    const messages = await fetchMessages(since.ids.slice(0, MAX_MESSAGES), token);
    return { historyId: since.newest, messages, full: false };
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

export async function send(body: any, token: string) {
  const to = String(body.to ?? '').trim();
  const cc = String(body.cc ?? '').trim();
  const subject = String(body.subject ?? '').trim();
  const text = String(body.body ?? '');
  if (!to) throw new Error('`to` is required');
  if (!subject) throw new Error('`subject` is required');
  if (text.length > MAX_BODY_CHARS) throw new Error(`Body too long (limit ${MAX_BODY_CHARS} characters)`);

  const html = body.html ? String(body.html) : '';
  if (html.length > MAX_BODY_CHARS * 5) throw new Error('HTML too long');
  const files: { name: string; mime?: string; data: string }[] = Array.isArray(body.attachments) ? body.attachments : [];
  const bcc = String(body.bcc ?? '').trim();

  // The readable part: text only, or text + HTML (clients pick the richer one).
  const lines = (s: string) => s.replace(/(.{76})/g, '$1\r\n');
  const alt = html
    ? ['Content-Type: multipart/alternative; boundary="abhl-alt"', '',
        '--abhl-alt', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text,
        '--abhl-alt', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html,
        '--abhl-alt--']
    : ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text];
  // With files the whole thing is wrapped in multipart/mixed.
  const content = files.length
    ? ['Content-Type: multipart/mixed; boundary="abhl-mix"', '', '--abhl-mix', ...alt,
        ...files.flatMap((f) => ['--abhl-mix',
          `Content-Type: ${f.mime || 'application/octet-stream'}; name="${encodeHeader(f.name)}"`,
          `Content-Disposition: attachment; filename="${encodeHeader(f.name)}"`,
          'Content-Transfer-Encoding: base64', '', lines(String(f.data))]),
        '--abhl-mix--']
    : alt;

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    bcc ? `Bcc: ${bcc}` : '',
    `Subject: ${encodeHeader(subject)}`,
    body.inReplyTo ? `In-Reply-To: ${body.inReplyTo}` : '',
    body.inReplyTo ? `References: ${body.inReplyTo}` : '',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const raw = [...headers, ...content].join('\r\n');

  const payload: any = { raw: b64url(raw) };
  if (body.threadId) payload.threadId = String(body.threadId);
  const res = await gmail('/messages/send', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { id: String(res.id), threadId: String(res.threadId) };
}


// Ask Gmail to publish "something changed" to our Pub/Sub topic. Lasts 7 days,
// so the app re-calls this daily (see useMailSync). Returns Gmail's current
// history cursor, which the push handler starts from.
export async function watch(token: string): Promise<{ historyId: string; expiration: string }> {
  const topicName = process.env.GMAIL_PUSH_TOPIC;
  if (!topicName) throw new Error('GMAIL_PUSH_TOPIC is not set');
  const res = await gmail('/watch', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topicName }),
  });
  return { historyId: String(res.historyId ?? ''), expiration: String(res.expiration ?? '') };
}


// --- reading one mail's body, on demand -----------------------------------------
// Nothing here is stored: the app shows it in a sandboxed frame and forgets it.
const dec = (d: string) => {
  const b = atob(d.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function read(id: string, token: string): Promise<{ html: string; attachments: { name: string; mime: string; size: number; attachmentId: string }[] }> {
  const msg = await gmail(`/messages/${encodeURIComponent(id)}?format=full`, token);
  if (msg.__notFound) throw new Error('That mail is no longer in Gmail');
  const all = parts(msg.payload);
  const findPart = (mime: string) => all.find((p) => p.mimeType === mime && p.body?.data);
  const h = findPart('text/html');
  const t = findPart('text/plain');
  const rawHtml = h ? dec(h.body.data) : '';
  let html = h
    ? rawHtml
    : `<div style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:14px">${esc(t ? dec(t.body.data) : String(msg.snippet ?? ''))}</div>`;
  const isInlineImage = (p: any) => cidOf(p) && p.body?.attachmentId && String(p.mimeType).startsWith('image/');
  // Pictures embedded in the mail (cid:) only exist inside Gmail — inline them
  // as data: URIs so the signature logo shows. Capped, so one mail can't balloon.
  for (const part of all.filter(isInlineImage).slice(0, 8)) {
    const cid = cidOf(part);
    if (!html.includes(`cid:${cid}`) || Number(part.body.size) > 400_000) continue;
    const a = await gmail(`/messages/${encodeURIComponent(id)}/attachments/${part.body.attachmentId}`, token);
    if (a.data) html = html.split(`cid:${cid}`).join(`data:${part.mimeType};base64,${a.data.replace(/-/g, '+').replace(/_/g, '/')}`);
  }
  // Real attachments; pictures already drawn inside the mail (cid) are skipped.
  const attachments = all
    .filter((p) => p.filename && p.body?.attachmentId && !(isInlineImage(p) && rawHtml.includes(`cid:${cidOf(p)}`)))
    .map((p) => ({ name: String(p.filename), mime: String(p.mimeType ?? ''), size: Number(p.body.size ?? 0), attachmentId: String(p.body.attachmentId) }));
  return { html, attachments };
}

// One attachment's bytes, as standard base64 (the browser turns it into a download).
export async function attachment(id: string, attachmentId: string, token: string): Promise<{ data: string }> {
  const a = await gmail(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, token);
  if (a.__notFound || !a.data) throw new Error('Attachment not found');
  return { data: String(a.data).replace(/-/g, '+').replace(/_/g, '/') };
}
