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
import { accessToken, DEFAULT_DAYS, send, sync, watch } from './_gmail';

export const config = { runtime: 'edge' };
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
