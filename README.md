# 3Dollar AI backend

A small server that sits between the app and the plan's AI endpoint. It does
two jobs and nothing else:

1. **Checks payment.** The app sends its Google Play purchase token; the
   server asks Google whether it is a live `pro_monthly` subscription and, if
   so, returns a signed **pass** that lasts 24 hours.
2. **Carries AI requests.** The app sends chat requests here with its pass.
   The server checks the pass, adds the real AI key, forwards the request and
   streams the reply back.

The AI key, the pass-signing secret and the Google credentials live only in
this server's environment.

```
app ──purchase token──▶ POST /auth ──▶ Google Play     ──▶ pass (24 h)
app ──pass + chat────▶ POST /v1/chat/completions ──+key──▶ AI endpoint
```

There are no rate limits or usage caps: a subscriber with a valid pass is
never turned away by this server.

## Endpoints

| Method and path | Needs | Does |
|---|---|---|
| `POST /auth` | `{"purchaseToken": "…"}` | Returns `{pass, expiresAt, subscriptionExpiresAt}`, or `403 plan_inactive` |
| `POST /v1/chat/completions` | `Authorization: Bearer <pass>` | OpenAI-compatible chat, streaming supported. The model is always the plan's (`auto`) |
| `GET /v1/models` | `Authorization: Bearer <pass>` | Lists the one plan model |
| `GET /health` | nothing | `{"ok": true}` for Render's health check |

Errors use the OpenAI shape: `{"error": {"code", "message", "type"}}`.

| Status | Code | Meaning for the app |
|---|---|---|
| 401 | `invalid_pass` | Pass missing, expired or forged. Call `/auth` again |
| 403 | `plan_inactive` | Google says there is no live subscription |
| 503 | `verify_unavailable` | Google could not be reached. Keep the current pass, retry later |
| 502 | `upstream_auth`, `upstream_unreachable` | Our side is broken, not the user's |
| 413 | `too_large` | The request is over `MAX_BODY_MB` |

Anything else (for example a 429 from the AI endpoint itself) is passed
through unchanged.

## Run it locally

Needs Node 20 or newer.

```sh
npm install
cp .env.example .env      # then fill in UPSTREAM_API_KEY and PASS_SECRET
npm run dev
```

Before Google Play is set up, uncomment `DEV_PURCHASE_TOKEN` in `.env`. That
one made-up token is then accepted without asking Google:

```sh
curl -s localhost:3000/auth -H "content-type: application/json" \
  -d '{"purchaseToken":"dev-token-123"}'
# copy "pass" from the reply, then:
curl -N localhost:3000/v1/chat/completions \
  -H "authorization: Bearer <pass>" -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

`DEV_PURCHASE_TOKEN` is ignored when `NODE_ENV=production`.

Tests: `npm test`.

## Deploy on Render

1. Push this repo. In Render choose **New > Blueprint** and pick the repo.
   `render.yaml` describes the service (health check `/health`).
2. Render asks for two secrets:
   - `UPSTREAM_API_KEY`: the AI endpoint's key.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: see the next section.
   `PASS_SECRET` is generated for you.
3. After the deploy, open `https://<your-service>.onrender.com/health`.

Without a Blueprint: create a **Web Service**, set build command
`npm ci --omit=dev`, start command `npm start`, and add the variables from
`.env.example` by hand, plus `NODE_ENV=production`.

## Google Play setup (one time)

The server needs permission to look up purchases.

1. **Google Cloud Console** > pick or create a project > *APIs & Services* >
   enable **Google Play Android Developer API**.
2. *IAM & Admin > Service Accounts* > **Create service account** (any name,
   no roles needed) > open it > *Keys* > **Add key > JSON**. A file downloads.
3. **Play Console** > *Users and permissions* > **Invite new users** > paste
   the service account's email (`…@….iam.gserviceaccount.com`) > under *App
   permissions* add 3Dollar AI > tick **View financial data** and **Manage
   orders and subscriptions** > invite.
