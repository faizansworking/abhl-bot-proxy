// Tally CV form webhook → save the candidate, mail them their test link.
// Replies 2xx for anything retrying can't fix (bad payload, already invited),
// 5xx when Gmail/Firestore failed so Tally retries.

import { accessToken, send } from '../_gmail';
import { brandedHtml } from '../_brand';
import { createDoc, mergeDoc, readDoc } from '../_firestore';
import { COLLECTION, field, inviteMail, recipient, signatureOk, tokenFor } from './_lib';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const raw = await req.text();
  if (!(await signatureOk(raw, req.headers.get('tally-signature'), process.env.TALLY_SIGNING_SECRET ?? '')))
    return new Response('Bad signature', { status: 401 });

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  const email = field(payload, { type: 'INPUT_EMAIL' }).toLowerCase();
  if (!email.includes('@')) return new Response('No email in submission', { status: 200 });

  try {
    const token = await tokenFor(email, process.env.HIRING_SECRET ?? '');
    const name = field(payload, { label: 'Name' });
    await createDoc(COLLECTION, token, {
      email,
      name,
      phone: field(payload, { type: 'INPUT_PHONE_NUMBER' }),
      cvSubmissionId: String(payload?.data?.submissionId ?? ''),
      appliedAt: new Date().toISOString(),
    });
    // Same email again (re-apply or Tally retry): one invite only.
    if ((await readDoc(COLLECTION, token))?.invitedAt) return new Response('Already invited', { status: 200 });

    const link = `${new URL(req.url).origin}/api/hiring/start?t=${token}`;
    const mail = inviteMail(name, link);
    const { to, tag } = recipient(email, process.env);
    const html = brandedHtml(mail.text, { button: mail.button, note: mail.note });
    await send({ to, subject: tag + mail.subject, body: mail.body, html }, await accessToken());
    await mergeDoc(COLLECTION, token, { invitedAt: new Date().toISOString() });
    console.log(`[hiring/cv] invited ${token} to=${to}`);
    return new Response('Invited', { status: 200 });
  } catch (err) {
    console.error(`[hiring/cv] ${(err as Error).message}`);
    return new Response('Failed', { status: 500 });
  }
}
