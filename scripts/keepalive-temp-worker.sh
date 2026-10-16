#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
INTERVAL_SEC="${INTERVAL_SEC:-1500}" # 25 minutes — refresh before ~60m claim window
LOG="${LOG:-/tmp/hk-temp-worker-keepalive.log}"
ENV_FILE="${ENV_FILE:-/tmp/hk-cf-env}"
echo "Temp worker keepalive: redeploy every ${INTERVAL_SEC}s" | tee -a "$LOG"
while true; do
  ts="$(date -Is)"
  echo "$ts redeploy start" | tee -a "$LOG"
  # Prefer account-token deploy (same Slow Maple URL). Fall back to --temporary
  # only when unauthenticated — wrangler rejects --temporary if a token is set.
  ok=0
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
    if npx wrangler deploy 2>&1 | tee -a "$LOG" | tee /tmp/wrangler-temp-deploy.log | tail -30; then
      ok=1
    fi
    unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID || true
  fi
  if [[ "$ok" -ne 1 ]]; then
    unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID || true
    if npx wrangler deploy --temporary 2>&1 | tee -a "$LOG" | tee /tmp/wrangler-temp-deploy.log | tail -30; then
      ok=1
    fi
  fi
  if [[ "$ok" -eq 1 ]]; then
    url="$(grep -Eo 'https://hk-transfer-match\.[a-z0-9-]+\.workers\.dev' /tmp/wrangler-temp-deploy.log | tail -1 || true)"
    claim="$(grep -Eo 'https://dash\.cloudflare\.com/claim-preview\?claimToken=[A-Za-z0-9_-]+' /tmp/wrangler-temp-deploy.log | tail -1 || true)"
    echo "$ts url=$url" | tee -a "$LOG"
    echo "$ts claim=$claim" | tee -a "$LOG"
    [[ -n "$url" ]] && printf '%s\n' "$url" > /tmp/hk-slow-maple-url.txt
    [[ -n "$claim" ]] && printf '%s\n' "$claim" > /tmp/hk-slow-maple-claim.txt
    if [[ -n "$url" ]]; then
      curl -fsS "${url%/}/api/health" | tee -a "$LOG" || true
      echo | tee -a "$LOG"
    fi
  else
    echo "$ts redeploy failed" | tee -a "$LOG"
  fi
  sleep "$INTERVAL_SEC"
done
