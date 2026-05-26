#!/usr/bin/env bash
set -e

# Kill anything already on port 3000
if lsof -ti:3000 > /dev/null 2>&1; then
  echo "Stopping existing server on port 3000..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Auto-detect Codespaces forwarded URL, fall back to localhost
if [ -n "$CODESPACE_NAME" ] && [ -n "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" ]; then
  BASE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  echo "Codespaces detected — using $BASE_URL"
else
  BASE_URL="http://localhost:3000"
  echo "Local environment — using $BASE_URL"
fi

# Update .env with correct URLs
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
  sed -i "s|^OAUTH_CALLBACK_URL=.*|OAUTH_CALLBACK_URL=${BASE_URL}/auth/google/callback|" "$ENV_FILE"
  sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=${BASE_URL}|" "$ENV_FILE"
  sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=${BASE_URL}|" "$ENV_FILE"
  echo ".env updated"
fi

echo ""
echo "  App:    $BASE_URL"
echo "  Health: $BASE_URL/health"
echo ""

# ── Ollama health hint (non-blocking) ─────────────────────────────────────────
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"
if curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
  MODEL_LIST=$(curl -sf "${OLLAMA_HOST}/api/tags" | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' || true)
  BASE_MODEL=$(echo "$OLLAMA_MODEL" | cut -d: -f1)
  if echo "$MODEL_LIST" | grep -q "$BASE_MODEL"; then
    echo "  Ollama: running  model=${OLLAMA_MODEL}"
  else
    echo "  Ollama: running  but ${OLLAMA_MODEL} not pulled — run: ollama pull ${OLLAMA_MODEL}"
  fi
else
  echo "  Ollama: not running — PDF AI parsing will fall back to regex parser"
  echo "          To enable: ollama serve &  ollama pull ${OLLAMA_MODEL}"
fi
echo ""

# Start the server
node src/index.js
