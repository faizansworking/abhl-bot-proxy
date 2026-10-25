// Tally test form webhook → stamp time taken + late flag on the candidate,
// and tell the firm (HIRING_NOTIFY_TO) so nobody has to go looking.

import { accessToken, send } from '../_gmail';
import { mergeDoc, readDoc } from '../_firestore';
import { COLLECTION, field, isToken, resultMail, signatureOk, timing } from './_lib';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const raw = await req.text();
  if (!(await signatureOk(raw, req.headers.get('tally-signature'), process.env.TALLY_SIGNING_SECRET ?? '')))
    return new Response('Bad signature', { status: 401 });

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  const t = field(payload, { type: 'HIDDEN_FIELDS', label: 't' });
  if (!isToken(t)) return new Response('No test token (form opened without the mail link)', { status: 200 });

  try {
    const c = await readDoc(COLLECTION, t);
    if (!c) return new Response('Unknown token', { status: 200 });
    if (c.testSubmittedAt) return new Response('Already recorded', { status: 200 }); // keep the first

    const submittedAt = new Date().toISOString();
    // No startedAt = they reached the form without the start link; time can't be judged.
    const tm = c.startedAt ? timing(String(c.startedAt), submittedAt) : { minutes: -1, late: true };
    await mergeDoc(COLLECTION, t, {
      testSubmittedAt: submittedAt,
      testSubmissionId: String(payload?.data?.submissionId ?? ''),
      minutesTaken: tm.minutes,
      late: tm.late,
    });

    const notify = process.env.HIRING_NOTIFY_TO;
    if (notify) {
      const m = resultMail(c, tm);
      await send({ to: notify, subject: m.subject, body: m.body }, await accessToken());
    }
    console.log(`[hiring/submit] ${t} minutes=${tm.minutes} late=${tm.late}`);
    return new Response('Recorded', { status: 200 });
  } catch (err) {
    console.error(`[hiring/submit] ${(err as Error).message}`);
    return new Response('Failed', { status: 500 });
  }
}
