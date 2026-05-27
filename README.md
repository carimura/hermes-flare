# Hermes-Cloudflare

Run [Nous Research's Hermes Agent](https://hermes-agent.nousresearch.com/) inside a Cloudflare Sandbox container with state persisted to R2 via the Sandbox SDK's FUSE-mount API.

Motivated by [`cloudflare/moltworker`](https://github.com/cloudflare/moltworker).

## Architecture

User Path:
```
  User ──▶ Slack ──(WebSocket)──▶ Hermes Agent (Running in container)
```

Operator Path:
```
  Operator ──▶ Worker /api/* ──▶ Sandbox Durable Object ──▶ Container
                                                             ├─ Hermes Agent
                                                             └─ /opt/data ⇄ R2 (mounted via FUSE)
```

## Requirements

- **Cloudflare Workers**
- **Anthropic API key** (Hermes uses Claude by default; other providers also supported).
- **Slack workspace** (or Discord, etc.)



## Quick start

```sh
git clone https://github.com/carimura/hermes-cloudflare
cd hermes-cloudflare
npm install

# 1. Personal IDs go in .env (gitignored).
cp .env.example .env
# edit .env: add your SLACK_ALLOWED_USERS (Slack member ID, U01ABC2DEF3)

# 2. Push secrets.
npx wrangler secret put ANTHROPIC_API_KEY     # sk-ant-...
npx wrangler secret put HERMES_GATEWAY_TOKEN  # `openssl rand -hex 32`
npx wrangler secret put SLACK_BOT_TOKEN       # xoxb-... (see "Slack setup")
npx wrangler secret put SLACK_APP_TOKEN       # xapp-... (see "Slack setup")

# 3. Create the R2 bucket — mounted into the container as Hermes' state dir.
npx wrangler r2 bucket create hermes-cloudflare-data

# 4. Deploy.
npm run deploy
```

First deploy builds the container image (~90s). The container won't actually start until the first request hits the Worker. Bootstrap it:

```sh
curl "https://hermes-cloudflare.<your-subdomain>.workers.dev/api/status?token=$HERMES_GATEWAY_TOKEN"
# → {"container":"running","gateway_running":true,"pid":"proc_..."}
```

First hit takes 1-2 minutes (cold container + Hermes gateway boot). After that, the cron trigger (every 5 min) keeps the gateway alive.

## Slack setup

1. Generate the app manifest. Easiest: deploy first, then `curl /api/slack-manifest?token=...` to get one tailored to Hermes' current capabilities. The file `slack-manifest.json` checked into this repo is a reference snapshot.
2. https://api.slack.com/apps → **Create New App** → **From an app manifest** → paste the JSON → Create.
3. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → add `connections:write` → copy `xapp-...` → this is `SLACK_APP_TOKEN`.
4. **OAuth & Permissions** → **Install to Workspace** → copy Bot User OAuth Token (`xoxb-...`) → this is `SLACK_BOT_TOKEN`.
5. **App Home** → **Show Tabs** → enable **Messages Tab** + "Allow users to send Slash commands and messages from the messages tab" (required for DMs).
6. In Slack, click your avatar → View full profile → ⋮ → **Copy member ID**. Put it in `.env` as `SLACK_ALLOWED_USERS`.
7. Push the secrets and `npm run deploy`.

DM the bot in Slack — first message wakes the container (1-2 min), subsequent ones are fast.

## Configuration

### Secrets (`wrangler secret put`)

| Secret | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Forwarded into the container; Hermes uses for inference |
| `HERMES_GATEWAY_TOKEN` | yes | Gates all `/api/*` routes. Pick any random value. |
| `SLACK_BOT_TOKEN` | yes (Slack) | `xoxb-...` |
| `SLACK_APP_TOKEN` | yes (Slack) | `xapp-...` with `connections:write` scope |
| `TELEGRAM_BOT_TOKEN` | optional | Reserved for future Telegram support |
| `DISCORD_BOT_TOKEN` | optional | Reserved for future Discord support |

### Non-secret vars

Defaults live in `wrangler.jsonc`; personal IDs and per-environment tweaks go in `.env` (gitignored). `npm run deploy` reads `.env` and applies values via `wrangler deploy --var`.

| Var | Default | Where | Purpose |
|---|---|---|---|
| `SLACK_ALLOWED_USERS` | — | `.env` | Comma-separated Slack member IDs allowed to talk to the bot |
| `SLACK_HOME_CHANNEL` | — | `.env` | Slack channel ID for scheduled/cron output |
| `SLACK_REPLY_IN_THREAD` | `true` | wrangler.jsonc | `false` → post to channel top level instead of threading |
| `SANDBOX_SLEEP_AFTER` | `never` | wrangler.jsonc | `"10m"`/`"1h"` etc. to hibernate when idle |

## Endpoints

All `/api/*` routes require `?token=$HERMES_GATEWAY_TOKEN`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/health` | Worker liveness; doesn't wake the container; no token required |
| GET | `/api/status` | Wakes the container, ensures the Hermes gateway is running |
| GET | `/api/logs` | Processes, listening ports, current config.yaml, recent Hermes logs |
| GET | `/api/slack-manifest` | Generated Slack app manifest from `hermes slack manifest` |
| POST | `/api/kill` | Kill the gateway process (cron will revive it within 5 min) |

The cron trigger runs every 5 minutes, calling `ensureGateway` — which also mounts R2 if needed. So the gateway always comes back from a kill or container restart without manual intervention.

## Persistence

The Sandbox SDK's `sandbox.mountBucket()` mounts an R2 bucket as a FUSE filesystem inside the container. We mount `DATA_BUCKET` at `/opt/data` and set `HERMES_HOME=/opt/data` so Hermes treats the mount as its state directory. Every write Hermes makes — new sessions, memory updates, skill files, config edits — goes directly to R2 in real time. No snapshots, no manual flushes, no data-loss window.

The Hermes Python install itself stays on the local container filesystem at `/home/hermes/.hermes/hermes-agent` — that's ephemeral but rebuilt from the image on every cold start, and keeping Python imports off FUSE matters for startup latency (each import would otherwise be an R2 GET).

R2 is object storage with a FUSE shim. Per [Cloudflare's docs](https://developers.cloudflare.com/sandbox/guides/mount-buckets/): not POSIX-strict, no native-SSD performance, high-frequency writes to the same file may take a moment to propagate. Acceptable for an LLM agent's pace (single-digit writes per turn at most); something to revisit if Hermes' FTS5 session search misbehaves.

## Design notes

### Why `cloudflare/sandbox` base, not `nousresearch/hermes-agent`

The Sandbox SDK's `mountBucket` (and the rest of the lifecycle APIs) require the `cloudflare/sandbox` base image — it ships the FUSE machinery the mount system uses. We install Hermes on top of that base rather than starting from Nous's official image.

### Why the Worker starts Hermes, not a Dockerfile `CMD`

The Worker calls `sandbox.startProcess(...)` to launch `start-hermes.sh`, rather than relying on a Dockerfile `CMD`. That gives us stdout/stderr capture (surfaced via `/api/logs`) and explicit lifecycle control.

### Why process-list liveness, not port probe

Hermes' Slack adapter uses Socket Mode — no listening port inside the container. Liveness is "is there a `start-hermes.sh` process in `running`/`starting` status," checked via `sandbox.listProcesses()`.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

`wrangler dev` runs the Worker on localhost; container builds locally. Use [ngrok](https://ngrok.com/) if you need a public URL for any reason — note that Slack itself works fine without one thanks to Socket Mode.

## Known limitations

- **Slack channel messages require `@mention`.** Hermes' Slack adapter always requires an initial `@mention` in channels — there's no config flag to disable. Follow-up messages in the same thread don't need it. DMs work without mentions.
- **No automated tests.**
- **Token in query string** is leaky over time (CDN logs, referrer headers). For production, layer [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) on `/api/*`.

## Project layout

```
hermes-cloudflare/
├─ README.md
├─ LICENSE                  # Apache 2.0
├─ Dockerfile               # cloudflare/sandbox:0.7.20 + Hermes install
├─ start-hermes.sh          # container entrypoint
├─ slack-manifest.json      # reference; generate fresh via /api/slack-manifest
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ scripts/
│  └─ deploy.sh             # reads .env, applies --var, deploys
└─ src/
   ├─ index.ts              # Hono router, Worker entry, ensureGateway
   ├─ env.ts                # bindings type
   ├─ sandbox.ts            # exports HermesSandbox = SDK Sandbox class
   └─ persistence.ts        # createSnapshot / restoreIfNeeded
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
