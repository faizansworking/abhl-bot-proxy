// ---------------------------------------------------------------------------
// Hiring: CV form → test invite → timed test. Every rule lives here, as plain
// functions; the three routes beside this file only do I/O.
// ---------------------------------------------------------------------------
// Flow (each candidate is ONE `candidates/{token}` doc):
//   1. cv.ts      Tally CV form webhook  → create doc, mail the test link
//   2. start.ts   candidate clicks link   → stamp startedAt once, redirect to Tally
//   3. submit.ts  Tally test webhook      → stamp minutes taken + late flag
// The token is HMAC(secret, email): same email → same doc, so a re-applying
// candidate (or a Tally retry) can never get a second clock or a second mail.
// ---------------------------------------------------------------------------

export const TEST_FORM_URL = 'https://tally.so/r/bZ5bN1';
export const TEST_MINUTES = 60;
export const COLLECTION = 'candidates';

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** Unguessable, stable per email. 32 hex chars. */
export async function tokenFor(email: string, secret: string): Promise<string> {
  if (secret.length < 16) throw new Error('HIRING_SECRET must be set (16+ chars)');
  return hex(await hmac(secret, email.trim().toLowerCase())).slice(0, 32);
}

export const isToken = (t: string) => /^[a-f0-9]{32}$/.test(t);

/** Tally-Signature = base64(HMAC-SHA256(signing secret, JSON body)). */
export async function signatureOk(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header) return false;
  const want = b64(await hmac(secret, rawBody));
  // Tally signs JSON.stringify(payload); accept that form too in case the raw bytes differ in whitespace.
  let alt = '';
  try { alt = b64(await hmac(secret, JSON.stringify(JSON.parse(rawBody)))); } catch { /* not JSON: no alt */ }
  return safeEqual(header, want) || (alt !== '' && safeEqual(header, alt));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface TallyField { key: string; label: string; type: string; value: unknown }

/** First field matching a type and/or label (case-insensitive), as a trimmed string. */
export function field(payload: any, match: { type?: string; label?: string }): string {
  const fields: TallyField[] = payload?.data?.fields ?? [];
  const f = fields.find((x) =>
    (!match.type || x.type === match.type) &&
    (!match.label || String(x.label).trim().toLowerCase() === match.label.toLowerCase()));
  return f?.value == null ? '' : String(f.value).trim();
}

// India time, by hand: edge functions run in UTC.
const IST_MS = 5.5 * 3600_000;
export function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}, ${d.getUTCDate()} ${mon} (IST)`;
}

export const deadlineOf = (startedAt: string) =>
  new Date(new Date(startedAt).getTime() + TEST_MINUTES * 60_000).toISOString();

export function timing(startedAt: string, submittedAt: string) {
  const minutes = Math.round((new Date(submittedAt).getTime() - new Date(startedAt).getTime()) / 60_000);
  return { minutes, late: minutes > TEST_MINUTES };
}

export function testUrl(token: string, startedAt: string): string {
  const q = new URLSearchParams({ t: token, deadline: istClock(deadlineOf(startedAt)) });
  return `${TEST_FORM_URL}?${q}`;
}

/**
 * Who actually receives candidate mail. Until HIRING_LIVE=true every mail goes
 * to HIRING_TEST_TO instead (subject says who it was for), so testing can never
 * mail a real applicant.
 */
export function recipient(real: string, env: { HIRING_LIVE?: string; HIRING_TEST_TO?: string }) {
  if (env.HIRING_LIVE === 'true') return { to: real, tag: '' };
  if (!env.HIRING_TEST_TO) throw new Error('HIRING_TEST_TO is not set and HIRING_LIVE is not true — refusing to mail');
  return { to: env.HIRING_TEST_TO, tag: `[TEST → ${real}] ` };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inviteMail(name: string, link: string) {
  const first = name.split(/\s+/)[0] || 'there';
  const subject = 'ABHL & Associates – Articleship Assessment';
  const body = [
    `Dear ${first},`,
    '',
    'Thank you for applying for articleship at ABHL & Associates.',
    '',
    `The next step is a short written assessment (12 questions, ${TEST_MINUTES} minutes). Your ${TEST_MINUTES} minutes start when you open the link below, so open it only when you are ready and can sit uninterrupted:`,
    '',
    link,
    '',
    'Please answer in your own words. Your answers will be discussed with you in the personal interview.',
    '',
    'Regards,',
    'ABHL & Associates',
    'Vashi, Navi Mumbai',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
<p>Dear ${esc(first)},</p>
<p>Thank you for applying for articleship at <b>ABHL &amp; Associates</b>.</p>
<p>The next step is a short written assessment (<b>12 questions, ${TEST_MINUTES} minutes</b>). Your ${TEST_MINUTES} minutes start when you click the button, so open it only when you are ready and can sit uninterrupted.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#3d57b5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Start the assessment</a></p>
<p>Please answer in your own words. Your answers will be discussed with you in the personal interview.</p>
<p>Regards,<br>ABHL &amp; Associates<br>Vashi, Navi Mumbai</p>
</div>`;
  return { subject, body, html };
}

export function resultMail(c: { name?: unknown; email?: unknown }, t: { minutes: number; late: boolean }) {
  const verdict = t.late ? `LATE ⚠️ (${t.minutes} min)` : `On time ✅ (${t.minutes} min)`;
  return {
    subject: `Assessment submitted: ${String(c.name || c.email)} – ${verdict}`,
    body: `${String(c.name || '')} <${String(c.email || '')}> submitted the articleship assessment.\nTime taken: ${t.minutes} min (limit ${TEST_MINUTES}).\nAnswers: Tally → Articleship Assessment → Submissions.`,
  };
}

export const page = (title: string, text: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<div style="font-family:Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
