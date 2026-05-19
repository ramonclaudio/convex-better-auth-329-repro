#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:?usage: run.sh <pristine|329|ref-fix>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/node_modules/@convex-dev/better-auth/dist/react/index.js"
SOURCE="$ROOT/patches/${VARIANT}.js"

if [ "$VARIANT" = "329" ]; then SOURCE="$ROOT/patches/329-rays-fix.js"; fi

if [ ! -f "$SOURCE" ]; then
	echo "no such variant: $SOURCE"
	exit 2
fi

echo "swapping in $(basename "$SOURCE") → node_modules/@convex-dev/better-auth/dist/react/index.js"
cp -f "$SOURCE" "$TARGET"

cd "$ROOT"
exec npx vitest run
