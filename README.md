# TOAS Monitor — Cloudflare Workers (TypeScript)

This replaces the Python Worker in the `cloudfare` branch with a native
**TypeScript Cloudflare Worker**. It checks
<https://toas.fi/en/quickly-available/> and monitors the **next two tables**
after the heading **“Tenancy agreement beginning immediately”**.

## Behavior preserved

- Cloudflare Cron runs every five minutes from **05:00 to 14:55 UTC, Monday–Friday** (Workers cron is UTC).
- The first successful check saves a baseline in Cloudflare KV **without** a Telegram alert.
- Later checks send an alert when the monitored tables change, including a mention of **Mikontalo** if it occurs in any listing row.
- Mikontalo alone does **not** cause repeat alerts when the tables haven't changed.
- If TOAS omits the monitored heading, the observed state is an empty table list, just as before.
- Unrelated page changes do not affect the hash. Whitespace in table cells is normalized.
- On a TOAS, parsing, or Telegram failure, the previous KV state is **not** overwritten; the monitor attempts to send a Telegram error notification and rethrows the error.
- The existing KV namespace ID (`f5ffeef815d54e69a021a2545a859913`), binding (`TOAS_STATE`), and key (`state`) are retained; no KV migration is needed.

The implementation uses the Workers-native `HTMLRewriter` and Web Crypto. No Python runtime or HTML parsing library is required.

## Install and deploy

Use Node.js 22+ and a Cloudflare account with Workers/KV access.

```bash
npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npm run typecheck
npm test
npm run deploy
```

Set the secrets on the same Worker/environment you deploy to. The existing `TOAS_STATE` namespace must be accessible in your Cloudflare account. If deploying to another account, create a KV namespace and replace the ID in `wrangler.jsonc`.

## Local testing

Copy `.dev.vars.example` to `.dev.vars`, fill in credentials, then:

```bash
npm run dev
curl 'http://localhost:8787/cdn-cgi/local/scheduled?format=json'
```

The local Worker uses local KV by default; it does not change the deployed namespace. Be aware that local test runs can send actual Telegram alerts if a baseline has already been established in local KV.

## Migration notes

- Keep your existing Cloudflare KV namespace; the saved value is still JSON shaped like `{"value":"<sha256>"}`.
- State serialization is kept in the same field order used by Python's `json.dumps(..., sort_keys=True)`, so existing fingerprints should generally carry over. Differences between BeautifulSoup and HTMLRewriter's treatment of unusual markup may produce a one-time change alert.
- The compatibility flag `python_workers`, `pyproject.toml`, and `src/entry.py` are intentionally removed.
- No HTTP endpoint is exported in production; this is a cron-only Worker.
