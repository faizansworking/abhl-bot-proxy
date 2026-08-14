// Diagnostics. Open this in a browser to check the proxy is alive and its
// environment variables are set. It reports only WHETHER each variable exists,
// never its value — so this is safe to leave public.

export const config = { runtime: 'edge' };

export default async function handler(): Promise<Response> {
  const body = {
    ok: true,
    service: 'abhl-bot-proxy',
    env: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'set' : 'MISSING',
      FIREBASE_PROJECT_IDS: process.env.FIREBASE_PROJECT_IDS ?? 'MISSING',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'MISSING',
    },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
