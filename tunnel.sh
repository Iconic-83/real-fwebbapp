#!/bin/bash
CLOUDFLARED="$HOME/bin/cloudflared"
URL_FILE="/home/ayoup/Documents/mvp/lol/iconicfx/real-fwebbapp/data/current-url.txt"

echo "[TUNNEL] Starting Cloudflare tunnel..."
while true; do
  $CLOUDFLARED tunnel --url http://localhost:3001 2>&1 | while IFS= read -r line; do
    echo "$line"
    if echo "$line" | grep -qE "https://[a-z0-9-]+\.trycloudflare\.com"; then
      URL=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
      if [ -n "$URL" ]; then
        echo "$URL" > "$URL_FILE"
        echo "[TUNNEL] ✅ Your permanent session URL: $URL"
      fi
    fi
  done
  echo "[TUNNEL] Reconnecting in 5 seconds..."
  sleep 5
done
