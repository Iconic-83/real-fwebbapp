#!/bin/bash
# Cloudflare Tunnel — auto-restart wrapper
# PM2 manages this script, which manages cloudflared

CLOUDFLARED="$HOME/bin/cloudflared"
URL_FILE="/home/ayuub/Documents/dev/precisiontrader-pro/data/current-url.txt"

echo "[TUNNEL] Starting Cloudflare tunnel..."

while true; do
  # Start cloudflared and capture output
  $CLOUDFLARED tunnel --url http://localhost:3001 2>&1 | while IFS= read -r line; do
    echo "$line"
    # Extract URL and save it
    if echo "$line" | grep -q "trycloudflare.com\|lhr.life"; then
      URL=$(echo "$line" | grep -oP 'https://[^\s]+')
      if [ -n "$URL" ]; then
        echo "$URL" > "$URL_FILE"
        echo "[TUNNEL] ✅ Public URL: $URL"
        echo "[TUNNEL] Open this link on any device!"
      fi
    fi
  done

  echo "[TUNNEL] Tunnel disconnected. Restarting in 5 seconds..."
  sleep 5
done
