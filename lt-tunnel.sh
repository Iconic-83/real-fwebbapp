#!/bin/bash
# PTP Permanent Tunnel — https://ptp-ayuub-fx.loca.lt
# This subdomain is FIXED — never changes on restart
URL_FILE="/home/ayuub/Documents/dev/precisiontrader-pro/data/current-url.txt"
SUBDOMAIN="ptp-ayuub-fx"

while true; do
  echo "[LT] Starting tunnel → https://${SUBDOMAIN}.loca.lt"
  echo "https://${SUBDOMAIN}.loca.lt" > "$URL_FILE"
  lt --port 3001 --subdomain "$SUBDOMAIN" 2>&1
  echo "[LT] Reconnecting in 3 seconds..."
  sleep 3
done
