// The link in the invite mail. First click stamps startedAt (the clock);
// every later click reuses it, so the clock can't be reset.

import { mergeDoc, readDoc } from '../_firestore';
import { COLLECTION, isToken, page, testUrl } from './_lib';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  if (!isToken(t)) return page('Link not valid', 'Please use the link from your email.', 404);

  try {
    const c = await readDoc(COLLECTION, t);
    if (!c) return page('Link not valid', 'Please use the link from your email.', 404);
    if (c.testSubmittedAt) return page('Already submitted', 'Thank you, your assessment has been recorded.');

    let startedAt = String(c.startedAt ?? '');
    if (!startedAt) {
      startedAt = new Date().toISOString();
      await mergeDoc(COLLECTION, t, { startedAt });
    }
    return Response.redirect(testUrl(t, startedAt), 302);
  } catch (err) {
    console.error(`[hiring/start] ${(err as Error).message}`);
    return page('Something went wrong', 'Please try the link again in a minute.', 500);
  }
}
