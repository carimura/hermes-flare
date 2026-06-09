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

# Vars we forward from .env as PLAINTEXT Worker vars. Keep this an explicit
# allowlist, NOT a blanket "forward everything in .env": .env may also hold
# secrets (HERMES_GATEWAY_TOKEN, R2_ACCESS_KEY_ID, ...) that must stay as
# `wrangler secret put` (encrypted) and never leak in as plaintext --var.
# Each unset/empty var is silently skipped — the wrangler.jsonc default wins.
VARS=(
  AGENT_NAME
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

# AGENT_NAME is the single per-agent knob: it names the Worker (so cloning =
# set AGENT_NAME, deploy) and namespaces this agent's R2 keys (so all agents
# share one bucket). Unset → wrangler.jsonc's default name/AGENT_NAME apply.
if [ -n "${AGENT_NAME:-}" ]; then
  ARGS+=(--name "${AGENT_NAME}")
fi

# `${ARGS[@]+"${ARGS[@]}"}` survives an empty array under `set -u` (macOS
# default bash 3.2 treats `${ARGS[@]}` on an empty array as unbound).
exec npx wrangler deploy ${ARGS[@]+"${ARGS[@]}"} "$@"
