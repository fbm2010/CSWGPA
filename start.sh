#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Kill anything already on port 3000
if lsof -ti:3000 > /dev/null 2>&1; then
  echo "Stopping existing server on port 3000..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Install dependencies if missing
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Create .env from the template on first run
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

# Run DB migrations if the database doesn't exist yet
DB_PATH="${DB_PATH:-./atlas_gpa.db}"
if [ ! -f "$DB_PATH" ]; then
  echo "Running database migrations..."
  node src/db/migrate.js
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

# PDF import relies on the local Unstructured (Python) parser, with a regex
# fallback baked into the app — check it here so failures are diagnosable at
# startup instead of surfacing as a silent regex-only fallback per upload.
PYTHON_BIN="${UNSTRUCTURED_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" > /dev/null 2>&1; then
  echo "Warning: Python executable '$PYTHON_BIN' not found — PDF import will fall back to the regex-only parser."
elif ! "$PYTHON_BIN" -c "import unstructured, pdfminer" > /dev/null 2>&1; then
  echo "Warning: 'unstructured'/'pdfminer' not importable by $PYTHON_BIN — PDF import will fall back to the regex-only parser."
  echo "         Install with: $PYTHON_BIN -m pip install unstructured pdfminer.six"
fi

# Ollama is optional — only used if the user explicitly opts into AI parsing.
if command -v ollama > /dev/null 2>&1 || curl -s -o /dev/null -m 1 "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags" 2>/dev/null; then
  echo "Ollama detected (optional AI parsing available)"
fi

echo ""
echo "  App:    $BASE_URL"
echo "  Health: $BASE_URL/health"
echo ""

# Start the server
node src/index.js
