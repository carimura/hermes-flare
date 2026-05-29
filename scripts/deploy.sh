#!/usr/bin/env bash
# Deploy the Worker, applying per-user config from .env via `wrangler --var`.
# Universal defaults live in wrangler.jsonc; .env (gitignored) overrides them
# with personal IDs and any per-environment tweaks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=runtime-env.sh
source "$ROOT/scripts/runtime-env.sh"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ARGS=()
for VAR in "${DEPLOY_VARS[@]}"; do
  VAL="${!VAR-}"
  if [ -n "${VAL}" ]; then
    ARGS+=(--var "${VAR}:${VAL}")
  fi
done

# `${ARGS[@]+"${ARGS[@]}"}` survives an empty array under `set -u` (macOS
# default bash 3.2 treats `${ARGS[@]}` on an empty array as unbound).
exec npx wrangler deploy ${ARGS[@]+"${ARGS[@]}"} "$@"
