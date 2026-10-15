#!/usr/bin/env bash
set -euo pipefail

BASE=/home/deploy/storyverse/web
IN=/home/deploy/storyverse/_incoming
URL="${STORYVERSE_URL:-https://storyverse.2.29.42.104.sslip.io}"

# 1. guarda a versão atual (rollback) e promove a nova
rm -rf "$BASE/previous"
if [ -d "$BASE/current" ]; then mv "$BASE/current" "$BASE/previous"; fi
mv "$IN" "$BASE/current"

# 2. confere que o site responde
code=$(curl -fsS -o /dev/null -w '%{http_code}' \
  --retry 5 --retry-delay 2 --retry-connrefused \
  "$URL" || echo 000)
if [ "$code" != "200" ]; then
  echo "FALHOU: $URL respondeu $code. Revertendo."
  rm -rf "$BASE/current"
  if [ -d "$BASE/previous" ]; then mv "$BASE/previous" "$BASE/current"; fi
  exit 1
fi
echo "OK: $URL respondeu 200"
