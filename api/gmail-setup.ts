// ---------------------------------------------------------------------------
// One-time: connect the firm's central Gmail and get its refresh token
// ---------------------------------------------------------------------------
// Open /api/gmail-setup in a browser, sign in AS THE CENTRAL ACCOUNT
// (cainfo.abhl@gmail.com), allow the two Gmail permissions, and the page
// prints a refresh token to paste into Vercel as GMAIL_REFRESH_TOKEN. Then
// redeploy. That is the whole setup; api/gmail.ts does the rest.
//
// This page is safe to leave public: it only ever shows a token for whichever
// Google account the VISITOR signs into, using our client id. Someone else
// completing it gets a token for their own mailbox, which we never store.
//
// The token is shown once and never logged. Treat it like a password — it IS
// full read + send access to the mailbox until revoked at
// myaccount.google.com → Security → Third-party access.
// ---------------------------------------------------------------------------

export const config = { runtime: 'edge' };

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px;color:#111">
<h2 style="margin:0 0 12px">${title}</h2>${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return page(
      'Gmail setup — not ready',
      `<p>Set <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> in Vercel first
       (Settings → Environment Variables), redeploy, then open this page again.
       See README → Gmail for where those come from.</p>`,
      500,
    );
  }
  // Google sends the user back to exactly this URL, so it must be listed as an
  // authorised redirect URI on the OAuth client. Same path, https, no query.
  const redirectUri = `${url.origin}/api/gmail-setup`;

  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) return page('Gmail setup — refused', `<p>Google said: <b>${err}</b>. Open the page again to retry.</p>`, 400);

  // Step 1: no code yet → send them to Google's consent screen.
  if (!code) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      // offline + consent are what make Google hand over a REFRESH token
      // (without `prompt=consent` a second run gets no refresh token at all).
      access_type: 'offline',
      prompt: 'consent',
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
  }

  // Step 2: back from Google with a code → exchange it once.
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    return page(
      'Gmail setup — no refresh token',
      `<p>Google answered <b>${data.error ?? res.status}</b>${data.error_description ? `: ${data.error_description}` : ''}.</p>
       <p>If there was no error, Google skipped the refresh token because this account already approved the app once.
       Remove the app at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and open this page again.</p>`,
      400,
    );
  }

  // Which mailbox did they connect? Show it so a wrong-account mistake is
  // visible before the token is pasted anywhere.
  let email = '(unknown)';
  try {
    const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${data.access_token}` },
    });
    email = (await prof.json()).emailAddress ?? email;
  } catch { /* cosmetic only */ }

  return page(
    'Gmail connected',
    `<p>Mailbox: <b>${email}</b></p>
     <p>Paste this into Vercel → Settings → Environment Variables as <code>GMAIL_REFRESH_TOKEN</code>, then
     <b>Deployments → Redeploy</b>. Check <a href="/api/health">/api/health</a> afterwards.</p>
     <textarea readonly onclick="this.select()" style="width:100%;height:96px;font:13px monospace">${data.refresh_token}</textarea>
     <p style="color:#666;font-size:13px">Shown once, not stored anywhere. If the mailbox above is wrong, do not paste it —
     sign out of Google and open this page again.</p>`,
  );
}
