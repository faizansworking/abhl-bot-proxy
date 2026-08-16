# ABHL bot proxy

The server-side half of the ABHL Associates in-app assistant. It is deliberately
tiny: **two routes, one job each — hold a key, check who's asking.**

```
Browser (ABHL app on Firebase Hosting)
  │  tools run HERE, on data the app already loaded
  │  POST + Firebase ID token
  ▼
THIS PROXY  (Vercel)
  │  verifies the token against Google's PUBLIC keys   (api/_shared.ts)
  │
  ├─ /api/gemini  → adds GEMINI_API_KEY → Google Gemini      (thinking)
  └─ /api/sarvam  → adds SARVAM_API_KEY → Sarvam AI          (voice)
```

## Why it exists

The app runs entirely in the browser, and anything in a browser can be read by
anyone who presses F12 — so an API key cannot live there. This proxy is the
smallest possible place to keep it.

## What it deliberately does not do

**It never touches Firestore, and there is no Firebase service-account key here.**
That is a design decision, not an omission — see `BOT-SESSION-BRIEF.md` §2 in the
app repo, which recommends the opposite, and the reasoning we chose instead:

- The app's `firestore.rules` are role-based. The Firebase Admin SDK **bypasses
  them entirely**, so a server-side tool layer would have to re-implement every
  permission check by hand, in every tool, forever.
- Verifying *who someone is* needs only Google's public keys. Acting as an admin
  needs a private key that is effectively root over both Firebase projects,
  including every client's portal credentials and all payroll.
- Server-side tools re-query Firestore on every question. The firm is on the free
  tier (50,000 reads/day across ~25 staff). Browser-side tools read arrays the app
  has already loaded, and cost zero.

Instead, the assistant's tools run in the app against data already in memory, so
they inherit the signed-in user's real permissions automatically. An employee's tab
only ever loaded their own tasks, so the assistant cannot show them anyone else's.

The one thing this design cannot do is run when no browser is open — so the
scheduled 7 PM digest to the partner will need its own narrow server-side job
later. That job always runs as "the partner's report" and has no per-user
permission logic, which makes it a much safer place to introduce a service-account
key than a general tool layer would be.

## Environment variables

Set these in Vercel → Settings → Environment Variables. See `.env.example`.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | From [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Free tier, no card. |
| `SARVAM_API_KEY` | The bot's voice. From [dashboard.sarvam.ai](https://dashboard.sarvam.ai). Free trial credits, then billed per character. If missing, the app falls back to the browser's own voice. |
| `FIREBASE_PROJECT_IDS` | Comma-separated project ids whose users may call the bot. Tokens from anywhere else get a 401. |
| `ALLOWED_ORIGINS` | Comma-separated sites allowed to call this from a browser. Everything else is blocked by CORS. |

**To change a key later, see [Changing a key](#changing-a-key) below.**
`/api/health` in a browser tells you which of these are set, without revealing them.

## Endpoints

### `/api/gemini/<google-api-path>` — thinking

```
POST https://<your-project>.vercel.app/api/gemini/models/<model>:generateContent
Authorization: Bearer <firebase id token>
```

The path is passed straight through to `https://generativelanguage.googleapis.com/v1beta`,
so the app can point the Vercel AI SDK's `baseURL` at `/api/gemini` and model
selection, streaming and tool calling all work unchanged.

### `/api/sarvam` — voice

```
POST https://<your-project>.vercel.app/api/sarvam
Authorization: Bearer <firebase id token>
{ "text": "Three things are overdue.", "language_code": "en-IN" }

→ { "request_id": "...", "audios": ["<base64 wav>"] }
```

Unlike the Gemini route, this one is **not** a pass-through. Sarvam bills per
character, and a Firebase ID token proves *who* someone is, not that they should
be allowed to spend money — a borrowed laptop is a valid token. So the route
pins everything expensive server-side and the browser may only choose:

| Field | Allowed |
|---|---|
| `text` | required, **max 500 characters** (Sarvam's own cap is 1500; the app speaks in sentence-sized chunks so the first words start sooner) |
| `language_code` | `en-IN` (default), `hi-IN`, and the other nine Indic codes |
| `speaker` | one of the bulbul:v2 voices; anything else silently becomes `anushka` |

The model, sample rate and preprocessing are fixed in `api/sarvam.ts`. Changing
the voice is a one-line edit there plus a redeploy — deliberately not something
the app can do. Each call logs `uid` and character count, so Vercel's logs are
where you see who is spending the voice budget.

## Changing a key

Keys live in **exactly one place: Vercel environment variables.** Neither git
repo contains one, and none of this needs a Firebase deploy.

1. [vercel.com](https://vercel.com) → project **abhl-bot-proxy** → **Settings → Environment Variables**
2. Edit `GEMINI_API_KEY` or `SARVAM_API_KEY`, paste the new value, **Save**
3. **Deployments → ⋯ on the newest one → Redeploy.** Environment changes do
   **not** take effect until you do this — this is the step people forget.
4. Open `/api/health` to confirm it reads `set`, then ask the bot something.

Note the *model* name is a different thing: that lives in the app repo
(`src/assistant/brain.ts`), and changing it needs an app build, not this.

## Which model to use

The Gemini model id string moves faster than any doc. List what **your** key can
actually access:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  | grep '"name"'
```

Pick a Flash-family model from that list — those are the ones on the free tier. The
model id lives in the **app**, not here, so changing it needs no redeploy of this
proxy.

## Free-tier limits worth knowing

Roughly 10 requests/minute and 1,500/day. One user question becomes 3–6 API calls
once tools are involved, so that is about two concurrent users before throttling —
fine for a partner-only rollout, worth watching if it goes firm-wide. A 429 from
Google is passed straight through so the app can show a friendly "busy, try again"
rather than failing silently.

## Deploy

```bash
npm install
npx vercel        # first run links the project
npx vercel --prod
```

`npm run typecheck` must be green first.

## Related

- App repo: `Timesheet-app-mainV3/Timesheet-app-main` (Vite + React, Firebase Hosting)
- `BOT-SESSION-BRIEF.md` in the app repo — original brief; §3 (task document shape)
  is authoritative for any write tool, §2 (server-side Admin) is superseded by this
  README.
