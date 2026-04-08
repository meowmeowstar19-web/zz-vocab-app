#!/bin/bash
# Double-click this file to sync data & push to Vercel.
# It reads Vocab_Confirmed.xlsx + Daily_Expressions.xlsx + updated_image/,
# regenerates src/data/*.js, compresses images to public/images/,
# then git commits and pushes (Vercel auto-deploys in ~30s).

cd "$(dirname "$0")" || exit 1

echo ""
echo "================================================"
echo "  🔄 VocabWorkspace Data Sync"
echo "================================================"
echo ""

# Verify Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js not found. Please install from https://nodejs.org"
    echo ""
    echo "Press any key to close this window..."
    read -rn 1
    exit 1
fi

node scripts/sync-data.mjs --auto
EXIT=$?

echo ""
echo "================================================"
if [ $EXIT -eq 0 ]; then
    echo "  ✅ All done! Vercel will redeploy in ~30s."
else
    echo "  ❌ Sync failed (exit code $EXIT)"
    echo "  Scroll up to see what went wrong."
fi
echo "================================================"
echo ""
echo "Press any key to close this window..."
read -rn 1
exit $EXIT
