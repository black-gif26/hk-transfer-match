#!/usr/bin/env bash
set -euo pipefail
URL_FILE=/tmp/hk-transfer-public-url.txt
DEV_URL=http://127.0.0.1:8787
CLOUDFLARED=${CLOUDFLARED:-/tmp/cloudflared}
PUBLIC_URL=${PUBLIC_URL:-https://adapters-alex-shortly-bearing.trycloudflare.com}

echo "$PUBLIC_URL" > "$URL_FILE"
echo "Watching $PUBLIC_URL (will not restart tunnel unless process dies)"

while true; do
  # Keep local worker up
  if ! curl -fsS "$DEV_URL/api/health" >/dev/null 2>&1; then
    echo "$(date -Is) local worker down — restart wrangler"
    tmux -f /exec-daemon/tmux.portal.conf has-session -t "=hk-transfer-dev" 2>/dev/null || \
      tmux -f /exec-daemon/tmux.portal.conf new-session -d -s hk-transfer-dev -c /agent/hk-transfer-match -- "${SHELL:-bash}" -l
    tmux -f /exec-daemon/tmux.portal.conf send-keys -t "hk-transfer-dev:0.0" C-c
    sleep 1
    tmux -f /exec-daemon/tmux.portal.conf send-keys -t "hk-transfer-dev:0.0" 'cd /agent/hk-transfer-match && npm run dev -- --ip 127.0.0.1 --port 8787' C-m
    sleep 5
  fi

  # Heartbeat existing tunnel (do not recreate while process alive)
  if pgrep -f 'cloudflared tunnel --url' >/dev/null 2>&1; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/api/health" || echo 000)
    echo "$(date -Is) tunnel heartbeat $code $PUBLIC_URL"
  else
    echo "$(date -Is) cloudflared missing — restarting quick tunnel (URL will change)"
    tmux -f /exec-daemon/tmux.portal.conf kill-session -t "hk-transfer-tunnel" 2>/dev/null || true
    tmux -f /exec-daemon/tmux.portal.conf new-session -d -s hk-transfer-tunnel -c /agent/hk-transfer-match -- "${SHELL:-bash}" -l
    tmux -f /exec-daemon/tmux.portal.conf send-keys -t "hk-transfer-tunnel:0.0" "$CLOUDFLARED tunnel --url $DEV_URL --no-autoupdate" C-m
    sleep 8
    NEW=$(tmux -f /exec-daemon/tmux.portal.conf capture-pane -t "hk-transfer-tunnel:0.0" -p -S -200 | tr -d '\n' | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | head -1 || true)
    if [[ -n "${NEW:-}" ]]; then
      PUBLIC_URL="$NEW"
      echo "$PUBLIC_URL" > "$URL_FILE"
      echo "$(date -Is) new tunnel URL: $PUBLIC_URL"
    fi
  fi
  sleep 120
done
