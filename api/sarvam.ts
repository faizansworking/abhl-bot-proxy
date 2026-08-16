// ---------------------------------------------------------------------------
// ABHL assistant — Sarvam text-to-speech proxy
// ---------------------------------------------------------------------------
// The bot's voice. Same job as api/gemini.ts: check the caller is signed-in
// staff, add the API key, forward. Different upstream, and one important extra
// responsibility — Sarvam is BILLED PER CHARACTER, so this route also decides
// how much a caller is allowed to spend.
//
// The browser sends only `text` (and optionally a language and speaker). It
// cannot choose the model, the sample rate, or anything that costs money. That
// matters because a Firebase ID token belongs to a staff member, and a staff
// member's laptop can be borrowed — the token proves who, not what they should
// be allowed to run up a bill doing.
//
// Sarvam's API:
//   POST https://api.sarvam.ai/text-to-speech
//   header: api-subscription-key
//   body:   { text, language_code, speaker, model, ... }
//   reply:  { request_id, audios: ["<base64 wav>"] }
// ---------------------------------------------------------------------------

import { corsHeaders, fail, guardMethod, verifyCaller } from './_shared';

export const config = { runtime: 'edge' };

const UPSTREAM = 'https://api.sarvam.ai/text-to-speech';

// Pinned here, not in the app: changing the voice is a proxy redeploy, and it
// keeps the browser from asking for an expensive model.
const MODEL = 'bulbul:v2';
// bulbul:v2 voices: anushka, manisha, vidya, arya, abhilash, karun, hitesh.
// Anushka is the warm female Indian-English voice and handles Hinglish well.
const DEFAULT_SPEAKER = 'anushka';
const SPEAKERS = ['anushka', 'manisha', 'vidya', 'arya', 'abhilash', 'karun', 'hitesh'];

// Sarvam's own ceiling for bulbul:v2 is 1500 characters. We cut well below it:
// the app speaks in sentence-sized chunks so the first words start playing
// sooner, and a request longer than this means the app has a bug, not that
// someone genuinely needs a 1500-character sentence read aloud.
const MAX_CHARS = 500;

const LANGUAGES = [
  'en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN',
  'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
];
const DEFAULT_LANGUAGE = 'en-IN';

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));

  const stop = guardMethod(req, cors);
  if (stop) return stop;

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return fail('Proxy misconfigured: SARVAM_API_KEY is not set', 500, cors);

  // --- 1. Who is calling? ---------------------------------------------------
  const caller = await verifyCaller(req, cors);
  if ('error' in caller) return caller.error;

  // --- 2. What are they asking us to say? -----------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Body must be JSON', 400, cors);
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return fail('Nothing to say: `text` is required', 400, cors);
  if (text.length > MAX_CHARS) {
    return fail(
      `Too long: ${text.length} characters, limit is ${MAX_CHARS}. Split it into sentences.`,
      413,
      cors,
    );
  }

  // Anything unrecognised silently becomes the default rather than 400ing —
  // a mid-sentence failure would be far more jarring than a slightly wrong voice.
  const speaker = SPEAKERS.includes(body?.speaker) ? body.speaker : DEFAULT_SPEAKER;
  const language = LANGUAGES.includes(body?.language_code)
    ? body.language_code
    : DEFAULT_LANGUAGE;

  // Character count is the billable unit, so it goes in the log next to the uid.
  // This is the only place the firm can see who is spending the voice budget.
  console.log(`[tts] uid=${caller.uid} chars=${text.length} lang=${language}`);

  // --- 3. Speak -------------------------------------------------------------
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify({
        text,
        language_code: language,
        speaker,
        model: MODEL,
        // 22.05kHz is plenty for speech and is a third smaller over the wire
        // than 44.1k — on a phone that is the difference you actually hear.
        speech_sample_rate: 22050,
        // Expands numbers, dates and currency into words. Our replies are full
        // of "₹1,20,000" and "15-04-2026", which are gibberish read literally.
        enable_preprocessing: true,
      }),
    });
  } catch (err) {
    return fail(`Could not reach Sarvam: ${(err as Error).message}`, 502, cors);
  }

  // Pass the reply through untouched, errors included — the app falls back to
  // the browser's own voice on any failure, so it needs to see the failure.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
