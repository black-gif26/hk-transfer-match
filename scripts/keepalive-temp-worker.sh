#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
INTERVAL_SEC="${INTERVAL_SEC:-2700}" # 45 minutes
LOG="${LOG:-/tmp/hk-temp-worker-keepalive.log}"
echo "Temp worker keepalive: redeploy every ${INTERVAL_SEC}s" | tee -a "$LOG"
while true; do
  ts="$(date -Is)"
  echo "$ts redeploy start" | tee -a "$LOG"
  if npx wrangler deploy --temporary 2>&1 | tee -a "$LOG" | tee /tmp/wrangler-temp-deploy.log | tail -20; then
    url="$(grep -Eo 'https://hk-transfer-match\.[a-z0-9-]+\.workers\.dev' /tmp/wrangler-temp-deploy.log | tail -1 || true)"
    claim="$(grep -Eo 'https://dash\.cloudflare\.com/claim-preview\?claimToken=[A-Za-z0-9_-]+' /tmp/wrangler-temp-deploy.log | tail -1 || true)"
    echo "$ts url=$url" | tee -a "$LOG"
    echo "$ts claim=$claim" | tee -a "$LOG"
    printf '%s\n' "$url" > /tmp/hk-slow-maple-url.txt
    printf '%s\n' "$claim" > /tmp/hk-slow-maple-claim.txt
    curl -fsS "${url%/}/api/health" | tee -a "$LOG" || true
    echo | tee -a "$LOG"
  else
    echo "$ts redeploy failed" | tee -a "$LOG"
  fi
  sleep "$INTERVAL_SEC"
done
