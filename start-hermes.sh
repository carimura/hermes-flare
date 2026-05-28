#!/bin/bash
# Entrypoint for Hermes Agent inside Cloudflare Sandbox.
#
# Responsibilities (in order):
#   1. Seed ~/.hermes/.env from runtime env vars.
#   2. Write config.yaml from runtime env vars (overwriting it — we treat
#      env vars as the source of truth for channel + gateway config).
#   3. Start `hermes gateway run`.
#
# Persistence is handled OUTSIDE this script — the Worker calls createBackup()
# / restoreBackup() on /home/hermes via the Sandbox SDK. We don't sync to R2
# from inside the container.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/home/hermes/.hermes}"
ENV_FILE="$HERMES_HOME/.env"
CONFIG_FILE="$HERMES_HOME/config.yaml"
GATEWAY_PORT="${HERMES_GATEWAY_PORT:-8642}"

echo "[start-hermes] HERMES_HOME=$HERMES_HOME"
echo "[start-hermes] gateway port=$GATEWAY_PORT"
mkdir -p "$HERMES_HOME"

# ---------------------------------------------------------------------------
# 1. Always re-seed .env from runtime env vars. Worker secrets are the
#    source of truth — if the user rotates a key, restart picks it up.
#    Hermes' Slack adapter reads its config from .env (Socket Mode).
# ---------------------------------------------------------------------------
: > "$ENV_FILE"
[ -n "${ANTHROPIC_API_KEY:-}" ]   && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"     >> "$ENV_FILE"
[ -n "${OPENAI_API_KEY:-}" ]      && echo "OPENAI_API_KEY=$OPENAI_API_KEY"           >> "$ENV_FILE"
[ -n "${SLACK_BOT_TOKEN:-}" ]     && echo "SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN"         >> "$ENV_FILE"
[ -n "${SLACK_APP_TOKEN:-}" ]     && echo "SLACK_APP_TOKEN=$SLACK_APP_TOKEN"         >> "$ENV_FILE"
[ -n "${SLACK_ALLOWED_USERS:-}" ] && echo "SLACK_ALLOWED_USERS=$SLACK_ALLOWED_USERS" >> "$ENV_FILE"
[ -n "${SLACK_HOME_CHANNEL:-}" ]  && echo "SLACK_HOME_CHANNEL=$SLACK_HOME_CHANNEL"   >> "$ENV_FILE"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ]  && echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"   >> "$ENV_FILE"
[ -n "${DISCORD_BOT_TOKEN:-}" ]   && echo "DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN"     >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "[start-hermes] wrote $ENV_FILE"

# ---------------------------------------------------------------------------
# 2. Generate config.yaml from runtime env vars. YAML is just text — we don't
#    need a parser. Indentation matters; keep this tight.
# ---------------------------------------------------------------------------
{
  echo "gateway:"
  echo "  port: $GATEWAY_PORT"
  echo "  bind: lan"
  echo "  controlUi:"
  echo "    allowedOrigins: ['*']"
  if [ -n "${HERMES_GATEWAY_TOKEN:-}" ]; then
    echo "  auth:"
    echo "    token: \"$HERMES_GATEWAY_TOKEN\""
  fi
  # ---- Platform-specific config (channels themselves are configured via .env) ----
  # SLACK_REPLY_IN_THREAD is a wrangler var (see wrangler.jsonc / .env).
  # Set "false" to have Hermes post at the channel top level instead of threading.
  if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
    echo "platforms:"
    echo "  slack:"
    echo "    extra:"
    echo "      reply_in_thread: ${SLACK_REPLY_IN_THREAD:-true}"
  fi
  # ---- Terminal backend: route shell commands to ExecSandbox ----
  # The cloudflare_sandbox backend (tools/environments/cloudflare_sandbox.py)
  # is injected into the Hermes install by the Dockerfile. It POSTs each
  # command back to /api/sandbox/exec on the Worker, which forwards into
  # the ExecSandbox container.
  echo "terminal:"
  echo "  backend: cloudflare_sandbox"
  echo "  cwd: /workspace"
  echo "  timeout: 180"
  # ---- Platform toolsets: expose `terminal` (and friends) on Slack ----
  # Without this, the Slack platform gets a stripped-down default toolset
  # (no terminal/file/code_execution) — Hermes will say "terminal toolset
  # isn't enabled in this session." Mirror what's available on `cli`.
  echo "platform_toolsets:"
  echo "  slack:"
  for t in terminal code_execution file web browser memory skills todo messaging cronjob vision image_gen tts session_search clarify delegation kanban; do
    echo "  - $t"
  done
  echo "channels:"
  # Slack tokens live in .env (Socket Mode), not config.yaml.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "  telegram:"
    echo "    enabled: true"
    echo "    botToken: \"$TELEGRAM_BOT_TOKEN\""
    echo "    dmPolicy: ${TELEGRAM_DM_POLICY:-pairing}"
  fi
  if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
    echo "  discord:"
    echo "    enabled: true"
    echo "    token: \"$DISCORD_BOT_TOKEN\""
    echo "    dm:"
    echo "      policy: ${DISCORD_DM_POLICY:-pairing}"
  fi
} > "$CONFIG_FILE"
echo "[start-hermes] wrote $CONFIG_FILE"

# Snapshot-friendly perms for newly-written files.
chmod -R a+rX "$HERMES_HOME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Start the gateway
# ---------------------------------------------------------------------------
echo "[start-hermes] resolving hermes CLI..."
which hermes || { echo "[start-hermes] hermes not on PATH"; exit 1; }
hermes --version || true

# Port comes from config.yaml (gateway.port). No --port flag on `gateway run`.
echo "[start-hermes] Starting hermes gateway (port from config.yaml)"
exec hermes gateway run
