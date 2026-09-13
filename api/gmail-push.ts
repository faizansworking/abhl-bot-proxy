// ---------------------------------------------------------------------------
// Gmail → Pub/Sub → HERE → Firestore: a mail lands in the app within seconds,
// with nobody signed in
// ---------------------------------------------------------------------------
// The app's own sync (a manager's open tab polling every minute) stays on —
// this is the 2am path, and the safety net if it ever hiccups. The two can
// never fight: rows are CREATED by Gmail message id and creation of an id
// that exists is a no-op (see _firestore.ts), so whichever side is first wins
// and the other silently loses nothing.
//
// What Pub/Sub sends is only "mailbox X changed, history is now at N" — no
// mail in it. We read our own cursor (system/mailPush.historyId), ask Gmail
// what was added since, fetch those messages' metadata and create the rows.
// Matching to a client, notice detection and the per-person read state are
// NOT done here: the app does them the moment the row arrives (useMailSync's
// reconcile step), because the client list lives in the app and this
// function should know as little as possible.
//
// Authentication: Pub/Sub can't carry a Firebase token, so the push
// subscription's URL carries a secret (?token=…) that must equal
// GMAIL_PUSH_SECRET. Anything else gets 403 and Pub/Sub stops retrying it.
//
// Replies: 204 = done, drop it. 5xx = Pub/Sub retries later (with backoff, if
// the subscription is configured that way — the README says to). We answer
// 204 even for "nothing new" and "cursor too old", because retrying those
// can never help.
// ---------------------------------------------------------------------------

import { accessToken, fetchMessages, gmail, type MailMeta } from './_gmail';
import { createDoc, mergeDoc, readDoc } from './_firestore';

export const config = { runtime: 'edge' };

const CURSOR = { collection: 'system', id: 'mailPush' };
// A first run, or a cursor Gmail has forgotten: just take the newest handful.
// The app's poll covers anything older.
const CATCH_UP = 25;

// India: the app files a mail under the LOCAL day it arrived (the Day-book
// convention). Edge functions run in UTC, so the offset is applied by hand.
const IST_OFFSET_MS = 5.5 * 3600_000;
function istDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function toRow(m: MailMeta) {
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: m.historyId,
    at: m.at,
    day: istDay(m.at),
    dir: m.dir,
    from: m.from,
    fromName: m.fromName,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    snippet: m.snippet,
    attachments: m.attachments,
    messageIdHeader: m.messageIdHeader,
    syncedAt: new Date().toISOString(),
    source: 'push',
  };
}

async function idsSince(historyId: string, token: string): Promise<{ ids: string[]; newest: string } | null> {
  const ids = new Set<string>();
  let newest = historyId;
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await gmail(`/history?${q}`, token);
    if (data.__notFound) return null; // Gmail forgot this cursor
    if (data.historyId) newest = String(data.historyId);
    for (const h of data.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return { ids: [...ids], newest };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.GMAIL_PUSH_SECRET;
  const given = new URL(req.url).searchParams.get('token') ?? '';
  if (!secret || given !== secret) return new Response('Forbidden', { status: 403 });

  // Pub/Sub envelope: { message: { data: base64(JSON), messageId, publishTime } }
  let notified = '';
  try {
    const body: any = await req.json();
    const data = JSON.parse(atob(String(body?.message?.data ?? ''))) as { emailAddress?: string; historyId?: string | number };
    notified = String(data.historyId ?? '');
  } catch {
    return new Response('Bad envelope', { status: 400 }); // malformed: retrying can't fix it
  }

  try {
    const token = await accessToken();
    const cursor = await readDoc(CURSOR.collection, CURSOR.id);
    const start = String(cursor?.historyId ?? '');

    let metas: MailMeta[];
    let newest: string;
    const since = start ? await idsSince(start, token) : null;
    if (since) {
      metas = await fetchMessages(since.ids.slice(0, 100), token);
      newest = since.newest;
    } else {
      // No cursor yet, or a stale one: newest few, then stand at Gmail's current position.
      const list = await gmail(`/messages?${new URLSearchParams({ maxResults: String(CATCH_UP), q: '-in:spam -in:trash -in:draft' })}`, token);
      metas = await fetchMessages((list.messages ?? []).map((m: any) => String(m.id)), token);
      newest = notified || String((await gmail('/profile', token)).historyId ?? '');
    }

    let created = 0;
    for (const m of metas) if (await createDoc('mails', m.id, toRow(m))) created++;
    if (newest && newest !== start) await mergeDoc(CURSOR.collection, CURSOR.id, { historyId: newest, at: new Date().toISOString() });

    console.log(`[gmail-push] since=${start || 'none'} fetched=${metas.length} created=${created} now=${newest}`);
    return new Response(null, { status: 204 });
  } catch (err) {
    // Gmail or Firestore was unreachable: let Pub/Sub retry.
    console.error(`[gmail-push] ${(err as Error).message}`);
    return new Response((err as Error).message, { status: 500 });
  }
}
