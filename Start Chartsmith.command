#!/bin/bash
# Double-click on a Mac. First time: right-click → Open (macOS asks once because it came from the internet).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""; echo "  Node.js is not installed. Opening nodejs.org — install the LTS version, then double-click this file again."; echo ""
  open https://nodejs.org; read -n 1 -s -r -p "Press any key to close."; exit 1
fi
node launch.cjs
