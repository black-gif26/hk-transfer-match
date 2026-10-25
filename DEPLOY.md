# Long-term hosting

This app is a Cloudflare Worker. Temporary trycloudflare / preview links expire.

## Fastest path (claim preview — keeps the same URL)

1. Open the claim URL printed by `npx wrangler deploy --temporary` (valid ~60 minutes).
2. Sign in to Cloudflare and **claim** the temporary account.
3. Keep using: `https://hk-transfer-match.<account>.workers.dev`

Until claimed, the preview can disappear after the claim window.

## Durable path (your own Cloudflare account)

1. Create an API token: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/  
   (Workers Scripts Edit + Account Settings Read is enough.)
2. Add GitHub Actions secrets on this repo:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Push to `main` (or run the **Deploy Cloudflare Worker** workflow).  
   The Worker URL stays on your account permanently.

## Local tunnel (session only)

```bash
npm run dev -- --ip 127.0.0.1 --port 8787
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

Quick tunnels get a new hostname every restart and die when the process stops.
