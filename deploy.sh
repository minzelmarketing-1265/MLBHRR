#!/usr/bin/env bash
# Auto-deploy hook: commit & push site changes to GitHub Pages.
cd /c/Users/Caden/MLBHRR || exit 0
git add -A
if git diff --cached --quiet; then
  exit 0   # nothing changed, nothing to deploy
fi
git commit -m "Auto-deploy site update" >/dev/null 2>&1
git push origin main >/dev/null 2>&1
exit 0