4. Put the key file into Render as `GOOGLE_SERVICE_ACCOUNT_JSON`. Base64
   avoids pasting problems:
   - PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`
   - macOS/Linux: `base64 -w0 key.json`
5. Delete the downloaded file, or keep it somewhere safe outside the repo.

New permissions can take a while to work: Google says up to 24 hours, though
it is usually minutes. Until then `/auth` answers `503 verify_unavailable` and
the Render log shows `Play API 401` or `403`.

## Many users

The design holds up as the user base grows:

- **Passes need no database.** A pass is checked with one signature
  verification, in memory, with no lookup. Chat requests never touch Google.
- **Google is asked rarely.** Once per subscriber per pass (about once a
  day). An active answer is cached for 5 minutes, a "no" for 30 seconds, and
  a burst for the same token makes a single lookup. Google's default quota is
  3,000 lookups a minute.
- **More instances just work.** Nothing is shared between requests except
  the secrets in the environment, so on Render you can raise the instance
  count (or size) with no code change.
- **Replies are streamed, not buffered.** A long reply costs almost no
  memory. A request's body is released as soon as it has been forwarded.

What to watch:

- **Instance size.** The free instance sleeps after 15 idle minutes and takes
  up to a minute to wake. Use a paid instance. Requests with images are held
  in memory a few times over while they are forwarded (a 4 MB request needs
  roughly 15 to 20 MB for a moment), so many image requests at once need
  memory: start with 512 MB and move up if Render's memory graph gets close.
- **The AI endpoint is the real ceiling.** This server adds about 20 to 30 ms
  per request and can carry hundreds a second. How many users the plan
  supports depends on what `genrecai-freellmapi` and the models behind it
  can take, and on that service not sleeping either.

## Retries

Calls this server makes are retried automatically, so a brief failure never
reaches the user.

**To the AI endpoint** (up to 3 tries, 120 seconds in total by default):

- Retried: no connection, a try that doesn't start answering within 90
  seconds, and the statuses 408, 425, 429, 500, 502, 503, 504, 520 to 524
  and 529. These mean "waking up", "overloaded" or "briefly broken".
- Not retried: other 4xx. The request itself is wrong, so the answer is passed
  straight to the app.
- Waits 0.5 s, then 1 s, and so on (with jitter), never more than 8 s at once.
- A `Retry-After` of up to 8 s is waited out. A longer one is passed to the app
  rather than holding the request open.
- Retries only happen before any of the reply has been sent. Once a reply is
  streaming it is never restarted, because the app would get duplicate text.
- If the user closes the chat, waiting and retrying stop at once.
- A reply that starts and then sends nothing for 180 seconds is cut off.

**To Google Play** (3 tries, short waits): same rules. If it still fails,
`/auth` answers `503 verify_unavailable` and the app keeps its current pass.

Each retry is written to the Render log as
`Upstream try 1 failed (503); retrying in 412 ms`.

## How a subscription ending plays out

- A pass lasts 24 hours and never longer than the paid period.
- The app asks for a new pass before the old one expires. Once Google reports
  the subscription expired, on hold or paused, `/auth` answers
  `403 plan_inactive` and access stops when the current pass runs out.
- A cancelled subscription keeps working until the period already paid for
  ends, as Play intends.

## Security

| Threat | Protection |
|---|---|
| Someone reads the AI key out of the app | The key exists only in this server's environment. It is never sent to a client or written to a log, and a rejected key is reported as a generic 502 |
| Using the AI without paying | Every `/v1` request needs a pass. Passes are signed (HS256, issuer and audience checked) and only issued after Google confirms a live subscription for this app and product |
| A forged or edited pass | Rejected: the signature covers the subscriber and the expiry |
| A cancelled or expired subscription | The pass lasts 24 hours at most and never beyond the paid period |
| Reaching a costlier model with a pass | The model is pinned to the plan's, and `n` is removed |
| Huge or slow requests | Size cap (12 MB) and timeouts on receiving a request. Unauthenticated callers can't make the server read a large body |
| Another website using a visitor's pass | No CORS headers are sent, so browsers refuse cross-site calls |
| Stored secrets | None. Purchase tokens are held in memory only as hashes; nothing is written to disk |

Dependencies: three (`express`, `jose`, `google-auth-library`), versions
locked in `package-lock.json`. Check them with `npm audit`.

Deliberately not done, because the server only checks payment and carries AI
requests:

- **No rate limits.** A subscriber, or anyone holding a subscriber's pass,
  can send as many requests as the AI endpoint will accept until the pass
  expires. If one account ever abuses this, the fix is a per-subscriber limit
  here or on the AI endpoint.
- **A purchase isn't tied to one phone.** A subscriber could share their
  purchase token with others.
- **Refunds and chargebacks** take effect when the pass is renewed, so within
  24 hours rather than at once.

This has been reviewed and tested by its author, not by an independent
auditor.

## Settings

All in `.env.example`, with comments. The ones you may want to change:

| Variable | Default | Effect |
|---|---|---|
| `PASS_TTL_SECONDS` | 86400 | Shorter cuts off ended subscriptions sooner, at the cost of more Google lookups |
| `UPSTREAM_ATTEMPTS` | 3 | Tries per AI request, first included. 1 turns retries off |
| `UPSTREAM_TIMEOUT_SECONDS` | 90 | How long one try may take to start answering |
| `UPSTREAM_DEADLINE_SECONDS` | 120 | How long all tries together may take |
| `STREAM_IDLE_SECONDS` | 180 | A reply that sends nothing for this long is cut off |
| `MAX_BODY_MB` | 12 | Largest request. Images travel inline |

## What this does not do yet

- **The app still talks to the AI endpoint directly.** It has to be changed
  to call `/auth` and send its pass here; see
  `things-to-do/01-secure-the-plan-api-key.md` in the app's repo.
- **The old key is still in the app's source and git history.** It no longer
  works, but remove it from `plan_config.dart` when the app is switched over.
