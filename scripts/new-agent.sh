#!/usr/bin/env bash
# Create + launch a new Hermes agent, start to finish. No files to hand-edit.
#
# Run this in a FRESH clone of the repo (one clone == one agent):
#   git clone https://github.com/carimura/hermes-flare my-agent
#   cd my-agent && npm install && npm run new-agent
#
# It gathers config, shows you the Slack app manifest (so you can create the
# app and copy its tokens), then writes .env, pushes secrets, and deploys.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---- tiny prompt/print helpers ------------------------------------------------
say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }                 # cyan heading
note() { printf '\033[2m%s\033[0m\n' "$*"; }                      # dim
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

ask() { # ask VAR "prompt" ["default"]
  local __var="$1" __prompt="$2" __def="${3:-}" __in=""
  if [ -n "$__def" ]; then
    read -r -p "$__prompt [$__def]: " __in || true
    __in="${__in:-$__def}"
  else
    read -r -p "$__prompt: " __in || true
  fi
  printf -v "$__var" '%s' "$__in"
}

ask_secret() { # ask_secret VAR "prompt" — input not echoed
  local __var="$1" __prompt="$2" __in=""
  read -r -s -p "$__prompt: " __in || true
  echo
  printf -v "$__var" '%s' "$__in"
}

# ---- preflight ----------------------------------------------------------------
command -v npx >/dev/null     || die "npx (Node.js) not found."
command -v openssl >/dev/null || die "openssl not found (needed to mint the gateway token)."
[ -f slack-manifest.json ]    || die "run me from the repo root (slack-manifest.json is missing)."
command -v docker >/dev/null  || note "Heads up: 'docker' not found — wrangler needs it to build the container image."

say "Hermes — new agent setup"
if ! npx wrangler whoami >/dev/null 2>&1; then
  die "wrangler isn't authenticated. Run:  npx wrangler login   then re-run me."
fi

if [ -f .env ]; then
  ask _OVERWRITE "An .env already exists here and will be overwritten. Continue? (y/N)" "N"
  case "$_OVERWRITE" in y|Y|yes) ;; *) die "aborted (run this in a fresh clone)."; esac
fi

# ---- 1. gather config ---------------------------------------------------------
say "1) Identity"
ask AGENT_NAME "Agent name — lowercase, becomes the Worker name (e.g. athena-flare)"
[ -n "$AGENT_NAME" ] || die "agent name is required."
case "$AGENT_NAME" in *[!a-z0-9-]*) die "use lowercase letters, digits and hyphens only.";; esac

DEFAULT_DISPLAY="$(printf '%s' "${AGENT_NAME%%-*}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
ask SLACK_DISPLAY_NAME "Slack app display name" "$DEFAULT_DISPLAY"

say "2) Cloudflare"
ask WORKERS_SUBDOMAIN "Your workers.dev subdomain — the X in https://<worker>.X.workers.dev"
[ -n "$WORKERS_SUBDOMAIN" ] || die "subdomain is required."
WORKER_PUBLIC_URL="https://${AGENT_NAME}.${WORKERS_SUBDOMAIN}.workers.dev"

say "3) Anthropic"
ask_secret ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...)"
[ -n "$ANTHROPIC_API_KEY" ] || die "Anthropic API key is required."

say "4) Slack access control"
ask SLACK_ALLOWED_USERS "Slack member ID(s) allowed to talk to the bot — comma-separated (U0...)"
ask SLACK_HOME_CHANNEL  "Slack home channel ID for scheduled output (optional, blank to skip)" ""

# ---- 2. Slack manifest (shown BEFORE we ask for tokens) -----------------------
MANIFEST_FILE="${TMPDIR:-/tmp}/${AGENT_NAME}-slack-manifest.json"
sed "s|Hermes|${SLACK_DISPLAY_NAME}|g" slack-manifest.json > "$MANIFEST_FILE"

say "5) Create the Slack app from the manifest"
cat <<EOF
  1. Open  https://api.slack.com/apps  ->  Create New App  ->  From an app manifest
  2. Pick your workspace, paste the manifest, and create the app.
EOF
if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "$MANIFEST_FILE"
  note "  (manifest copied to your clipboard — just paste)"
fi
note "  Manifest also saved to: $MANIFEST_FILE"
cat <<EOF

  Then, in the new app:
    * Basic Information -> App-Level Tokens -> Generate Token and Scopes
          add scope  connections:write  ->  copy the xapp-... token
    * OAuth & Permissions -> Install to Workspace  ->  copy the Bot xoxb-... token
EOF

say "6) Paste the Slack tokens"
ask_secret SLACK_APP_TOKEN "Slack APP-level token (xapp-...)"
ask_secret SLACK_BOT_TOKEN "Slack BOT token (xoxb-...)"
[ -n "$SLACK_APP_TOKEN" ] && [ -n "$SLACK_BOT_TOKEN" ] || die "both Slack tokens are required."

# ---- 3. write .env (non-secret config only) -----------------------------------
say "7) Writing .env"
{
  echo "AGENT_NAME=${AGENT_NAME}"
  echo "WORKERS_SUBDOMAIN=${WORKERS_SUBDOMAIN}"
  echo "SLACK_ALLOWED_USERS=${SLACK_ALLOWED_USERS}"
  [ -n "$SLACK_HOME_CHANNEL" ] && echo "SLACK_HOME_CHANNEL=${SLACK_HOME_CHANNEL}"
} > .env
note "  wrote .env (secrets are pushed separately, never stored here)"

# ---- 4. ensure the shared snapshot bucket exists ------------------------------
say "8) Ensuring R2 snapshot bucket (shared: hermes-flare-data)"
npx wrangler r2 bucket create hermes-flare-data >/dev/null 2>&1 || true
note "  ok"

# ---- 5. first deploy: creates the Worker (container starts on first request) ---
say "9) Deploying Worker '${AGENT_NAME}' — first build takes ~90s"
npm run deploy

# ---- 6. push secrets (gateway token is auto-generated) ------------------------
say "10) Pushing secrets"
HERMES_GATEWAY_TOKEN="$(openssl rand -hex 32)"
put_secret() { printf '%s' "$2" | npx wrangler secret put "$1" --name "$AGENT_NAME" >/dev/null && note "  set $1"; }
put_secret ANTHROPIC_API_KEY    "$ANTHROPIC_API_KEY"
put_secret HERMES_GATEWAY_TOKEN "$HERMES_GATEWAY_TOKEN"
put_secret SLACK_BOT_TOKEN      "$SLACK_BOT_TOKEN"
put_secret SLACK_APP_TOKEN      "$SLACK_APP_TOKEN"

# ---- 7. bootstrap the container -----------------------------------------------
say "11) Bootstrapping the container (may take 1-2 min on cold start)"
curl -s --max-time 180 "${WORKER_PUBLIC_URL}/api/status?token=${HERMES_GATEWAY_TOKEN}" || true
echo

# ---- done ---------------------------------------------------------------------
say "Done — ${AGENT_NAME} is live."
cat <<EOF
  Worker URL : ${WORKER_PUBLIC_URL}

  Save this gateway token — it gates /api/* and CANNOT be read back from Cloudflare:
      HERMES_GATEWAY_TOKEN=${HERMES_GATEWAY_TOKEN}

  Next: DM your Slack bot. The first message wakes the container (1-2 min).
  Re-deploy this agent anytime with:  npm run deploy
EOF
