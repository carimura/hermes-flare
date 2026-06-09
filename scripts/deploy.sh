#!/usr/bin/env bash
# Deploy the Worker, applying per-user config from .env via `wrangler --var`.
# Universal defaults live in wrangler.jsonc; .env (gitignored) overrides them
# with personal IDs and any per-environment tweaks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Vars we forward from .env. Each unset/empty var is silently skipped — the
# wrangler.jsonc default (if any) wins.
VARS=(
  SLACK_ALLOWED_USERS
  SLACK_HOME_CHANNEL
  SLACK_REPLY_IN_THREAD
  SANDBOX_SLEEP_AFTER
  SNAPSHOT_INTERVAL_MINUTES
  BACKUP_RETENTION_DAYS
  WORKER_PUBLIC_URL
)

ARGS=()
for VAR in "${VARS[@]}"; do
  VAL="${!VAR-}"
  if [ -n "${VAL}" ]; then
    ARGS+=(--var "${VAR}:${VAL}")
  fi
done

# `${ARGS[@]+"${ARGS[@]}"}` survives an empty array under `set -u` (macOS
# default bash 3.2 treats `${ARGS[@]}` on an empty array as unbound).
exec npx wrangler deploy ${ARGS[@]+"${ARGS[@]}"} "$@"
