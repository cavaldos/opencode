#!/usr/bin/env bash
# ============================================================
# OpenCode Config — Auto Install Script
# Usage: ./install.sh
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> OpenCode Config installer"

# --- 1. Check prerequisites ---
command -v opencode >/dev/null 2>&1 || { echo "❌ 'opencode' not found. Install it first:"; echo "   curl -fsSL https://opencode.ai/install | bash"; exit 1; }
command -v node >/dev/null 2>&1    || { echo "❌ Node.js (>= 18) not found. Install it first."; exit 1; }
echo "✅ opencode: $(opencode --version 2>/dev/null | head -1)"
echo "✅ node: $(node --version)"

# --- 2. Create opencode.json from template ---
if [ -f "$DIR/opencode.json" ]; then
  echo "⚠️  opencode.json already exists → keeping it (no overwrite)."
else
  cp "$DIR/opencode.example.json" "$DIR/opencode.json"
  # Replace YOUR_USER placeholder with the real username
  if grep -q "YOUR_USER" "$DIR/opencode.json"; then
    sed -i '' "s|YOUR_USER|$(whoami)|g" "$DIR/opencode.json" 2>/dev/null \
      || sed -i "s|YOUR_USER|$(whoami)|g" "$DIR/opencode.json"
  fi
  echo "✅ Created opencode.json from template"
fi

# --- 3. Create .env if missing ---
if [ -f "$DIR/.env" ]; then
  echo "⚠️  .env already exists → keeping it."
else
  cp "$DIR/.env.example" "$DIR/.env"
  echo "✅ Created .env from template"
fi

# --- 4. Install plugin dependencies ---
if command -v bun >/dev/null 2>&1 && [ -f "$DIR/bun.lock" ]; then
  (cd "$DIR" && bun install) && echo "✅ Plugin deps installed (bun)"
elif [ -f "$DIR/package-lock.json" ]; then
  (cd "$DIR" && npm ci --silent 2>/dev/null || npm install --silent) && echo "✅ Plugin deps installed (npm)"
else
  (cd "$DIR" && npm install --silent) && echo "✅ Plugin deps installed (npm)"
fi

# --- 5. Done ---
echo ""
echo "🎉 Done! What's left for you:"
echo "   1. Open $DIR/.env and fill in your real tokens/keys (provider API key at minimum)."
echo "   2. Update the provider baseURL in $DIR/opencode.json if needed."
echo "   3. Run 'opencode' to verify."
