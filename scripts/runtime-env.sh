#!/usr/bin/env bash
# Shared env-var lists for deployment and the Hermes container startup script.

# Non-secret vars accepted from .env and forwarded to `wrangler deploy --var`.
DEPLOY_VARS=(
  SLACK_ALLOWED_USERS
  SLACK_HOME_CHANNEL
  SLACK_REPLY_IN_THREAD
  WORKER_PUBLIC_URL
)

# Runtime vars written into ~/.hermes/.env for Hermes platform/provider config.
HERMES_ENV_FILE_VARS=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SLACK_ALLOWED_USERS
  SLACK_HOME_CHANNEL
  TELEGRAM_BOT_TOKEN
  DISCORD_BOT_TOKEN
)
