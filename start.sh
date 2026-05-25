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

# Start the server
node src/index.js
