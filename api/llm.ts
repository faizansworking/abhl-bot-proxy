// ---------------------------------------------------------------------------
// ABHL assistant — one door for every OpenAI-compatible model provider
// ---------------------------------------------------------------------------
// Groq, Cerebras, Mistral and most of the rest all speak the SAME dialect as
// OpenAI: POST /chat/completions, same body, same reply. So they do not need a
// file each — they need one route and a lookup table.
//
// (Gemini keeps its own route, api/gemini.ts, because Google's format is
// genuinely different. Two shapes, two routes, not five.)
//
// Called as /api/llm/<provider>/<path>, e.g. /api/llm/groq/chat/completions.
// vercel.json rewrites that into ?path=..., the same trick api/gemini.ts uses
// and for the same reason: filesystem catch-all routing is what 404'd before.
//
// A provider that is not in the table below, or whose key is not set in Vercel,
// is refused here. The browser cannot reach an arbitrary URL through this.
// ---------------------------------------------------------------------------

import { corsHeaders, fail, guardMethod, verifyCaller } from './_shared';

export const config = { runtime: 'edge' };

interface Provider {
  base: string;
  env: string;
  /** Shown in errors and logs. Also a reminder of what we signed up to. */
  note: string;
}

const PROVIDERS: Record<string, Provider> = {
  groq: {
    base: 'https://api.groq.com/openai/v1',
    env: 'GROQ_API_KEY',
    note: '30 req/min, 1k req/day — the best per-MINUTE headroom we have',
  },
  cerebras: {
    base: 'https://api.cerebras.ai/v1',
    env: 'CEREBRAS_API_KEY',
    note: '~1M tokens/day — the volume option, for when the whole firm uses it',
  },
  // WARNING, and it is not a small one: Mistral's free tier trains on your
  // inputs unless you opt out in their Admin Console → Privacy, and it allows
  // only ~2 requests a MINUTE. Questions here carry client names and amounts.
  // It is wired up because it was asked for, but it is last in the order in
  // src/assistant/models.ts, and it should stay there.
  mistral: {
    base: 'https://api.mistral.ai/v1',
    env: 'MISTRAL_API_KEY',
    note: '2 req/min, TRAINS ON INPUT unless opted out — last resort only',
  },
};

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));

  const stop = guardMethod(req, cors);
  if (stop) return stop;

  // --- 1. Who is calling? ---------------------------------------------------
  const caller = await verifyCaller(req, cors);
  if ('error' in caller) return caller.error;

  // --- 2. Which provider, and are we allowed to use it? ---------------------
  const url = new URL(req.url);
  const raw = url.searchParams.get('path') ?? '';
  const [name, ...rest] = raw.split('/').filter(Boolean);
  const path = rest.join('/');

  const provider = PROVIDERS[name ?? ''];
  if (!provider) {
    return fail(
      `Unknown provider "${name}". Known: ${Object.keys(PROVIDERS).join(', ')}.`,
      400,
      cors,
    );
  }
  if (!path) return fail('No upstream path, e.g. /api/llm/groq/chat/completions', 400, cors);

  const apiKey = process.env[provider.env];
  // Not an error worth shouting about: the app tries providers in order and a
  // missing key simply means "we never signed up for this one". 503 tells the
  // app to move on to the next rather than show the user a failure.
  if (!apiKey) {
    return fail(`${name} is not configured (${provider.env} is not set)`, 503, cors);
  }

  url.searchParams.delete('path');
  const query = url.searchParams.toString();

  // Shows in the Vercel logs — the quickest way to see which provider is
  // actually carrying the load, and who is asking.
  console.log(`[llm] uid=${caller.uid} -> ${name}/${path}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${provider.base}/${path}${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: req.body,
      // Required when streaming a request body through fetch.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    return fail(`Could not reach ${name}: ${(err as Error).message}`, 502, cors);
  }

  // Straight through, errors included. A 429 here is the signal the app uses
  // to give up on this provider and try the next one.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
